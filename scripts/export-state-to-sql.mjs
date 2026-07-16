import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getControlRows, getTransferSummary, normalizeCompetitionState } from "./competition-state-transfer.mjs";

function parseArgs() {
  const args = new Map();
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) continue;
    args.set(value.slice(2), argv[index + 1]);
    index += 1;
  }
  return args;
}

function assertSafeIdentifier(value, label) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`${label} may only contain letters, numbers, and underscores`);
}

function mysqlId(identifier) {
  assertSafeIdentifier(identifier, "MySQL identifier");
  return `\`${identifier}\``;
}

function sqlString(value) {
  const text = String(value ?? "");
  return `'${text
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\0", "\\0")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\u001a", "\\Z")}'`;
}

function sqlValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : sqlString(value);
}

function createUpsertSql(table, columns, rows, updateColumns) {
  if (!rows.length) return "";
  const values = rows.map((row) => `(${row.map(sqlValue).join(", ")})`).join(",\n");
  const updates = updateColumns.map((column) => `${mysqlId(column)} = VALUES(${mysqlId(column)})`).join(", ");
  return `INSERT INTO ${mysqlId(table)} (${columns.map(mysqlId).join(", ")}) VALUES\n${values}\nON DUPLICATE KEY UPDATE ${updates};`;
}

function createInsertSql(table, columns, rows) {
  if (!rows.length) return "";
  const values = rows.map((row) => `(${row.map(sqlValue).join(", ")})`).join(",\n");
  return `INSERT INTO ${mysqlId(table)} (${columns.map(mysqlId).join(", ")}) VALUES\n${values};`;
}

function createSqlDump({ databaseName, tablePrefix, state }) {
  const tables = {
    teams: `${tablePrefix}teams`,
    accounts: `${tablePrefix}accounts`,
    sessions: `${tablePrefix}account_sessions`,
    roster: `${tablePrefix}judge_roster`,
    entries: `${tablePrefix}entries`,
    controls: `${tablePrefix}control_state`,
  };
  const accountRows = state.accounts.map((account) => [
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
  ]);
  const teamRows = state.teams.map((team) => [
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
  ]);
  const entryRows = state.entries.map((entry) => [
    entry.judgeId,
    entry.teamId,
    JSON.stringify(entry.scores),
    entry.submitted ? 1 : 0,
    entry.updatedAt,
    entry.clientUpdatedAt,
    entry.serverRevision,
    entry.serverUpdatedAt,
  ]);
  const rosterRows = state.judgeRoster.judgeIds.map((accountId, index) => [accountId, index + 1]);
  const controlRows = getControlRows(state).map(([key, value, revision, updatedAt]) => [key, JSON.stringify(value), revision, updatedAt]);
  const teamIds = state.teams.map((team) => sqlString(team.id)).join(", ");
  const accountIds = state.accounts.map((account) => sqlString(account.id)).join(", ");
  const summary = getTransferSummary(state);
  const sourceAccountIds = new Set(state.accounts.map((account) => account.id));
  const requiredJudgeIds = new Set([
    ...state.judgeRoster.judgeIds,
    ...state.entries.map((entry) => entry.judgeId),
    ...state.teams.flatMap((team) => team.judgeRosterSnapshot),
    ...state.activeAssignment.rosterSnapshot,
    ...Object.values(state.competitionSetup.groups).flatMap((group) => group.judgeIds),
  ]);
  const missingJudgeIds = [...requiredJudgeIds].filter((id) => !sourceAccountIds.has(id));
  if (!state.accounts.some((account) => account.role === "admin" && account.status === "active")) {
    throw new Error("Full restore export requires an active administrator account");
  }
  if (state.accounts.some((account) => !account.passwordHash)) {
    throw new Error("Full restore export requires password hashes for every account");
  }
  if (missingJudgeIds.length) {
    throw new Error(`Full restore export is missing referenced judge accounts: ${missingJudgeIds.join(", ")}`);
  }

  return `-- Full competition disaster-recovery transfer generated from a v4 contest-state.json file.
-- SENSITIVE: contains application account password hashes. It intentionally excludes active sessions.
-- Accounts: ${summary.accounts}; dynamic judges: ${summary.dynamicJudges}; teams: ${summary.teams}; entries: ${summary.entries}; submitted: ${summary.submitted}; roster: ${summary.rosterCount}.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
CREATE DATABASE IF NOT EXISTS ${mysqlId(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ${mysqlId(databaseName)};

SET @registration_column_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = ${sqlString(tables.teams)}
    AND column_name = 'registration_number'
);
SET @registration_column_sql := IF(
  @registration_column_exists = 0,
  'ALTER TABLE ${tables.teams.replaceAll("`", "``")} ADD COLUMN registration_number VARCHAR(64) NOT NULL DEFAULT '''' AFTER group_id',
  'SELECT 1'
);
PREPARE registration_column_stmt FROM @registration_column_sql;
EXECUTE registration_column_stmt;
DEALLOCATE PREPARE registration_column_stmt;

