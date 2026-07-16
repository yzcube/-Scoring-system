import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import mysql from "mysql2/promise";
import { itemIds, itemMax, scoreScale } from "../shared/scoringRules.js";
const judgeIds = ["001", "002", "003", "004", "005", "006", "007"];
const smokePrefix = process.env.CONTEST_MYSQL_SMOKE_PREFIX || "contest_smoke_";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSmokePrefix() {
  assert(/^contest_smoke_[A-Za-z0-9_]*$/.test(smokePrefix), "CONTEST_MYSQL_SMOKE_PREFIX must begin with contest_smoke_ and use only letters, numbers, and underscores");
}

function mysqlId(identifier) {
  assert(/^[A-Za-z0-9_]+$/.test(identifier), `unsafe MySQL identifier: ${identifier}`);
  return `\`${identifier}\``;
}

function requireMysqlConfig() {
  if (process.env.CONTEST_DATABASE_URL) return;
  const missing = ["CONTEST_MYSQL_DATABASE", "CONTEST_MYSQL_USER"].filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing MySQL config: ${missing.join(", ")}. Set MySQL env vars before running check:mysql.`);
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
  return mysql.createPool({ ...options, waitForConnections: true, connectionLimit: 2, queueLimit: 0, decimalNumbers: true });
}

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return address.port;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, payload: await readJson(response) };
}

function authHeaders(token, headers = {}) {
  return { ...headers, Authorization: `Bearer ${token}` };
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited before ready: ${child.exitCode}`);
    try {
      const result = await requestJson(baseUrl, "/api/health");
      if (result.status === 200 && result.payload.storage === "mysql") return;
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }
  throw new Error("MySQL server did not become ready");
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

function startServer(port, { requireEmptyState = false } = {}) {
  const child = spawn(process.execPath, ["contest-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CONTEST_STORAGE: "mysql",
      CONTEST_MYSQL_TABLE_PREFIX: smokePrefix,
      REQUIRE_EMPTY_STATE: requireEmptyState ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
}

async function login(baseUrl, username, password) {
  const result = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, deviceId: `mysql-smoke-${username}` }),
  });
  assert(result.status === 200, `${username} login failed: ${result.status} ${result.payload.error ?? ""}`);
  return result.payload.token;
}

function scoresForTotal(total) {
  let remainingCents = Math.round(total * scoreScale);
  return Object.fromEntries(
    itemIds.map((id) => {
      const cents = Math.min(itemMax[id] * scoreScale, remainingCents);
      remainingCents -= cents;
      return [id, cents / scoreScale];
    }),
  );
}

function entryFor(total, serverRevision = 0, submitted = false) {
  return {
    scores: scoresForTotal(total),
    submitted,
    updatedAt: "mysql-smoke",
    clientUpdatedAt: Date.now(),
    serverRevision,
    serverUpdatedAt: "",
  };
}

async function writeEntry(baseUrl, token, judgeId, teamId, entry, assignmentRevision) {
  return requestJson(baseUrl, `/api/entries/${encodeURIComponent(judgeId)}/${encodeURIComponent(teamId)}`, {
    method: "PUT",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ entry, assignmentRevision }),
  });
}

async function cleanupSmokeRows() {
  const pool = createMysqlPool();
  const tables = [
    `${smokePrefix}account_sessions`,
    `${smokePrefix}audit_events`,
    `${smokePrefix}entries`,
    `${smokePrefix}judge_roster`,
    `${smokePrefix}accounts`,
    `${smokePrefix}teams`,
    `${smokePrefix}control_state`,
    `${smokePrefix}candidate_order`,
    `${smokePrefix}candidate_overrides`,
  ];
  try {
    for (const table of tables) {
      try {
        await pool.query(`DELETE FROM ${mysqlId(table)}`);
      } catch (error) {
        if (error?.code !== "ER_NO_SUCH_TABLE") throw error;
      }
    }
  } finally {
    await pool.end();
  }
}

