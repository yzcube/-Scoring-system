import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contestGroups, defaultCandidateOrderByGroup, defaultCandidates } from "../shared/contestData.js";

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

function createInsertIgnoreSql(table, columns, rows) {
  if (!rows.length) return "";
  const values = rows
    .map((row) => `(${row.map((value) => (typeof value === "number" ? String(value) : sqlString(value))).join(", ")})`)
    .join(",\n");
  return `INSERT IGNORE INTO ${mysqlId(table)} (${columns.map(mysqlId).join(", ")}) VALUES\n${values};`;
}

function createSql({ databaseName, tablePrefix, group, teams }) {
  const teamsTable = `${tablePrefix}teams`;
  const controlsTable = `${tablePrefix}control_state`;
  const order = defaultCandidateOrderByGroup[group.id] ?? teams.map((team) => team.id);
  const orderById = new Map(order.map((id, index) => [id, index + 1]));
  const rows = teams.map((team) => [
    team.id,
    group.id,
    team.registrationNumber,
    team.team,
    team.product,
    orderById.get(team.id) ?? 0,
    "active",
    0,
    "[]",
    "",
    "",
  ]);

  return `-- Add missing teams for one competition group without modifying existing teams, scores, accounts, roster, assignment, or display state.
-- Initialize the target with the MySQL scoring server before importing this file.
-- Group: ${group.id} / ${group.label}; teams: ${teams.length}.

SET NAMES utf8mb4;
SET time_zone = '+00:00';
CREATE DATABASE IF NOT EXISTS ${mysqlId(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ${mysqlId(databaseName)};

START TRANSACTION;

SET @registration_column_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = ${sqlString(teamsTable)}
    AND column_name = 'registration_number'
);
SET @registration_column_sql := IF(
  @registration_column_exists = 0,
  'ALTER TABLE ${teamsTable.replaceAll("`", "``")} ADD COLUMN registration_number VARCHAR(64) NOT NULL DEFAULT '''' AFTER group_id',
  'SELECT 1'
);
PREPARE registration_column_stmt FROM @registration_column_sql;
EXECUTE registration_column_stmt;
DEALLOCATE PREPARE registration_column_stmt;

${createInsertIgnoreSql(
  teamsTable,
  ["team_id", "group_id", "registration_number", "team_name", "project_name", "appearance_order", "status", "revision", "roster_snapshot", "state_created_at", "state_updated_at"],
  rows,
)}

INSERT IGNORE INTO ${mysqlId(controlsTable)} (control_key, control_value, revision, updated_at)
VALUES (${sqlString(`team_order:${group.id}`)}, ${sqlString(JSON.stringify({ groupId: group.id }))}, 0, '');

COMMIT;

SELECT COUNT(*) AS group_team_count FROM ${mysqlId(teamsTable)} WHERE group_id = ${sqlString(group.id)};
`;
}

async function main() {
  const args = parseArgs();
  const groupId = args.get("group") || "zhongzhi";
  const outputPath = resolve(args.get("out") || `database-export/campus-final-scoring-add-${groupId}.sql`);
  const databaseName = args.get("database") || process.env.CONTEST_MYSQL_DATABASE || "campus_final_scoring";
  const tablePrefix = args.get("prefix") || process.env.CONTEST_MYSQL_TABLE_PREFIX || "contest_final_";
  assertSafeIdentifier(databaseName, "database name");
  assertSafeIdentifier(tablePrefix, "table prefix");
  const group = contestGroups.find((item) => item.id === groupId);
  if (!group) throw new Error(`Unknown group: ${groupId}. Available groups: ${contestGroups.map((item) => item.id).join(", ")}`);
  const teams = defaultCandidates.filter((candidate) => candidate.groupId === groupId);
  if (!teams.length) throw new Error(`No default teams found for group: ${groupId}`);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, createSql({ databaseName, tablePrefix, group, teams }));
  console.log(JSON.stringify({ outputPath, group: group.id, label: group.label, teams: teams.length }, null, 2));
}

await main();