START TRANSACTION;

-- Remove dependent rows first, then restore the exact backed-up account set.
-- All sessions are revoked so restored credentials require a fresh login.
DELETE FROM ${mysqlId(tables.sessions)};
DELETE FROM ${mysqlId(tables.entries)};
DELETE FROM ${mysqlId(tables.roster)};
DELETE FROM ${mysqlId(tables.accounts)} WHERE account_id NOT IN (${accountIds});
DELETE FROM ${mysqlId(tables.teams)};
DELETE FROM ${mysqlId(tables.controls)};

${createUpsertSql(
  tables.accounts,
  ["account_id", "username", "display_name", "role", "status", "password_hash", "password_version", "auth_version", "revision", "state_created_at", "state_updated_at"],
  accountRows,
  ["username", "display_name", "role", "status", "password_hash", "password_version", "auth_version", "revision", "state_updated_at"],
)}

${createUpsertSql(
  tables.teams,
  ["team_id", "group_id", "registration_number", "team_name", "project_name", "appearance_order", "status", "revision", "roster_snapshot", "state_created_at", "state_updated_at"],
  teamRows,
  ["group_id", "registration_number", "team_name", "project_name", "appearance_order", "status", "revision", "roster_snapshot", "state_updated_at"],
)}

${createInsertSql(
  tables.entries,
  ["judge_id", "candidate_id", "scores_json", "submitted", "updated_at", "client_updated_at", "server_revision", "server_updated_at"],
  entryRows,
)}

${createInsertSql(tables.roster, ["account_id", "sort_order"], rosterRows)}

${createUpsertSql(tables.controls, ["control_key", "control_value", "revision", "updated_at"], controlRows, ["control_value", "revision", "updated_at"])}

COMMIT;

SELECT COUNT(*) AS imported_teams FROM ${mysqlId(tables.teams)} WHERE team_id IN (${teamIds});
SELECT COUNT(*) AS imported_accounts FROM ${mysqlId(tables.accounts)};
SELECT COUNT(*) AS imported_entries FROM ${mysqlId(tables.entries)} WHERE candidate_id IN (${teamIds});
SELECT COUNT(*) AS imported_roster FROM ${mysqlId(tables.roster)};
`;
}

async function main() {
  const args = parseArgs();
  const statePath = resolve(args.get("state") || "data/contest-state.json");
  const outputPath = resolve(args.get("out") || "database-export/campus-final-scoring-state.sql");
  const databaseName = args.get("database") || process.env.CONTEST_MYSQL_DATABASE || "campus_final_scoring";
  const tablePrefix = args.get("prefix") || process.env.CONTEST_MYSQL_TABLE_PREFIX || "contest_final_";
  assertSafeIdentifier(databaseName, "database name");
  assertSafeIdentifier(tablePrefix, "table prefix");

  const raw = JSON.parse(await readFile(statePath, "utf8"));
  const state = normalizeCompetitionState(raw);
  const sql = createSqlDump({ databaseName, tablePrefix, state });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, sql);
  console.log(JSON.stringify({ outputPath, databaseName, tablePrefix, ...getTransferSummary(state) }, null, 2));
}

await main();
