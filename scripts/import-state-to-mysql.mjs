import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mysql from "mysql2/promise";
import { getControlRows, getTransferSummary, normalizeCompetitionState } from "./competition-state-transfer.mjs";

function parseArgs() {
  const args = new Map();
  const flags = new Set();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    if (["dry-run", "replace", "yes"].includes(key)) flags.add(key);
    else {
      args.set(key, argv[index + 1]);
      index += 1;
    }
  }
  return { args, flags };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mysqlId(identifier) {
  assert(/^[A-Za-z0-9_]+$/.test(identifier), `unsafe MySQL identifier: ${identifier}`);
  return `\`${identifier}\``;
}

function requireMysqlConfig() {
  if (process.env.CONTEST_DATABASE_URL) return;
  const missing = ["CONTEST_MYSQL_DATABASE", "CONTEST_MYSQL_USER"].filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing MySQL config: ${missing.join(", ")}. Set MySQL env vars before importing.`);
}

function createMysqlPool() {
  const options = process.env.CONTEST_DATABASE_URL
    ? { uri: process.env.CONTEST_DATABASE_URL }
    : {
        host: process.env.CONTEST_MYSQL_HOST || "127.0.0.1",
        port: Number(process.env.CONTEST_MYSQL_PORT || 3306),
        user: process.env.CONTEST_MYSQL_USER,
        password: process.env.CONTEST_MYSQL_PASSWORD || "",
        database: process.env.CONTEST_MYSQL_DATABASE,
      };
  return mysql.createPool({ ...options, waitForConnections: true, connectionLimit: 3, queueLimit: 0, charset: "utf8mb4", decimalNumbers: true });
}

function getTableNames(prefix) {
  return {
    teams: `${prefix}teams`,
    accounts: `${prefix}accounts`,
    sessions: `${prefix}account_sessions`,
    roster: `${prefix}judge_roster`,
    entries: `${prefix}entries`,
    controls: `${prefix}control_state`,
  };
}

function getRequiredJudgeIds(state) {
  return new Set([
    ...state.judgeRoster.judgeIds,
    ...state.entries.map((entry) => entry.judgeId),
    ...state.teams.flatMap((team) => team.judgeRosterSnapshot),
    ...state.activeAssignment.rosterSnapshot,
    ...Object.values(state.competitionSetup.groups).flatMap((group) => group.judgeIds),
  ]);
}

async function assertInitializedTarget(connection, tables, requiredJudgeIds) {
  let accountRows;
  try {
    [accountRows] = await connection.query(`SELECT account_id FROM ${mysqlId(tables.accounts)}`);
    await connection.query(`SELECT 1 FROM ${mysqlId(tables.sessions)} LIMIT 1`);
    await connection.query(`SELECT 1 FROM ${mysqlId(tables.teams)} LIMIT 1`);
    await connection.query(`SELECT 1 FROM ${mysqlId(tables.roster)} LIMIT 1`);
    await connection.query(`SELECT 1 FROM ${mysqlId(tables.entries)} LIMIT 1`);
    await connection.query(`SELECT 1 FROM ${mysqlId(tables.controls)} LIMIT 1`);
  } catch (error) {
    if (error?.code === "ER_NO_SUCH_TABLE") {
      throw new Error("Target schema has not been initialized. Start the MySQL server once so it creates secure accounts and tables, then stop it before importing.");
    }
    throw error;
  }
  const existingIds = new Set(accountRows.map((row) => row.account_id));
  return existingIds;
}

async function ensureRegistrationNumberColumn(connection, teamsTable) {
  const [rows] = await connection.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = 'registration_number'
      LIMIT 1
    `,
    [teamsTable],
  );
  if (rows.length) return;
  await connection.query(`ALTER TABLE ${mysqlId(teamsTable)} ADD COLUMN ${mysqlId("registration_number")} VARCHAR(64) NOT NULL DEFAULT '' AFTER ${mysqlId("group_id")}`);
}

