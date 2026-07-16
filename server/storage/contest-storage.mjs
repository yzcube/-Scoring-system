import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { withMysqlConsistentSnapshot } from "../mysql-transaction.mjs";
import { createContestPersistencePlan } from "./contest-mutation-contract.mjs";

export function parseRequiredMysqlJson(value, label) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`MySQL 必需控制状态 ${label} 缺失`);
  }
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`MySQL 必需控制状态 ${label} 不是合法 JSON`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MySQL 必需控制状态 ${label} 必须是 JSON 对象`);
  }
  return parsed;
}

export function parseRequiredMysqlControl(value, key, expectedGroupIds = []) {
  const control = parseRequiredMysqlJson(value, key);
  const isRevision = (revision) => Number.isSafeInteger(revision) && revision >= 0;
  const isNullableId = (id) => id === null || typeof id === "string";
  let valid = false;
  if (key === "active_assignment") {
    valid =
      isNullableId(control.groupId) &&
      isNullableId(control.teamId) &&
      ["idle", "scoring", "awaiting_submissions", "final", "closed"].includes(control.status) &&
      isRevision(control.assignmentRevision) &&
      Array.isArray(control.rosterSnapshot);
  } else if (key === "display_selection") {
    valid =
      isNullableId(control.teamId) &&
      ["idle", "temporary", "final", "review_required"].includes(control.publicationStatus) &&
      isRevision(control.displayRevision);
  } else if (key === "judge_roster") {
    valid = Array.isArray(control.judgeIds) && isRevision(control.revision);
  } else if (key === "competition_setup") {
    const groupEntries = control.groups && typeof control.groups === "object" && !Array.isArray(control.groups)
      ? Object.entries(control.groups)
      : [];
    const expectedGroupsMatch = expectedGroupIds.length
      ? groupEntries.length === expectedGroupIds.length && expectedGroupIds.every((groupId) => control.groups[groupId])
      : groupEntries.length > 0;
    const groupsValid = expectedGroupsMatch && groupEntries.every(([groupId, group]) =>
      group?.groupId === groupId &&
      ["draft", "open", "closed"].includes(group.status) &&
      Array.isArray(group.teamIds) &&
      new Set(group.teamIds).size === group.teamIds.length &&
      Array.isArray(group.judgeIds) &&
      new Set(group.judgeIds).size === group.judgeIds.length &&
      isRevision(group.revision),
    );
    const openGroupIds = groupEntries
      .filter(([, group]) => group?.status === "open")
      .map(([groupId]) => groupId);
    const activeGroupConsistent =
      openGroupIds.length <= 1 &&
      (openGroupIds.length === 0
        ? control.activeGroupId === null
        : control.activeGroupId === openGroupIds[0]);
    valid =
      isNullableId(control.activeGroupId) &&
      isRevision(control.revision) &&
      groupsValid &&
      activeGroupConsistent;
  }
  if (!valid) throw new Error(`MySQL 必需控制状态 ${key} 结构不完整`);
  return control;
}

export function createContestStorage({
  mode,
  file,
  mysql,
  stateCodec,
  entityLookup,
  groups,
}) {
  const { dataDir, stateFile } = file;
  const { driver, tablePrefix, config: mysqlConfig } = mysql;
  const {
    createInitialState,
    migrateLegacyState,
    ensureAccountHashes,
    sanitizeState,
    createEmptyState,
    normalizeJudgeId,
    applyLegacyTeamOverrides,
    applyLegacyTeamOrder,
    sanitizeGroupId,
    clampInteger,
    getTeamOrderControlKey,
    legacyJudgeIdMap,
  } = stateCodec;
  const { getTeamById, getAccountById, getEntry } = entityLookup;
  const mysqlTeamsTable = `${tablePrefix}teams`;
  const mysqlAccountsTable = `${tablePrefix}accounts`;
  const mysqlSessionsTable = `${tablePrefix}account_sessions`;
  const mysqlRosterTable = `${tablePrefix}judge_roster`;
  const mysqlEntriesTable = `${tablePrefix}entries`;
  const mysqlControlStateTable = `${tablePrefix}control_state`;
  const mysqlAuditEventsTable = `${tablePrefix}audit_events`;
  const mysqlLegacyOverridesTable = `${tablePrefix}candidate_overrides`;
  const mysqlLegacyOrderTable = `${tablePrefix}candidate_order`;
  const activeAssignmentControlKey = "active_assignment";
  const displaySelectionControlKey = "display_selection";
  const judgeRosterControlKey = "judge_roster";
  const competitionSetupControlKey = "competition_setup";
  const legacyActiveGroupControlKey = "active_group";
  let mysqlPool = null;
  let mysqlStorageReady = false;

  async function loadFileStateWithMigration() {
    if (!existsSync(stateFile))
      return { state: await createInitialState(), changed: true };
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    const requiresMigration =
      Number(raw?.version) < 4 ||
      !Array.isArray(raw?.teams) ||
      !Array.isArray(raw?.accounts);
    const state = requiresMigration
      ? await migrateLegacyState(raw)
      : sanitizeState(raw);
    const changed = requiresMigration || (await ensureAccountHashes(state));
    return { state, changed };
  }

  async function writeFileState(state) {
    await mkdir(dataDir, { recursive: true });
    const tempFile = `${stateFile}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tempFile, stateFile);
  }

  async function initializeFileStorage() {
    const { state, changed } = await loadFileStateWithMigration();
    if (changed) await writeFileState(state);
  }

  function assertSupportedStorageMode() {
    if (["file", "mysql"].includes(mode)) return;
    throw new Error(`Unsupported CONTEST_STORAGE value: ${mode}`);
  }

  function assertSafeMysqlIdentifier(value, label) {
    if (/^[A-Za-z0-9_]+$/.test(value)) return;
    throw new Error(
      `${label} may only contain letters, numbers, and underscores`,
    );
  }

  function mysqlId(identifier) {
    assertSafeMysqlIdentifier(identifier, "MySQL identifier");
    return `\`${identifier}\``;
  }

  function createMysqlPool() {
    if (mysqlPool) return mysqlPool;
    mysqlPool = driver.createPool(mysqlConfig);
    return mysqlPool;
  }

  function parseMysqlJson(value, fallback = {}) {
    if (!value) return fallback;
    if (Buffer.isBuffer(value)) value = value.toString("utf8");
    if (typeof value === "object") return value;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function serializeMysqlTeam(team) {
    return [
      team.id,
      team.groupId,
      team.registrationNumber,
      team.teamName,
      team.projectName,
      team.appearanceOrder,
      team.status,
      team.revision,
      JSON.stringify(team.judgeRosterSnapshot ?? []),
      team.createdAt,
      team.updatedAt,
    ];
  }

  function serializeMysqlAccount(account) {
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

  async function ensureMysqlForeignKey(
    connection,
    table,
    constraintName,
    column,
    referenceTable,
    referenceColumn,
  ) {
    const [rows] = await connection.query(
      `
      SELECT constraint_name
      FROM information_schema.key_column_usage
      WHERE constraint_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?
        AND referenced_table_name = ?
      LIMIT 1
    `,
      [table, column, referenceTable],
    );
    if (rows.length) return;
    await connection.query(
      `ALTER TABLE ${mysqlId(table)}
       ADD CONSTRAINT ${mysqlId(constraintName)}
       FOREIGN KEY (${mysqlId(column)}) REFERENCES ${mysqlId(referenceTable)} (${mysqlId(referenceColumn)})`,
    );
  }

  async function ensureMysqlColumn(connection, table, column, definition) {
    const [rows] = await connection.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = ?
        AND column_name = ?
      LIMIT 1
    `,
      [table, column],
    );
    if (rows.length) return;
    await connection.query(
      `ALTER TABLE ${mysqlId(table)} ADD COLUMN ${mysqlId(column)} ${definition}`,
    );
  }

  async function ensureMysqlTables(connection) {
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlTeamsTable)} (
      team_id VARCHAR(16) NOT NULL,
      group_id VARCHAR(32) NOT NULL,
      registration_number VARCHAR(64) NOT NULL DEFAULT '',
      team_name VARCHAR(255) NOT NULL,
      project_name VARCHAR(255) NOT NULL DEFAULT '',
      appearance_order INT UNSIGNED NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      revision INT UNSIGNED NOT NULL DEFAULT 0,
      roster_snapshot JSON NULL,
      state_created_at VARCHAR(64) NOT NULL DEFAULT '',
      state_updated_at VARCHAR(64) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id),
      INDEX idx_group_appearance (group_id, appearance_order),
      INDEX idx_team_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await ensureMysqlColumn(
      connection,
      mysqlTeamsTable,
      "registration_number",
      "VARCHAR(64) NOT NULL DEFAULT '' AFTER group_id",
    );
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlAccountsTable)} (
      account_id VARCHAR(32) NOT NULL,
      username VARCHAR(64) NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      password_hash VARCHAR(1024) NOT NULL,
      password_version INT UNSIGNED NOT NULL DEFAULT 1,
      auth_version INT UNSIGNED NOT NULL DEFAULT 1,
      revision INT UNSIGNED NOT NULL DEFAULT 1,
      state_created_at VARCHAR(64) NOT NULL DEFAULT '',
      state_updated_at VARCHAR(64) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id),
      UNIQUE KEY uq_username (username),
      INDEX idx_account_role_status (role, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlSessionsTable)} (
      session_id CHAR(32) NOT NULL,
      account_id VARCHAR(32) NOT NULL,
      token_hash BINARY(32) NOT NULL,
      auth_version INT UNSIGNED NOT NULL,
      expires_at BIGINT UNSIGNED NOT NULL,
      device_id VARCHAR(80) NOT NULL DEFAULT '',
      revoked_at BIGINT UNSIGNED NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (session_id),
      UNIQUE KEY uq_session_token_hash (token_hash),
      INDEX idx_session_account_expiry (account_id, expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlRosterTable ? mysqlId(mysqlRosterTable) : ""} (
      account_id VARCHAR(32) NOT NULL,
      sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (account_id),
      UNIQUE KEY uq_roster_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlEntriesTable)} (
      judge_id VARCHAR(32) NOT NULL,
      candidate_id VARCHAR(16) NOT NULL,
      scores_json JSON NOT NULL,
      submitted TINYINT(1) NOT NULL DEFAULT 0,
      updated_at VARCHAR(64) NOT NULL DEFAULT '',
      client_updated_at BIGINT NOT NULL DEFAULT 0,
      server_revision INT UNSIGNED NOT NULL DEFAULT 0,
      server_updated_at VARCHAR(64) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (judge_id, candidate_id),
      INDEX idx_candidate_submitted (candidate_id, submitted),
      INDEX idx_judge (judge_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlControlStateTable)} (
      control_key VARCHAR(64) NOT NULL,
      control_value MEDIUMTEXT NOT NULL,
      revision INT UNSIGNED NOT NULL DEFAULT 0,
      updated_at VARCHAR(64) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      modified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (control_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await connection.query(
      `ALTER TABLE ${mysqlId(mysqlControlStateTable)} MODIFY control_value MEDIUMTEXT NOT NULL`,
    );
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlAuditEventsTable)} (
      event_id VARCHAR(80) NOT NULL,
      action VARCHAR(64) NOT NULL,
      actor_id VARCHAR(32) NOT NULL DEFAULT '',
      target_id VARCHAR(32) NOT NULL DEFAULT '',
      details_json JSON NOT NULL,
      event_created_at VARCHAR(64) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id),
      INDEX idx_audit_action_created (action, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlLegacyOverridesTable)} (
      candidate_id VARCHAR(16) NOT NULL,
      team VARCHAR(255) NOT NULL DEFAULT '',
      product VARCHAR(255) NOT NULL DEFAULT '',
      PRIMARY KEY (candidate_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
    await connection.query(`
    CREATE TABLE IF NOT EXISTS ${mysqlId(mysqlLegacyOrderTable)} (
      group_id VARCHAR(32) NOT NULL,
      candidate_id VARCHAR(16) NOT NULL,
      sort_order INT UNSIGNED NOT NULL DEFAULT 0,
      revision INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (group_id, candidate_id),
      INDEX idx_group_order (group_id, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  }

  async function upsertMysqlTeam(connection, team) {
    await connection.query(
      `
      INSERT INTO ${mysqlId(mysqlTeamsTable)}
        (team_id, group_id, registration_number, team_name, project_name, appearance_order, status, revision, roster_snapshot, state_created_at, state_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        group_id = VALUES(group_id), registration_number = VALUES(registration_number), team_name = VALUES(team_name), project_name = VALUES(project_name),
        appearance_order = VALUES(appearance_order), status = VALUES(status), revision = VALUES(revision),
        roster_snapshot = VALUES(roster_snapshot), state_updated_at = VALUES(state_updated_at)
    `,
      serializeMysqlTeam(team),
    );
  }

  async function upsertMysqlAccount(connection, account) {
    await connection.query(
      `
      INSERT INTO ${mysqlId(mysqlAccountsTable)}
        (account_id, username, display_name, role, status, password_hash, password_version, auth_version, revision, state_created_at, state_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        username = VALUES(username), display_name = VALUES(display_name), role = VALUES(role), status = VALUES(status),
        password_hash = VALUES(password_hash), password_version = VALUES(password_version), auth_version = VALUES(auth_version),
        revision = VALUES(revision), state_updated_at = VALUES(state_updated_at)
    `,
      serializeMysqlAccount(account),
    );
  }

  async function upsertMysqlControl(
    connection,
    key,
    value,
    revision,
    updatedAt,
  ) {
    await connection.query(
      `
      INSERT INTO ${mysqlId(mysqlControlStateTable)} (control_key, control_value, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE control_value = VALUES(control_value), revision = VALUES(revision), updated_at = VALUES(updated_at)
    `,
      [key, JSON.stringify(value), revision, updatedAt],
    );
  }

  async function seedMysqlStorage(connection) {
    const [[teamCountRow]] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${mysqlId(mysqlTeamsTable)}`,
    );
    const [[accountCountRow]] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${mysqlId(mysqlAccountsTable)}`,
    );
    const [[rosterCountRow]] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${mysqlId(mysqlRosterTable)}`,
    );
    const [[rosterControlCountRow]] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${mysqlId(mysqlControlStateTable)} WHERE control_key = ?`,
      [judgeRosterControlKey],
    );
    const [[assignmentCountRow]] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${mysqlId(mysqlControlStateTable)} WHERE control_key = ?`,
      [activeAssignmentControlKey],
    );
    const [[displayCountRow]] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${mysqlId(mysqlControlStateTable)} WHERE control_key = ?`,
      [displaySelectionControlKey],
    );
    const [[competitionSetupCountRow]] = await connection.query(
      `SELECT COUNT(*) AS count FROM ${mysqlId(mysqlControlStateTable)} WHERE control_key = ?`,
      [competitionSetupControlKey],
    );

    let initialState = null;
    if (!Number(teamCountRow.count) || !Number(accountCountRow.count)) {
      initialState = await createInitialState();
    }

    if (!Number(teamCountRow.count)) {
      const [overrideRows] = await connection.query(
        `SELECT candidate_id, team, product FROM ${mysqlId(mysqlLegacyOverridesTable)}`,
      );
      const [orderRows] = await connection.query(
        `SELECT group_id, candidate_id, sort_order FROM ${mysqlId(mysqlLegacyOrderTable)} ORDER BY group_id, sort_order`,
      );
      const overrides = Object.fromEntries(
        overrideRows.map((row) => [
          row.candidate_id,
          { team: row.team, product: row.product },
        ]),
      );
      const orderByGroup = orderRows.reduce((result, row) => {
        result[row.group_id] = result[row.group_id] ?? [];
        result[row.group_id].push(row.candidate_id);
        return result;
      }, {});
      initialState.teams = applyLegacyTeamOrder(
        applyLegacyTeamOverrides(initialState.teams, overrides),
        orderByGroup,
      );
      for (const team of initialState.teams)
        await upsertMysqlTeam(connection, team);
    }

    if (!Number(accountCountRow.count)) {
      for (const account of initialState.accounts)
        await upsertMysqlAccount(connection, account);
    }

    if (!Number(rosterCountRow.count)) {
      const [activeJudgeRows] = await connection.query(
        `SELECT account_id FROM ${mysqlId(mysqlAccountsTable)} WHERE role = 'judge' AND status = 'active' ORDER BY created_at, account_id`,
      );
      const rosterIds = activeJudgeRows.map((row) => row.account_id);
      if (rosterIds.length) {
        await connection.query(
          `INSERT INTO ${mysqlId(mysqlRosterTable)} (account_id, sort_order) VALUES ?`,
          [rosterIds.map((accountId, index) => [accountId, index + 1])],
        );
      }
    }

    if (!Number(assignmentCountRow.count)) {
      const [legacyRows] = await connection.query(
        `SELECT control_value, revision, updated_at FROM ${mysqlId(mysqlControlStateTable)} WHERE control_key = ?`,
        [legacyActiveGroupControlKey],
      );
      const legacy = legacyRows[0];
      const assignment = {
        groupId: sanitizeGroupId(legacy?.control_value),
        teamId: null,
        status: "idle",
        assignmentRevision: clampInteger(legacy?.revision),
        rosterRevision: 0,
        rosterSnapshot: [],
        updatedAt: legacy?.updated_at || "",
        forcedReason: "",
      };
      await upsertMysqlControl(
        connection,
        activeAssignmentControlKey,
        assignment,
        assignment.assignmentRevision,
        assignment.updatedAt,
      );
    }
    if (!Number(displayCountRow.count)) {
      const display = {
        teamId: null,
        publicationStatus: "idle",
        displayRevision: 0,
        publishedAt: "",
        updatedAt: "",
      };
      await upsertMysqlControl(
        connection,
        displaySelectionControlKey,
        display,
        0,
        "",
      );
    }
    if (!Number(rosterControlCountRow.count)) {
      const [rosterRows] = await connection.query(
        `SELECT account_id FROM ${mysqlId(mysqlRosterTable)} ORDER BY sort_order, account_id`,
      );
      const [assignmentRows] = await connection.query(
        `SELECT control_value FROM ${mysqlId(mysqlControlStateTable)} WHERE control_key = ?`,
        [activeAssignmentControlKey],
      );
      const assignment = parseRequiredMysqlControl(
        assignmentRows[0]?.control_value,
        activeAssignmentControlKey,
      );
      const roster = {
        ...createEmptyState().judgeRoster,
        judgeIds: rosterRows.map((row) => row.account_id),
        lockedAt: assignment.teamId
          ? assignment.updatedAt || new Date().toISOString()
          : "",
      };
      await upsertMysqlControl(
        connection,
        judgeRosterControlKey,
        roster,
        roster.revision,
        roster.updatedAt,
      );
    }
    if (!Number(competitionSetupCountRow.count)) {
      const stateForSetup = await readMysqlStateWithoutInitialization(connection, {
        allowMissingCompetitionSetup: true,
      });
      await upsertMysqlControl(
        connection,
        competitionSetupControlKey,
        stateForSetup.competitionSetup,
        stateForSetup.competitionSetup.revision,
        new Date().toISOString(),
      );
    }
  }

  async function migrateMysqlLegacyJudgeIds(connection) {
    for (const [legacyJudgeId, judgeId] of Object.entries(legacyJudgeIdMap)) {
      const [conflicts] = await connection.query(
        `
        SELECT legacy_entry.candidate_id
        FROM ${mysqlId(mysqlEntriesTable)} AS legacy_entry
        INNER JOIN ${mysqlId(mysqlEntriesTable)} AS current_entry
          ON current_entry.candidate_id = legacy_entry.candidate_id
         AND current_entry.judge_id = ?
        WHERE legacy_entry.judge_id = ?
        LIMIT 1
      `,
        [judgeId, legacyJudgeId],
      );
      if (conflicts.length) {
        throw new Error(
          `历史评委 ${legacyJudgeId} 与 ${judgeId} 在同一队伍已有重复评分，请先人工核对后再迁移`,
        );
      }
      await connection.query(
        `UPDATE ${mysqlId(mysqlEntriesTable)} SET judge_id = ? WHERE judge_id = ?`,
        [judgeId, legacyJudgeId],
      );
    }
  }

  async function initializeMysqlStorage() {
    if (mysqlStorageReady) return;
    assertSafeMysqlIdentifier(tablePrefix, "CONTEST_MYSQL_TABLE_PREFIX");
    const pool = createMysqlPool();
    const connection = await pool.getConnection();
    try {
      await ensureMysqlTables(connection);
      await connection.beginTransaction();
      await seedMysqlStorage(connection);
      await migrateMysqlLegacyJudgeIds(connection);
      await connection.commit();
      await ensureMysqlForeignKey(
        connection,
        mysqlEntriesTable,
        `${tablePrefix}entries_judge_fk`,
        "judge_id",
        mysqlAccountsTable,
        "account_id",
      );
      await ensureMysqlForeignKey(
        connection,
        mysqlEntriesTable,
        `${tablePrefix}entries_team_fk`,
        "candidate_id",
        mysqlTeamsTable,
        "team_id",
      );
      await ensureMysqlForeignKey(
        connection,
        mysqlRosterTable,
        `${tablePrefix}roster_account_fk`,
        "account_id",
        mysqlAccountsTable,
        "account_id",
      );
      await ensureMysqlForeignKey(
        connection,
        mysqlSessionsTable,
        `${tablePrefix}sessions_account_fk`,
        "account_id",
        mysqlAccountsTable,
        "account_id",
      );
      mysqlStorageReady = true;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      connection.release();
    }
  }

  async function readMysqlStateWithoutInitialization(
    connection,
    { allowMissingCompetitionSetup = false } = {},
  ) {
    const [teamRows] = await connection.query(`
    SELECT team_id, group_id, registration_number, team_name, project_name, appearance_order, status, revision, roster_snapshot, state_created_at, state_updated_at
    FROM ${mysqlId(mysqlTeamsTable)} ORDER BY group_id, appearance_order, team_id
  `);
    const [accountRows] = await connection.query(`
    SELECT account_id, username, display_name, role, status, password_hash, password_version, auth_version, revision, state_created_at, state_updated_at
    FROM ${mysqlId(mysqlAccountsTable)} ORDER BY created_at, account_id
  `);
    const [rosterRows] = await connection.query(
      `SELECT account_id, sort_order FROM ${mysqlId(mysqlRosterTable)} ORDER BY sort_order, account_id`,
    );
    const [entryRows] = await connection.query(`
    SELECT judge_id, candidate_id, scores_json, submitted, updated_at, client_updated_at, server_revision, server_updated_at
    FROM ${mysqlId(mysqlEntriesTable)}
  `);
    const [controlRows] = await connection.query(
      `SELECT control_key, control_value, revision, updated_at FROM ${mysqlId(mysqlControlStateTable)}`,
    );
    const controls = new Map(controlRows.map((row) => [row.control_key, row]));
    const assignmentRow = controls.get(activeAssignmentControlKey);
    const displayRow = controls.get(displaySelectionControlKey);
    const rosterControlRow = controls.get(judgeRosterControlKey);
    const competitionSetupRow = controls.get(competitionSetupControlKey);
    const rosterMeta = parseRequiredMysqlControl(rosterControlRow?.control_value, judgeRosterControlKey);
    const assignmentControl = parseRequiredMysqlControl(assignmentRow?.control_value, activeAssignmentControlKey);
    const displayControl = parseRequiredMysqlControl(displayRow?.control_value, displaySelectionControlKey);
    const competitionSetupControl =
      allowMissingCompetitionSetup && !competitionSetupRow
        ? undefined
        : parseRequiredMysqlControl(
            competitionSetupRow?.control_value,
            competitionSetupControlKey,
            groups.map((group) => group.id),
          );
    const rawState = createEmptyState();
    rawState.teams = teamRows.map((row) => ({
      id: row.team_id,
      groupId: row.group_id,
      registrationNumber: row.registration_number,
      teamName: row.team_name,
      projectName: row.project_name,
      appearanceOrder: row.appearance_order,
      status: row.status,
      revision: row.revision,
      judgeRosterSnapshot: parseMysqlJson(row.roster_snapshot, []),
      createdAt: row.state_created_at,
      updatedAt: row.state_updated_at,
    }));
    rawState.accounts = accountRows.map((row) => ({
      id: row.account_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      passwordHash: row.password_hash,
      passwordVersion: row.password_version,
      authVersion: row.auth_version,
      revision: row.revision,
      createdAt: row.state_created_at,
      updatedAt: row.state_updated_at,
    }));
    rawState.judgeRoster = {
      ...rosterMeta,
      judgeIds: rosterRows.map((row) => row.account_id),
      revision: clampInteger(rosterControlRow?.revision),
      lockedAt: rosterMeta.lockedAt,
      updatedAt: rosterMeta.updatedAt || rosterControlRow?.updated_at || "",
    };
    rawState.entriesByJudge = entryRows.reduce((entriesByJudge, row) => {
      const judgeId = normalizeJudgeId(row.judge_id);
      entriesByJudge[judgeId] = entriesByJudge[judgeId] ?? {};
      entriesByJudge[judgeId][row.candidate_id] = {
        scores: parseMysqlJson(row.scores_json),
        submitted: Boolean(row.submitted),
        updatedAt: row.updated_at,
        clientUpdatedAt: row.client_updated_at,
        serverRevision: row.server_revision,
        serverUpdatedAt: row.server_updated_at,
      };
      return entriesByJudge;
    }, {});
    rawState.teamOrderRevisionByGroup = groups.reduce((result, group) => {
      const control = controls.get(getTeamOrderControlKey(group.id));
      result[group.id] = control
        ? clampInteger(control.revision)
        : Math.max(
            0,
            ...teamRows
              .filter((row) => row.group_id === group.id)
              .map((row) => clampInteger(row.revision)),
          );
      return result;
    }, {});
    rawState.activeAssignment = assignmentControl;
    rawState.displaySelection = displayControl;
    rawState.competitionSetup = competitionSetupControl;
    const state = sanitizeState(rawState);
    state.activeAssignment.assignmentRevision = clampInteger(
      assignmentRow?.revision,
      state.activeAssignment.assignmentRevision,
    );
    state.displaySelection.displayRevision = clampInteger(
      displayRow?.revision,
      state.displaySelection.displayRevision,
    );
    state.competitionSetup.revision = clampInteger(
      competitionSetupRow?.revision,
      state.competitionSetup.revision,
    );
    return state;
  }

  async function readMysqlState() {
    await initializeMysqlStorage();
    const connection = await createMysqlPool().getConnection();
    try {
      return await withMysqlConsistentSnapshot(connection, () =>
        readMysqlStateWithoutInitialization(connection),
      );
    } finally {
      connection.release();
    }
  }

  async function writeMysqlMutation(state, mutation) {
    await initializeMysqlStorage();
    const connection = await createMysqlPool().getConnection();
    try {
      await connection.beginTransaction();
      if (mutation.type === "team") {
        const team = getTeamById(state, mutation.teamId);
        if (team) await upsertMysqlTeam(connection, team);
      } else if (mutation.type === "team_delete") {
        await connection.query(
          `DELETE FROM ${mysqlId(mysqlTeamsTable)} WHERE team_id = ?`,
          [mutation.teamId],
        );
      } else if (mutation.type === "team_order") {
        const teams = state.teams.filter(
          (team) => team.groupId === mutation.groupId,
        );
        for (const team of teams) await upsertMysqlTeam(connection, team);
      } else if (mutation.type === "account") {
        const account = getAccountById(state, mutation.accountId);
        if (account) await upsertMysqlAccount(connection, account);
      } else if (mutation.type === "judge_enrollment") {
        const account = getAccountById(state, mutation.accountId);
        if (account) await upsertMysqlAccount(connection, account);
        await connection.query(`DELETE FROM ${mysqlId(mysqlRosterTable)}`);
        if (state.judgeRoster.judgeIds.length) {
          await connection.query(
            `INSERT INTO ${mysqlId(mysqlRosterTable)} (account_id, sort_order) VALUES ?`,
            [state.judgeRoster.judgeIds.map((accountId, index) => [accountId, index + 1])],
          );
        }
      } else if (mutation.type === "roster") {
        await connection.query(`DELETE FROM ${mysqlId(mysqlRosterTable)}`);
        if (state.judgeRoster.judgeIds.length) {
          await connection.query(
            `INSERT INTO ${mysqlId(mysqlRosterTable)} (account_id, sort_order) VALUES ?`,
            [
              state.judgeRoster.judgeIds.map((accountId, index) => [
                accountId,
                index + 1,
              ]),
            ],
          );
        }
      } else if (mutation.type === "entry") {
        const entry = getEntry(state, mutation.judgeId, mutation.teamId);
        await connection.query(
          `
          INSERT INTO ${mysqlId(mysqlEntriesTable)}
            (judge_id, candidate_id, scores_json, submitted, updated_at, client_updated_at, server_revision, server_updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE scores_json = VALUES(scores_json), submitted = VALUES(submitted), updated_at = VALUES(updated_at),
            client_updated_at = VALUES(client_updated_at), server_revision = VALUES(server_revision), server_updated_at = VALUES(server_updated_at)
        `,
          [
            mutation.judgeId,
            mutation.teamId,
            JSON.stringify(entry.scores),
            entry.submitted ? 1 : 0,
            entry.updatedAt,
            Math.trunc(entry.clientUpdatedAt || 0),
            entry.serverRevision,
            entry.serverUpdatedAt,
          ],
        );
      }

      if (
        mutation.persistRoster &&
        !["roster", "judge_enrollment"].includes(mutation.type)
      ) {
        await connection.query(`DELETE FROM ${mysqlId(mysqlRosterTable)}`);
        if (state.judgeRoster.judgeIds.length) {
          await connection.query(
            `INSERT INTO ${mysqlId(mysqlRosterTable)} (account_id, sort_order) VALUES ?`,
            [
              state.judgeRoster.judgeIds.map((accountId, index) => [
                accountId,
                index + 1,
              ]),
            ],
          );
        }
      }
      if (mutation.clearEntriesTeamIds?.length) {
        await connection.query(
          `DELETE FROM ${mysqlId(mysqlEntriesTable)} WHERE candidate_id IN (?)`,
          [mutation.clearEntriesTeamIds],
        );
      }
      if (mutation.clearEntryJudgeIds?.length && mutation.clearEntryTeamId) {
        await connection.query(
          `DELETE FROM ${mysqlId(mysqlEntriesTable)} WHERE candidate_id = ? AND judge_id IN (?)`,
          [mutation.clearEntryTeamId, mutation.clearEntryJudgeIds],
        );
      }

      for (const teamId of mutation.teamIds ?? []) {
        const team = getTeamById(state, teamId);
        if (team) await upsertMysqlTeam(connection, team);
      }
      if (mutation.persistAssignment) {
        await upsertMysqlControl(
          connection,
          activeAssignmentControlKey,
          state.activeAssignment,
          state.activeAssignment.assignmentRevision,
          state.activeAssignment.updatedAt,
        );
      }
      if (mutation.persistRoster || mutation.type === "roster") {
        await upsertMysqlControl(
          connection,
          judgeRosterControlKey,
          state.judgeRoster,
          state.judgeRoster.revision,
          state.judgeRoster.updatedAt,
        );
      }
      if (mutation.persistDisplay) {
        await upsertMysqlControl(
          connection,
          displaySelectionControlKey,
          state.displaySelection,
          state.displaySelection.displayRevision,
          state.displaySelection.updatedAt,
        );
      }
      if (mutation.persistCompetitionSetup) {
        await upsertMysqlControl(
          connection,
          competitionSetupControlKey,
          state.competitionSetup,
          state.competitionSetup.revision,
          new Date().toISOString(),
        );
      }
      if (mutation.persistTeamOrderGroup) {
        const groupId = mutation.persistTeamOrderGroup;
        await upsertMysqlControl(
          connection,
          getTeamOrderControlKey(groupId),
          { groupId },
          state.teamOrderRevisionByGroup[groupId] ?? 0,
          new Date().toISOString(),
        );
      }
      if (mutation.auditEvent) {
        const event = mutation.auditEvent;
        await connection.query(
          `INSERT INTO ${mysqlId(mysqlAuditEventsTable)} (event_id, action, actor_id, target_id, details_json, event_created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [event.eventId, event.action, event.actorId, event.targetId, JSON.stringify(event.details), event.createdAt],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function readState() {
    if (mode === "mysql") {
      try {
        return await readMysqlState();
      } catch (error) {
        throw new Error(
          `评分数据库无法读取，请检查 MySQL 连接和表结构：${error.message}`,
        );
      }
    }
    if (!existsSync(stateFile)) return createInitialState();
    try {
      return sanitizeState(JSON.parse(await readFile(stateFile, "utf8")));
    } catch (error) {
      throw new Error(`评分状态文件无法读取，请先从备份恢复：${error.message}`);
    }
  }

  async function writeState(state, mutation) {
    const persistencePlan = createContestPersistencePlan(mutation);
    if (mode === "mysql") {
      try {
        await writeMysqlMutation(state, persistencePlan);
        return;
      } catch (error) {
        throw new Error(
          `评分数据库无法写入，请检查 MySQL 连接和磁盘空间：${error.message}`,
        );
      }
    }
    await writeFileState(state);
  }

  async function initialize() {
    if (mode === "file") await initializeFileStorage();
    else await initializeMysqlStorage();
  }

  async function checkHealth() {
    if (mode !== "mysql") return;
    const [rows] = await createMysqlPool().query(
      `SELECT control_key, control_value FROM ${mysqlId(mysqlControlStateTable)} WHERE control_key IN (?, ?, ?, ?)`,
      [activeAssignmentControlKey, displaySelectionControlKey, judgeRosterControlKey, competitionSetupControlKey],
    );
    const controls = new Map(rows.map((row) => [row.control_key, row.control_value]));
    for (const key of [activeAssignmentControlKey, displaySelectionControlKey, judgeRosterControlKey, competitionSetupControlKey]) {
      parseRequiredMysqlControl(
        controls.get(key),
        key,
        key === competitionSetupControlKey ? groups.map((group) => group.id) : [],
      );
    }
  }

  async function close() {
    if (!mysqlPool) return;
    await mysqlPool.end();
    mysqlPool = null;
    mysqlStorageReady = false;
  }

  return {
    mode,
    stateFile,
    tables: {
      teams: mysqlTeamsTable,
      accounts: mysqlAccountsTable,
      sessions: mysqlSessionsTable,
      roster: mysqlRosterTable,
      entries: mysqlEntriesTable,
      controlState: mysqlControlStateTable,
      auditEvents: mysqlAuditEventsTable,
    },
    assertSupportedStorageMode,
    initialize,
    readState,
    writeState,
    checkHealth,
    close,
    getMysqlPool: createMysqlPool,
    mysqlId,
  };
}