async function readMysqlChecks() {
  const pool = createMysqlPool();
  try {
    const teamsTable = `${smokePrefix}teams`;
    const accountsTable = `${smokePrefix}accounts`;
    const sessionsTable = `${smokePrefix}account_sessions`;
    const entriesTable = `${smokePrefix}entries`;
    const controlsTable = `${smokePrefix}control_state`;
    const auditEventsTable = `${smokePrefix}audit_events`;
    const [[teamCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(teamsTable)}`);
    const [[accountCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(accountsTable)}`);
    const [[entryCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(entriesTable)} WHERE candidate_id = ?`, ["GZ01"]);
    const [[sessionCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(sessionsTable)} WHERE revoked_at IS NULL`);
    const [[auditCount]] = await pool.query(`SELECT COUNT(*) AS count FROM ${mysqlId(auditEventsTable)} WHERE action = ?`, ["judge_enrollment_create"]);
    const [controlRows] = await pool.query(
      `SELECT control_key, control_value FROM ${mysqlId(controlsTable)} WHERE control_key IN (?, ?, ?, ?)`,
      ["active_assignment", "display_selection", "judge_roster", "competition_setup"],
    );
    return {
      teams: Number(teamCount.count),
      accounts: Number(accountCount.count),
      entries: Number(entryCount.count),
      sessions: Number(sessionCount.count),
      auditEvents: Number(auditCount.count),
      controls: Object.fromEntries(controlRows.map((row) => [row.control_key, JSON.parse(row.control_value)])),
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  requireMysqlConfig();
  assertSmokePrefix();
  await cleanupSmokeRows();

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = null;

  try {
    server = startServer(port, { requireEmptyState: true });
    await waitForServer(baseUrl, server.child);
    let adminToken = await login(baseUrl, "admin", "admin123");
    const judgeTokens = Object.fromEntries(await Promise.all(judgeIds.map(async (id) => [id, await login(baseUrl, id, id)])));
    const initial = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(initial.status === 200, `initial MySQL state returned ${initial.status}`);
    assert(initial.payload.teams?.length === 80 && initial.payload.accounts?.length === 8, "MySQL did not seed team and account entities");

    const blockedOpen = await requestJson(baseUrl, "/api/competition-setup/gaozhi/open", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ revision: initial.payload.competitionSetup.groups.gaozhi.revision }),
    });
    assert(blockedOpen.status === 409, "MySQL formal mode did not block opening with the seeded administrator password");
    const adminAccount = initial.payload.accounts.find((account) => account.id === "admin");
    const passwordRotation = await requestJson(baseUrl, "/api/accounts/admin", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ displayName: adminAccount.displayName, status: adminAccount.status, password: "mysql-admin-rotated", revision: adminAccount.revision }),
    });
    assert(passwordRotation.status === 200, `MySQL administrator password rotation failed: ${passwordRotation.payload.error ?? ""}`);
    adminToken = await login(baseUrl, "admin", "mysql-admin-rotated");

    const configuredGroup = await requestJson(baseUrl, "/api/competition-setup/gaozhi", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        teamIds: ["GZ01", "GZ02"],
        judgeIds,
        revision: initial.payload.competitionSetup.groups.gaozhi.revision,
      }),
    });
    assert(configuredGroup.status === 200, `MySQL competition setup save failed: ${configuredGroup.payload.error ?? ""}`);

    const gz01 = initial.payload.teams.find((team) => team.id === "GZ01");
    const edited = await requestJson(baseUrl, "/api/teams/GZ01", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamName: "MySQL Smoke Team", projectName: "MySQL Smoke Project", revision: gz01.revision }),
    });
    assert(edited.status === 200, `MySQL team edit failed: ${edited.payload.error ?? ""}`);

    const openedGroup = await requestJson(baseUrl, "/api/competition-setup/gaozhi/open", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ revision: configuredGroup.payload.competitionSetup.groups.gaozhi.revision }),
    });
    assert(openedGroup.status === 200, `MySQL competition setup open failed: ${openedGroup.payload.error ?? ""}`);

    const dispatch = await requestJson(baseUrl, "/api/assignments/dispatch", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ01", revision: openedGroup.payload.activeAssignment.assignmentRevision }),
    });
    assert(dispatch.status === 200, `MySQL dispatch failed: ${dispatch.payload.error ?? ""}`);
    const assignmentRevision = dispatch.payload.activeAssignment.assignmentRevision;

    const firstSave = await writeEntry(baseUrl, judgeTokens["001"], "001", "GZ01", entryFor(88), assignmentRevision);
    assert(firstSave.status === 200 && firstSave.payload.entry?.serverRevision === 1, "initial MySQL score write did not persist");
    const staleSave = await writeEntry(baseUrl, judgeTokens["001"], "001", "GZ01", entryFor(80, 0), assignmentRevision);
    assert(staleSave.status === 409, "MySQL score write did not reject a stale entry revision");

    const totals = { "001": 70, "002": 80, "003": 90, "004": 100, "005": 60, "006": 95, "007": 85 };
    const firstSubmit = await writeEntry(baseUrl, judgeTokens["001"], "001", "GZ01", entryFor(totals["001"], firstSave.payload.entry.serverRevision, true), assignmentRevision);
    assert(firstSubmit.status === 200 && firstSubmit.payload.entry?.submitted, "first MySQL submission failed");
    for (const judgeId of judgeIds.slice(1)) {
      const result = await writeEntry(baseUrl, judgeTokens[judgeId], judgeId, "GZ01", entryFor(totals[judgeId], 0, true), assignmentRevision);
      assert(result.status === 200 && result.payload.entry?.submitted, `${judgeId} MySQL submission failed`);
    }

    const finalState = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(finalState.payload.activeAssignment?.status === "final", "MySQL assignment did not finalize after all submissions");
    assert(finalState.payload.summariesByTeam?.GZ01?.display === "84.00", "MySQL composite score is incorrect");
    const published = await requestJson(baseUrl, "/api/display-selection", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ01", publicationStatus: "final", revision: finalState.payload.displaySelection.displayRevision }),
    });
    assert(published.status === 200, `MySQL final display publication failed: ${published.payload.error ?? ""}`);

    const enrollment = await requestJson(baseUrl, "/api/admin/judge-enrollments", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        username: "008",
        displayName: "评委 08",
        password: "mysql-008",
        operationId: "mysql-smoke-enroll-008",
        expectedRosterRevision: finalState.payload.judgeRoster.revision,
        reason: "MySQL smoke future assignment enrollment",
      }),
    });
    assert(enrollment.status === 201 && enrollment.payload.judgeRoster?.judgeIds?.length === 8, `MySQL judge enrollment failed: ${enrollment.payload.error ?? ""}`);
    const dynamicJudgeId = enrollment.payload.account.id;
    const dynamicJudgeToken = await login(baseUrl, "008", "mysql-008");
    const replacement = await requestJson(baseUrl, "/api/assignments/replace-judge", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        outgoingJudgeId: "001",
        incomingJudgeId: dynamicJudgeId,
        rosterRevision: finalState.payload.activeAssignment.rosterRevision,
        reason: "MySQL smoke current-team emergency replacement",
      }),
    });
    assert(replacement.status === 200 && replacement.payload.activeAssignment?.rosterSnapshot?.includes(dynamicJudgeId), `MySQL current-team judge replacement failed: ${replacement.payload.error ?? ""}`);
    const replacementSubmission = await writeEntry(baseUrl, dynamicJudgeToken, dynamicJudgeId, "GZ01", entryFor(70, 0, true), assignmentRevision);
    assert(replacementSubmission.status === 200 && replacementSubmission.payload.entry?.submitted, "replacement judge MySQL submission failed");
    const afterReplacement = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(afterReplacement.payload.summariesByTeam?.GZ01?.display === "84.00", "replacement changed the expected MySQL composite score");
    const republished = await requestJson(baseUrl, "/api/display-selection", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ01", publicationStatus: "final", revision: afterReplacement.payload.displaySelection.displayRevision }),
    });
    assert(republished.status === 200, "replacement result could not be republished in MySQL smoke");
    const nextDispatch = await requestJson(baseUrl, "/api/assignments/dispatch", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ02", revision: finalState.payload.activeAssignment.assignmentRevision }),
    });
    assert(nextDispatch.status === 200 && nextDispatch.payload.activeAssignment?.rosterSnapshot?.length === 8, "MySQL next assignment did not use the eight-judge planned roster");
    const dynamicDraft = await writeEntry(baseUrl, dynamicJudgeToken, dynamicJudgeId, "GZ02", entryFor(77, 0, false), nextDispatch.payload.activeAssignment.assignmentRevision);
    assert(dynamicDraft.status === 200 && dynamicDraft.payload.entry?.serverRevision === 1, "dynamic MySQL judge score did not persist");

    await stopServer(server.child);
    const rejectedFormalStart = startServer(port, { requireEmptyState: true });
    const rejectedExitCode = await Promise.race([
      new Promise((resolve) => rejectedFormalStart.child.once("exit", resolve)),
      delay(5000).then(() => null),
    ]);
    assert(rejectedExitCode !== null && rejectedExitCode !== 0, "MySQL formal empty-state gate accepted an in-progress contest");
    assert(rejectedFormalStart.output().includes("Formal-round residue remains"), "MySQL formal empty-state rejection did not identify contest residue");
    server = startServer(port);
    await waitForServer(baseUrl, server.child);
    const restoredSession = await requestJson(baseUrl, "/api/session", { headers: authHeaders(adminToken) });
    assert(restoredSession.status === 200 && restoredSession.payload.account?.id === "admin", "MySQL session token did not survive a server restart");
    const restored = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(restored.payload.activeAssignment?.teamId === "GZ02" && restored.payload.activeAssignment?.rosterSnapshot?.length === 8, "eight-judge assignment was not restored from MySQL");
    assert(restored.payload.judgeRoster?.judgeIds?.length === 8, "updated planned roster was not restored from MySQL");
    assert(restored.payload.teams.find((team) => team.id === "GZ01")?.judgeRosterSnapshot?.includes(dynamicJudgeId), "current-team replacement snapshot was not restored from MySQL");
    assert(!restored.payload.teams.find((team) => team.id === "GZ01")?.judgeRosterSnapshot?.includes("001"), "replaced judge remained in the restored current-team snapshot");
    const restoredDynamicSession = await requestJson(baseUrl, "/api/session", { headers: authHeaders(dynamicJudgeToken) });
    assert(restoredDynamicSession.status === 200 && restoredDynamicSession.payload.account?.id === dynamicJudgeId, "dynamic judge session did not survive a server restart");
    assert(restored.payload.judgeRoster?.lockedAt, "judge roster lock metadata was not restored from MySQL");
    const scoreboard = await requestJson(baseUrl, "/api/scoreboard");
    assert(scoreboard.payload.displayTeam?.id === "GZ01" && scoreboard.payload.displaySummary?.display === "84.00", "published score display was not restored from MySQL");

    const stored = await readMysqlChecks();
    assert(stored.teams === 80 && stored.accounts === 9 && stored.entries === 8 && stored.sessions >= 9, "MySQL dynamic-judge resource rows are incomplete");
    assert(stored.auditEvents === 1, "MySQL temporary judge enrollment audit event is missing or duplicated");
    assert(stored.controls.active_assignment?.teamId === "GZ02" && stored.controls.active_assignment?.rosterSnapshot?.length === 8, "MySQL assignment control row is incomplete");
    assert(stored.controls.display_selection?.publicationStatus === "final", "MySQL display control row is incomplete");
    assert(stored.controls.judge_roster?.lockedAt, "MySQL roster control row is incomplete");

    for (const judgeId of restored.payload.activeAssignment.rosterSnapshot) {
      const previousEntry = restored.payload.entriesByJudge?.[judgeId]?.GZ02;
      const result = await writeEntry(
        baseUrl,
        adminToken,
        judgeId,
        "GZ02",
        entryFor(judgeId === dynamicJudgeId ? 77 : 80, previousEntry?.serverRevision ?? 0, true),
        restored.payload.activeAssignment.assignmentRevision,
      );
      assert(result.status === 200 && result.payload.entry?.submitted, `${judgeId} final MySQL team submission failed`);
    }
    const closeReady = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(closeReady.payload.activeAssignment?.status === "final", "MySQL final team did not reach final state before group close");
    const finalPublication = await requestJson(baseUrl, "/api/display-selection", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ02", publicationStatus: "final", revision: closeReady.payload.displaySelection.displayRevision }),
    });
    assert(finalPublication.status === 200, "MySQL final team could not be published before group close");
    const closedGroup = await requestJson(baseUrl, "/api/competition-setup/gaozhi/close", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ revision: closeReady.payload.competitionSetup.groups.gaozhi.revision }),
    });
    assert(closedGroup.status === 200, `MySQL competition group close failed: ${closedGroup.payload.error ?? ""}`);
    const closedStored = await readMysqlChecks();
    assert(closedStored.controls.competition_setup?.groups?.gaozhi?.status === "closed", "MySQL closed group status was not persisted");
    assert(closedStored.controls.competition_setup?.activeGroupId === null, "MySQL active group was not released after close");
    assert(closedStored.controls.active_assignment?.status === "closed", "MySQL assignment close state was not persisted");

    const restart = await requestJson(baseUrl, "/api/competition-setup/gaozhi/reopen", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        revision: closedGroup.payload.competitionSetup.groups.gaozhi.revision,
        confirmClearScores: true,
      }),
    });
    assert(restart.status === 200 && restart.payload.restart?.hadScoringData, `MySQL emergency restart failed: ${restart.payload.error ?? ""}`);

    await stopServer(server.child);
    server = startServer(port, { requireEmptyState: true });
    await waitForServer(baseUrl, server.child);
    const afterRestart = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(afterRestart.status === 200, "MySQL state was unavailable after emergency restart");
    assert(afterRestart.payload.competitionSetup?.groups?.gaozhi?.status === "draft", "MySQL emergency restart did not restore editable setup state");
    assert(afterRestart.payload.activeAssignment?.teamId === null && afterRestart.payload.activeAssignment?.status === "idle", "MySQL emergency restart did not clear the assignment");
    assert(afterRestart.payload.displaySelection?.publicationStatus === "idle", "MySQL emergency restart did not withdraw the group display");
    assert(afterRestart.payload.teams.find((team) => team.id === "GZ01")?.teamName === "MySQL Smoke Team", "MySQL emergency restart changed team information");
    assert(afterRestart.payload.teams.find((team) => team.id === "GZ01")?.appearanceOrder === gz01.appearanceOrder, "MySQL emergency restart changed draw order");
    assert(afterRestart.payload.accounts.some((account) => account.id === dynamicJudgeId), "MySQL emergency restart removed judge accounts");
    assert(Object.values(afterRestart.payload.entriesByJudge).every((entries) => !Object.keys(entries).some((teamId) => teamId.startsWith("GZ"))), "MySQL emergency restart left group score entries behind");

    console.log(`mysql smoke passed using ${smokePrefix} team, account, roster, entry, close, restart, and control tables`);
  } catch (error) {
    if (server?.output?.().trim()) console.error(server.output().trim());
    throw error;
  } finally {
    await stopServer(server?.child);
    await cleanupSmokeRows();
  }
}

await main();
