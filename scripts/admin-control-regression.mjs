import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { itemIds, itemMax } from "../shared/scoringRules.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const body = await response.text();
  return body ? JSON.parse(body) : {};
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { status: response.status, payload: await readJson(response) };
}

function authHeaders(token, headers = {}) {
  return { ...headers, Authorization: `Bearer ${token}` };
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited before ready: ${child.exitCode}`);
    try {
      const result = await requestJson(baseUrl, "/api/health");
      if (result.status === 200 && result.payload.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }
  throw new Error("server did not become ready");
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

async function login(baseUrl, username, password) {
  const result = await requestJson(baseUrl, "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, deviceId: `admin-control-regression-${username}` }),
  });
  assert(result.status === 200, `${username} login failed: ${result.status} ${result.payload.error ?? ""}`);
  assert(result.payload.token, `${username} login did not return a token`);
  return result.payload.token;
}

function fullScores() {
  return Object.fromEntries(itemIds.map((itemId) => [itemId, itemMax[itemId]]));
}

function createEntry(serverRevision = 0, submitted = true) {
  return {
    scores: fullScores(),
    submitted,
    updatedAt: "admin-control-regression",
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

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), "campus-final-admin-control-"));
  const dataDir = join(tempRoot, "data");
  const logDir = join(tempRoot, "logs");
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["contest-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CONTEST_DATA_DIR: dataDir,
      CONTEST_LOG_DIR: logDir,
      CONTEST_STORAGE: "file",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, child);
    const anonymousState = await requestJson(baseUrl, "/api/state");
    assert(anonymousState.status === 401, "anonymous callers must not read contest state");

    const adminToken = await login(baseUrl, "admin", "admin123");
    const judgeTokens = await Promise.all(
      ["001", "002", "003", "004", "005", "006", "007"].map((judgeId) => login(baseUrl, judgeId, judgeId)),
    );
    const state = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(state.status === 200, "admin state read failed");
    assert(Array.isArray(state.payload.teams) && state.payload.teams.length === 80, "default teams were not materialized");
    assert(Array.isArray(state.payload.accounts) && state.payload.accounts.length === 8, "default accounts were not materialized");
    assert(state.payload.activeAssignment?.status === "idle", "contest must start without an assignment");
    assert(state.payload.judgeRoster?.judgeIds?.length === 7, "default judge roster is incorrect");

    const initialJudgeWrite = await writeEntry(baseUrl, judgeTokens[0], "001", "GZ01", createEntry());
    assert(initialJudgeWrite.status === 409, "judge write without an assignment must be rejected");

    const configuredTeamIds = ["GZ01", "GZ02"];
    const savedSetup = await requestJson(baseUrl, "/api/competition-setup/gaozhi", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        teamIds: configuredTeamIds,
        judgeIds: ["001", "002", "003", "004", "005", "006", "007"],
        revision: state.payload.competitionSetup.groups.gaozhi.revision,
      }),
    });
    assert(savedSetup.status === 200, `competition setup save failed: ${savedSetup.payload.error ?? ""}`);

    const rankings = await requestJson(baseUrl, "/api/rankings?groupId=gaozhi", { headers: authHeaders(adminToken) });
    assert(rankings.status === 200, `rankings read failed: ${rankings.payload.error ?? ""}`);
    assert(
      JSON.stringify(rankings.payload.rankings.map((team) => team.id)) === JSON.stringify(configuredTeamIds),
      "rankings must include only teams selected for the competition",
    );

    const controlledScoreboard = await requestJson(baseUrl, "/api/scoreboard?control=1", { headers: authHeaders(adminToken) });
    assert(controlledScoreboard.status === 200, `controlled scoreboard read failed: ${controlledScoreboard.payload.error ?? ""}`);
    const scoreboardTeamIds = controlledScoreboard.payload.teamOptions
      .filter((team) => team.groupId === "gaozhi")
      .map((team) => team.id);
    assert(
      JSON.stringify(scoreboardTeamIds) === JSON.stringify(configuredTeamIds),
      `scoreboard team options must include only teams selected for the competition: ${scoreboardTeamIds.join(",")}`,
    );
    const unconfiguredPreview = await requestJson(baseUrl, "/api/scoreboard?control=1&teamId=GZ03", { headers: authHeaders(adminToken) });
    assert(unconfiguredPreview.status === 200, `unconfigured scoreboard preview failed: ${unconfiguredPreview.payload.error ?? ""}`);
    assert(!unconfiguredPreview.payload.displayTeam, "scoreboard must not preview a team outside the competition setup");

    const openedGroup = await requestJson(baseUrl, "/api/competition-setup/gaozhi/open", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ revision: savedSetup.payload.competitionSetup.groups.gaozhi.revision }),
    });
    assert(openedGroup.status === 200, `competition setup open failed: ${openedGroup.payload.error ?? ""}`);
    const openedRankings = await requestJson(baseUrl, "/api/rankings?groupId=gaozhi", { headers: authHeaders(adminToken) });
    assert(
      JSON.stringify(openedRankings.payload.rankings.map((team) => team.id)) === JSON.stringify(configuredTeamIds),
      "opened competition rankings must retain the configured team scope",
    );

    const dispatch = await requestJson(baseUrl, "/api/assignments/dispatch", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ01", revision: openedGroup.payload.activeAssignment.assignmentRevision }),
    });
    assert(dispatch.status === 200, `initial dispatch failed: ${dispatch.payload.error ?? ""}`);
    const firstAssignment = dispatch.payload.activeAssignment;
    assert(firstAssignment.teamId === "GZ01" && firstAssignment.status === "scoring", "initial assignment is malformed");
    assert(firstAssignment.rosterSnapshot.length === 7, "dispatch did not snapshot the judge roster");

    const createAccount = await requestJson(baseUrl, "/api/admin/judge-enrollments", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        username: "relief",
        displayName: "替补评委",
        password: "relief-2026",
        operationId: "regression-relief-enrollment",
        expectedRosterRevision: dispatch.payload.judgeRoster.revision,
        reason: "Regression future assignment enrollment",
      }),
    });
    assert(createAccount.status === 201, `judge enrollment failed: ${createAccount.payload.error ?? ""}`);
    const reliefId = createAccount.payload.account?.id;
    assert(reliefId, "created judge account did not return an id");
    assert(createAccount.payload.judgeRoster?.judgeIds?.length === 8, "future planned roster did not include the relief judge");
    const stateAfterEnrollment = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(stateAfterEnrollment.status === 200, "state refresh after judge enrollment failed");
    assert(
      stateAfterEnrollment.payload.activeAssignment?.teamId === firstAssignment.teamId &&
        stateAfterEnrollment.payload.activeAssignment?.assignmentRevision === firstAssignment.assignmentRevision &&
        stateAfterEnrollment.payload.activeAssignment?.rosterSnapshot?.length === 7,
      "current assignment snapshot changed after future enrollment",
    );
    assert(stateAfterEnrollment.payload.judgeRoster?.judgeIds?.length === 8, "refreshed planned roster did not retain the relief judge");
    let reliefToken = await login(baseUrl, "relief", "relief-2026");
    const malformedBearer = await requestJson(baseUrl, "/api/session", { headers: { Authorization: "Bearer not-a-valid-session-token" } });
    assert(malformedBearer.status === 401, "malformed bearer tokens must be rejected");
    const logoutRelief = await requestJson(baseUrl, "/api/logout", { method: "POST", headers: authHeaders(reliefToken) });
    assert(logoutRelief.status === 200, "logout failed");
    const loggedOutRelief = await requestJson(baseUrl, "/api/session", { headers: authHeaders(reliefToken) });
    assert(loggedOutRelief.status === 401, "logout must invalidate only that session token");
    reliefToken = await login(baseUrl, "relief", "relief-2026");

    const staleAssignmentWrite = await writeEntry(baseUrl, judgeTokens[0], "001", "GZ01", createEntry(), firstAssignment.assignmentRevision - 1);
    assert(staleAssignmentWrite.status === 409, "stale assignment writes must be rejected");
    const acceptedJudgeWrite = await writeEntry(baseUrl, judgeTokens[0], "001", "GZ01", createEntry(), firstAssignment.assignmentRevision);
    assert(acceptedJudgeWrite.status === 200 && acceptedJudgeWrite.payload.entry?.submitted, "current assignment write was rejected");

    const normalNextDispatch = await requestJson(baseUrl, "/api/assignments/dispatch", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ02", revision: firstAssignment.assignmentRevision }),
    });
    assert(normalNextDispatch.status === 409, "next team must be blocked while the roster is incomplete");
    const forcedDispatch = await requestJson(baseUrl, "/api/assignments/dispatch", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: "GZ02", force: true, revision: firstAssignment.assignmentRevision }),
    });
    assert(forcedDispatch.status === 200, `forced dispatch failed: ${forcedDispatch.payload.error ?? ""}`);
    const secondAssignment = forcedDispatch.payload.activeAssignment;
    assert(secondAssignment.teamId === "GZ02" && secondAssignment.assignmentRevision > firstAssignment.assignmentRevision, "forced dispatch did not advance version");
    assert(secondAssignment.rosterSnapshot.length === 8 && secondAssignment.rosterSnapshot.includes(reliefId), "next assignment did not use the updated planned roster");

    const oldTeamAfterDispatch = await writeEntry(baseUrl, judgeTokens[1], "002", "GZ01", createEntry(), firstAssignment.assignmentRevision);
    assert(oldTeamAfterDispatch.status === 409, "late write for a replaced assignment must be rejected");

    for (let index = 0; index < judgeTokens.length; index += 1) {
      const judgeId = String(index + 1).padStart(3, "0");
      const saved = await writeEntry(baseUrl, judgeTokens[index], judgeId, "GZ02", createEntry(), secondAssignment.assignmentRevision);
      assert(saved.status === 200 && saved.payload.entry?.submitted, `${judgeId} final submission failed`);
    }
    const reliefSaved = await writeEntry(baseUrl, reliefToken, reliefId, "GZ02", createEntry(), secondAssignment.assignmentRevision);
    assert(reliefSaved.status === 200 && reliefSaved.payload.entry?.submitted, "relief judge final submission failed");

    const finalState = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(finalState.status === 200, "final state read failed");
    assert(finalState.payload.activeAssignment?.status === "final", "all roster submissions must finalize the assignment");

    const publishFinal = await requestJson(baseUrl, "/api/display-selection", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        teamId: "GZ02",
        publicationStatus: "final",
        revision: finalState.payload.displaySelection.displayRevision,
      }),
    });
    assert(publishFinal.status === 200, `final publication failed: ${publishFinal.payload.error ?? ""}`);
    const displayed = await requestJson(baseUrl, "/api/scoreboard");
    assert(displayed.status === 200 && displayed.payload.displaySelection?.publicationStatus === "final", "scoreboard did not expose final publication");
    assert(displayed.payload.displayTeam?.id === "GZ02", "scoreboard did not expose the selected team");

    const submittedEntry = finalState.payload.entriesByJudge?.["001"]?.GZ02;
    const reopen = await writeEntry(
      baseUrl,
      adminToken,
      "001",
      "GZ02",
      { ...submittedEntry, submitted: false, clientUpdatedAt: Date.now() },
    );
    assert(reopen.status === 200 && !reopen.payload.entry?.submitted, "admin reopen did not succeed");
    const reviewedAdminState = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(reviewedAdminState.payload.displaySelection?.publicationStatus === "review_required", "reopen must invalidate the administrator display selection");
    const reviewedDisplay = await requestJson(baseUrl, "/api/scoreboard");
    assert(reviewedDisplay.payload.displaySelection?.publicationStatus === "idle", "public display must hide a result awaiting review");
    assert(!reviewedDisplay.payload.displayTeam, "review-required display must not expose stale final data");

    const disableRelief = await requestJson(baseUrl, `/api/accounts/${encodeURIComponent(reliefId)}`, {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "disabled", revision: createAccount.payload.account.revision }),
    });
    assert(disableRelief.status === 409, "planned-roster judge disable protection failed");

    const disableLastAdmin = await requestJson(baseUrl, "/api/accounts/admin", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "disabled", revision: finalState.payload.accounts.find((account) => account.id === "admin")?.revision ?? 0 }),
    });
    assert(disableLastAdmin.status === 409, "the last enabled administrator must be protected");

    await delay(20);
    const logFiles = await readdir(logDir);
    const auditText = (await Promise.all(logFiles.map((file) => readFile(join(logDir, file), "utf8")))).join("\n");
    assert(auditText.includes("assignment_dispatch"), "assignment dispatch was not audited");
    assert(auditText.includes("display_publish"), "display publication was not audited");
    assert(auditText.includes("admin_reopen_submission"), "admin reopen was not audited");
    assert(auditText.includes("itemScores") && auditText.includes('"content":"10.00"'), "audit log did not retain exact two-decimal score details");
    assert(!auditText.includes("admin123") && !auditText.includes("relief-2026"), "audit log exposed a password");
    assert(!auditText.includes('"token"') && !auditText.includes("Authorization"), "audit log exposed a session credential");

    assert(auditText.includes("judge_enrollment_create"), "future judge enrollment was not audited");
    console.log("admin control regression passed (future enrollment, assignment snapshots, account, display, and audit boundaries)");
  } catch (error) {
    if (serverOutput.trim()) console.error(serverOutput.trim());
    throw error;
  } finally {
    await stopServer(child);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
