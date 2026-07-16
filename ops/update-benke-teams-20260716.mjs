import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

const beforeExpected = [
  ["BK01", 1, "CT-0169", "GOAT"],
  ["BK02", 2, "CT-0700", "ai智创"],
  ["BK03", 3, "CT-0851", "畅通无组"],
  ["BK04", 4, "CT-0123", "伍限热度"],
  ["BK05", 5, "CT-0594", "东盟智航队"],
  ["BK06", 6, "CT-0122", "东盟启航队"],
  ["BK07", 7, "CT-1818", "以人民为组"],
  ["BK08", 8, "CT-0367", "椒你致富"],
  ["BK09", 9, "CT-0805", "你说的都队"],
  ["BK10", 10, "CT-0628", "一键爆单队"],
  ["BK11", 11, "CT-1737", "越智云航"],
  ["BK12", 12, "CT-1683", "AAA专业团队"],
  ["BK13", 13, "CT-1280", "拓境AI"],
  ["BK14", 14, "CT-0199", "说的都队"],
  ["BK15", 15, "CT-0787", "创意无限队"],
  ["BK16", 16, "CT-0758", "最美F4队"],
  ["BK17", 17, "CT-0806", "探险队"],
  ["BK18", 18, "CT-0248", "PureX"],
  ["BK19", 19, "CT-1924", "IMFEARLES"],
  ["BK20", 20, "CT-0823", "数境南洋"],
];