function serializeTeam(team) {
  return [
    team.id,
    team.groupId,
    team.registrationNumber,
    team.teamName,
    team.projectName,
    team.appearanceOrder,
    team.status,
    team.revision,
    JSON.stringify(team.judgeRosterSnapshot),
    team.createdAt,
    team.updatedAt,
  ];
}

function serializeEntry(entry) {
  return [
    entry.judgeId,
    entry.teamId,
    JSON.stringify(entry.scores),
    entry.submitted ? 1 : 0,
    entry.updatedAt,
    entry.clientUpdatedAt,
    entry.serverRevision,
    entry.serverUpdatedAt,
  ];
}

function serializeAccount(account) {
  return [
    account.id,
    account.username,
    account.displayName,
    account.role,
    account.status,
    account.passwordHash,
    account.passwordVersion,
    account.authVersion,
    account.revision,
    account.createdAt,
    account.updatedAt,
  ];
}

async function importState(pool, tables, state) {
  const connection = await pool.getConnection();
  try {
    await assertInitializedTarget(connection, tables, getRequiredJudgeIds(state));
    const sourceAccountIds = new Set(state.accounts.map((account) => account.id));
    const missing = [...getRequiredJudgeIds(state)].filter((id) => !sourceAccountIds.has(id));
    assert(!missing.length, `Source backup is missing judge accounts required by the competition state: ${missing.join(", ")}`);
    assert(state.accounts.some((account) => account.role === "admin" && account.status === "active"), "Source backup must contain an active administrator account");
    assert(state.accounts.every((account) => account.passwordHash), "Source contains accounts without password hashes; use a complete v4 state backup");
    await ensureRegistrationNumberColumn(connection, tables.teams);
    await connection.beginTransaction();
    await connection.query(`DELETE FROM ${mysqlId(tables.sessions)}`);
    await connection.query(`DELETE FROM ${mysqlId(tables.entries)}`);
    await connection.query(`DELETE FROM ${mysqlId(tables.roster)}`);
    await connection.query(
      `DELETE FROM ${mysqlId(tables.accounts)} WHERE account_id NOT IN (?)`,
      [[...sourceAccountIds]],
    );
    for (const account of state.accounts) {
      await connection.query(
        `
          INSERT INTO ${mysqlId(tables.accounts)}
            (account_id, username, display_name, role, status, password_hash, password_version, auth_version, revision, state_created_at, state_updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            username = VALUES(username), display_name = VALUES(display_name), role = VALUES(role), status = VALUES(status),
            password_hash = VALUES(password_hash), password_version = VALUES(password_version), auth_version = VALUES(auth_version),
            revision = VALUES(revision), state_updated_at = VALUES(state_updated_at)
        `,
        serializeAccount(account),
      );
    }
    // This command is an explicit competition-state replacement. Remove prior
    // team-scoped data so deleted source teams cannot remain silently active.
    await connection.query(`DELETE FROM ${mysqlId(tables.teams)}`);
    for (const team of state.teams) {
      await connection.query(
        `
          INSERT INTO ${mysqlId(tables.teams)}
            (team_id, group_id, registration_number, team_name, project_name, appearance_order, status, revision, roster_snapshot, state_created_at, state_updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            group_id = VALUES(group_id), registration_number = VALUES(registration_number), team_name = VALUES(team_name), project_name = VALUES(project_name),
            appearance_order = VALUES(appearance_order), status = VALUES(status), revision = VALUES(revision),
            roster_snapshot = VALUES(roster_snapshot), state_updated_at = VALUES(state_updated_at)
        `,
        serializeTeam(team),
      );
    }
    if (state.entries.length) {
      await connection.query(
        `
          INSERT INTO ${mysqlId(tables.entries)}
            (judge_id, candidate_id, scores_json, submitted, updated_at, client_updated_at, server_revision, server_updated_at)
          VALUES ?
        `,
        [state.entries.map(serializeEntry)],
      );
    }
    if (state.judgeRoster.judgeIds.length) {
      await connection.query(
        `INSERT INTO ${mysqlId(tables.roster)} (account_id, sort_order) VALUES ?`,
        [state.judgeRoster.judgeIds.map((accountId, index) => [accountId, index + 1])],
      );
    }
    await connection.query(`DELETE FROM ${mysqlId(tables.controls)}`);
    for (const [key, value, revision, updatedAt] of getControlRows(state)) {
      await connection.query(
        `
          INSERT INTO ${mysqlId(tables.controls)} (control_key, control_value, revision, updated_at)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE control_value = VALUES(control_value), revision = VALUES(revision), updated_at = VALUES(updated_at)
        `,
        [key, JSON.stringify(value), revision, updatedAt],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function readTargetSummary(pool, tables, teamIds) {
  const [[teamCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(tables.teams)} WHERE team_id IN (?)`, [teamIds]);
  const [[entryCount]] = await pool.query(
    `SELECT COUNT(*) AS entries, SUM(CASE WHEN submitted = 1 THEN 1 ELSE 0 END) AS submitted, SUM(CASE WHEN server_revision > 0 THEN 1 ELSE 0 END) AS revised FROM ${mysqlId(tables.entries)} WHERE candidate_id IN (?)`,
    [teamIds],
  );
  const [[rosterCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(tables.roster)}`);
  const [[accountCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(tables.accounts)}`);
  const [controlRows] = await pool.query(`SELECT control_key FROM ${mysqlId(tables.controls)} WHERE control_key IN (?, ?, ?, ?, ?, ?, ?, ?)`, [
    "judge_roster",
    "competition_setup",
    "active_assignment",
    "display_selection",
    "team_order:gaozhi",
    "team_order:zhongzhi",
    "team_order:benke",
    "team_order:shehui",
  ]);
  return {
    teams: Number(teamCount.count),
    entries: Number(entryCount.entries),
    submitted: Number(entryCount.submitted ?? 0),
    revised: Number(entryCount.revised ?? 0),
    rosterCount: Number(rosterCount.count),
    accounts: Number(accountCount.count),
    controls: controlRows.length,
  };
}

async function main() {
  const { args, flags } = parseArgs();
  const statePath = resolve(args.get("state") || "data/contest-state.json");
  const tablePrefix = args.get("prefix") || process.env.CONTEST_MYSQL_TABLE_PREFIX || "contest_final_";
  assert(/^[A-Za-z0-9_]+$/.test(tablePrefix), "table prefix may only contain letters, numbers, and underscores");
  const raw = JSON.parse(await readFile(statePath, "utf8"));
  const state = normalizeCompetitionState(raw);
  const summary = getTransferSummary(state);
  const tables = getTableNames(tablePrefix);

  console.log(`source: ${statePath}`);
  console.log(`target tables: ${Object.values(tables).join(", ")}`);
  console.log(`source summary: ${JSON.stringify(summary)}`);
  if (flags.has("dry-run")) return;
  assert(flags.has("replace") && flags.has("yes"), "Refusing to import. Re-run with --replace --yes after confirming the target competition state can be overwritten.");
  requireMysqlConfig();

  const pool = createMysqlPool();
  try {
    await importState(pool, tables, state);
    const target = await readTargetSummary(pool, tables, state.teams.map((team) => team.id));
    console.log(`imported summary: ${JSON.stringify(target)}`);
    assert(target.teams === summary.teams, "imported team count does not match source");
    assert(target.entries === summary.entries, "imported entry count does not match source");
    assert(target.submitted === summary.submitted, "imported submitted count does not match source");
    assert(target.revised === summary.revised, "imported revised count does not match source");
    assert(target.rosterCount === summary.rosterCount, "imported roster count does not match source");
    assert(target.accounts === summary.accounts, "imported account count does not match source");
    assert(target.controls === 7, "imported control records are incomplete");
  } finally {
    await pool.end();
  }
}

await main();