const target = [
  ["BK01", 1, "CT-0169", "GOAT"],
  ["BK02", 2, "CT-0700", "ai智创"],
  ["BK03", 3, "CT-0851", "畅通无组"],
  ["BK04", 4, "CT-0123", "伍限热度"],
  ["BK05", 5, "CT-0594", "东盟智航队"],
  ["BK06", 6, "CT-0122", "东盟启航队"],
  ["BK07", 7, "CT-1818", "以人民为组"],
  ["BK08", 8, "CT-0367", "椒你致富"],
  ["BK09", 9, "CT-0805", "你说的都队"],
  ["BK10", 10, "CT-0628", "一键爆单队"],
  ["BK11", 11, "CT-1737", "越智云航"],
  ["BK12", 12, "CT-1280", "拓境AI"],
  ["BK13", 13, "CT-0199", "说的都队"],
  ["BK14", 14, "CT-0787", "创意无限队"],
  ["BK15", 15, "CT-0758", "最美F4队"],
  ["BK16", 16, "CT-0806", "探险队"],
  ["BK17", 17, "CT-0248", "PureX"],
  ["BK18", 18, "CT-1924", "IMFEARLESS"],
  ["BK19", 19, "CT-0823", "数境南洋"],
  ["BK20", 20, "CT-0120", "天生一对"],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function teamTuple(row) {
  return [
    row.team_id,
    Number(row.appearance_order),
    row.registration_number,
    row.team_name,
  ];
}

function preservedTeamTuple(row) {
  return [
    row.team_id,
    row.group_id,
    row.project_name,
    Number(row.appearance_order),
    row.status,
    row.roster_snapshot,
    row.state_created_at,
  ];
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseJsonValue(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} 不是合法JSON`);
  }
}

const tablePrefix = process.env.CONTEST_MYSQL_TABLE_PREFIX || "contest_final_";
assert(/^[A-Za-z0-9_]+$/.test(tablePrefix), "CONTEST_MYSQL_TABLE_PREFIX 非法");

const table = (suffix) => `\`${tablePrefix}${suffix}\``;
const connectionConfig = process.env.CONTEST_DATABASE_URL
  ? process.env.CONTEST_DATABASE_URL
  : {
      host: process.env.CONTEST_MYSQL_HOST || "127.0.0.1",
      port: Number(process.env.CONTEST_MYSQL_PORT || 3306),
      user: process.env.CONTEST_MYSQL_USER,
      password: process.env.CONTEST_MYSQL_PASSWORD,
      database: process.env.CONTEST_MYSQL_DATABASE,
      charset: "utf8mb4",
    };

const connection = await mysql.createConnection(connectionConfig);
let committed = false;

try {
  await connection.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  await connection.beginTransaction();

  const [allTeamsBefore] = await connection.query(`
    SELECT team_id, group_id, registration_number, team_name, project_name,
           appearance_order, status, revision, roster_snapshot,
           state_created_at, state_updated_at
    FROM ${table("teams")}
    ORDER BY team_id
    FOR UPDATE
  `);
  const benkeBefore = allTeamsBefore
    .filter((row) => row.group_id === "benke")
    .sort((a, b) => Number(a.appearance_order) - Number(b.appearance_order));

  assert(benkeBefore.length === 20, `本科组队伍数量不是20，当前为${benkeBefore.length}`);
  assert(
    same(benkeBefore.map(teamTuple), beforeExpected),
    "本科组线上旧值与预检快照不一致，已拒绝更新",
  );

  const targetNumbers = new Set(target.map((row) => row[2]));
  assert(targetNumbers.size === 20, "目标报名号存在重复");
  const targetIds = new Set(target.map((row) => row[0]));
  const externalConflicts = allTeamsBefore.filter(
    (row) => targetNumbers.has(row.registration_number) && !targetIds.has(row.team_id),
  );
  assert(externalConflicts.length === 0, "目标报名号已被本科组外队伍占用");

  const [entriesBefore] = await connection.query(`
    SELECT judge_id, candidate_id, scores_json, submitted, updated_at,
           client_updated_at, server_revision, server_updated_at
    FROM ${table("entries")}
    ORDER BY judge_id, candidate_id
    FOR UPDATE
  `);
  const benkeIds = new Set(benkeBefore.map((row) => row.team_id));
  const benkeEntries = entriesBefore.filter((row) => benkeIds.has(row.candidate_id));
  assert(benkeEntries.length === 0, "本科组已出现评分记录，已拒绝本次名单迁移");

  const [controlsBefore] = await connection.query(`
    SELECT control_key, control_value, revision, updated_at
    FROM ${table("control_state")}
    ORDER BY control_key
    FOR UPDATE
  `);
  const controlsByKey = new Map(
    controlsBefore.map((row) => [
      row.control_key,
      parseJsonValue(row.control_value, `控制状态${row.control_key}`),
    ]),
  );
  const competitionSetup = controlsByKey.get("competition_setup");
  const activeAssignment = controlsByKey.get("active_assignment");
  const displaySelection = controlsByKey.get("display_selection");
  assert(competitionSetup?.groups?.benke?.status === "draft", "本科组已不处于草稿状态");
  assert(competitionSetup.activeGroupId !== "benke", "本科组当前仍是活动组");
  assert(activeAssignment?.groupId !== "benke", "本科组当前仍有全局派发任务");
  assert(!benkeIds.has(activeAssignment?.teamId), "当前派发队伍属于本科组");
  const changedTeamIds = new Set(target.slice(11).map((row) => row[0]));
  assert(!changedTeamIds.has(displaySelection?.teamId), "待更新队伍当前正在成绩大屏展示");
  const controlsDigestBefore = digest(controlsBefore);
  const preservedDigestBefore = digest(benkeBefore.map(preservedTeamTuple));
  const entriesDigestBefore = digest(entriesBefore);
  const changedAt = new Date().toISOString();
  const targetById = new Map(target.map((row) => [row[0], row]));
  const changes = [...benkeBefore]
    .filter((row) => {
      const wanted = targetById.get(row.team_id);
      return row.registration_number !== wanted[2] || row.team_name !== wanted[3];
    })
    .sort((a, b) => Number(b.appearance_order) - Number(a.appearance_order));

  assert(changes.length === 9, `预期更新9支队伍，实际为${changes.length}`);
  for (const row of changes) {
    assert(Number(row.revision) === 0, `${row.team_id} revision已变化，已拒绝更新`);
    const rosterSnapshot = parseJsonValue(row.roster_snapshot, `${row.team_id}冻结评委名册`);
    assert(
      rosterSnapshot === null || (Array.isArray(rosterSnapshot) && rosterSnapshot.length === 0),
      `${row.team_id}已有冻结评委名册，已拒绝更新`,
    );
  }
  const auditChanges = [];

  for (const row of changes) {
    const wanted = targetById.get(row.team_id);
    const [result] = await connection.execute(
      `UPDATE ${table("teams")}
       SET registration_number = ?, team_name = ?, revision = revision + 1,
           state_updated_at = ?
       WHERE team_id = ? AND group_id = 'benke'
         AND registration_number = ? AND team_name = ? AND revision = ?`,
      [
        wanted[2],
        wanted[3],
        changedAt,
        row.team_id,
        row.registration_number,
        row.team_name,
        Number(row.revision),
      ],
    );
    assert(result.affectedRows === 1, `${row.team_id} 更新受影响行数异常`);
    auditChanges.push({
      teamId: row.team_id,
      previous: {
        registrationNumber: row.registration_number,
        teamName: row.team_name,
        revision: Number(row.revision),
      },
      saved: {
        registrationNumber: wanted[2],
        teamName: wanted[3],
        revision: Number(row.revision) + 1,
      },
    });
  }

  const [allTeamsAfter] = await connection.query(`
    SELECT team_id, group_id, registration_number, team_name, project_name,
           appearance_order, status, revision, roster_snapshot,
           state_created_at, state_updated_at
    FROM ${table("teams")}
    ORDER BY team_id
  `);
  const benkeAfter = allTeamsAfter
    .filter((row) => row.group_id === "benke")
    .sort((a, b) => Number(a.appearance_order) - Number(b.appearance_order));
  assert(same(benkeAfter.map(teamTuple), target), "事务内目标名单复核失败");
  assert(
    digest(benkeAfter.map(preservedTeamTuple)) === preservedDigestBefore,
    "队伍保留字段发生变化",
  );

  const beforeById = new Map(benkeBefore.map((row) => [row.team_id, row]));
  for (const row of benkeAfter) {
    const before = beforeById.get(row.team_id);
    const changed = changes.some((item) => item.team_id === row.team_id);
    assert(
      Number(row.revision) === Number(before.revision) + (changed ? 1 : 0),
      `${row.team_id} revision变化异常`,
    );
    if (changed) assert(row.state_updated_at === changedAt, `${row.team_id} 更新时间异常`);
  }

  const duplicates = new Map();
  for (const row of allTeamsAfter) {
    if (!targetNumbers.has(row.registration_number)) continue;
    duplicates.set(row.registration_number, (duplicates.get(row.registration_number) || 0) + 1);
  }
  assert(
    [...targetNumbers].every((number) => duplicates.get(number) === 1),
    "更新后目标报名号未保持全局唯一",
  );

  const [entriesAfter] = await connection.query(`
    SELECT judge_id, candidate_id, scores_json, submitted, updated_at,
           client_updated_at, server_revision, server_updated_at
    FROM ${table("entries")}
    ORDER BY judge_id, candidate_id
  `);
  assert(digest(entriesAfter) === entriesDigestBefore, "评分记录在事务中发生变化");

  const [controlsAfter] = await connection.query(`
    SELECT control_key, control_value, revision, updated_at
    FROM ${table("control_state")}
    ORDER BY control_key
  `);
  assert(digest(controlsAfter) === controlsDigestBefore, "比赛控制状态在事务中发生变化");

  const eventId = `maintenance-benke-teams-${Date.now()}`;
  await connection.execute(
    `INSERT INTO ${table("audit_events")}
       (event_id, action, actor_id, target_id, details_json, event_created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      "team_batch_update",
      "root-maintenance",
      "benke",
      JSON.stringify({
        operation: "update_undergraduate_finalist_directory",
        backup: "mysql-before-benke-teams-20260716-092407.sql.gz",
        changedTeams: auditChanges,
      }),
      changedAt,
    ],
  );

  await connection.commit();
  committed = true;
  console.log(JSON.stringify({
    ok: true,
    changedAt,
    changedCount: changes.length,
    eventId,
    controlStateSha256: controlsDigestBefore,
    teams: benkeAfter.map((row) => ({
      id: row.team_id,
      appearanceOrder: Number(row.appearance_order),
      registrationNumber: row.registration_number,
      teamName: row.team_name,
      revision: Number(row.revision),
    })),
  }, null, 2));
} catch (error) {
  if (!committed) await connection.rollback();
  console.error(`本科组名单更新失败并已回滚：${error.message}`);
  process.exitCode = 1;
} finally {
  await connection.end();
}
