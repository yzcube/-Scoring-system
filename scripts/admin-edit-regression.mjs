import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited before ready: ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache: "no-store" });
      if (response.ok) return;
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
    body: JSON.stringify({ username, password, deviceId: `admin-edit-regression-${username}` }),
  });
  assert(result.status === 200, `${username} login failed: ${result.status} ${result.payload.error ?? ""}`);
  return result.payload.token;
}

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "contest-admin-edit-"));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["contest-server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CONTEST_DATA_DIR: dataDir },
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
    const adminToken = await login(baseUrl, "admin", "admin123");
    const judgeToken = await login(baseUrl, "001", "001");
    const initial = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(initial.status === 200, `initial admin state returned ${initial.status}`);
    assert(Array.isArray(initial.payload.teams) && initial.payload.teams.length === 80, "teams were not materialized as entities");
    assert(!("candidateOverrides" in initial.payload), "legacy candidate overrides leaked into the new admin payload");
    assert(!JSON.stringify(initial.payload).includes("passwordHash"), "admin state exposed password hashes");

    const gz01 = initial.payload.teams.find((team) => team.id === "GZ01");
    assert(gz01, "GZ01 is missing");
    const savedTeamName = "回归测试队伍";
    const savedProjectName = "回归测试项目";
    const save = await requestJson(baseUrl, "/api/teams/GZ01", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamName: savedTeamName, projectName: savedProjectName, revision: gz01.revision }),
    });
    assert(save.status === 200, `team edit returned ${save.status}: ${save.payload.error ?? ""}`);
    assert(save.payload.team?.teamName === savedTeamName, "team edit did not return the new name");
    assert(save.payload.team?.projectName === savedProjectName, "team edit did not return the new project name");

    const gz02 = initial.payload.teams.find((team) => team.id === "GZ02");
    const duplicateRegistration = await requestJson(baseUrl, "/api/teams/GZ02", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ registrationNumber: gz01.registrationNumber, revision: gz02.revision }),
    });
    assert(duplicateRegistration.status === 409, "duplicate registration numbers must be rejected");

    const oversizedRegistration = await requestJson(baseUrl, "/api/teams/GZ01", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ registrationNumber: "x".repeat(65), revision: save.payload.team.revision }),
    });
    assert(oversizedRegistration.status === 400, "oversized registration numbers must be rejected");

    const judgeEdit = await requestJson(baseUrl, "/api/teams/GZ01", {
      method: "PUT",
      headers: authHeaders(judgeToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamName: "评委非法编辑", revision: save.payload.team.revision }),
    });
    assert(judgeEdit.status === 403, `judge team edit should be forbidden, got ${judgeEdit.status}`);

    const malformed = await requestJson(baseUrl, "/api/teams/GZ01", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: "{",
    });
    assert(malformed.status === 400, `malformed request should return 400, got ${malformed.status}`);

    const oversized = await requestJson(baseUrl, "/api/teams/GZ01", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamName: "x".repeat(70 * 1024), revision: save.payload.team.revision }),
    });
    assert(oversized.status === 413, `oversized request should return 413, got ${oversized.status}`);

    const create = await requestJson(baseUrl, "/api/teams", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ groupId: "zhongzhi", teamName: "新增回归队伍", projectName: "新增回归项目" }),
    });
    assert(create.status === 201, `team creation returned ${create.status}: ${create.payload.error ?? ""}`);
    const createdTeam = create.payload.team;
    assert(createdTeam?.id && createdTeam.groupId === "zhongzhi", "new team did not receive a persistent group-bound identity");

    const afterCreate = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    const zhongzhiOrder = afterCreate.payload.teams.filter((team) => team.groupId === "zhongzhi").sort((left, right) => left.appearanceOrder - right.appearanceOrder).map((team) => team.id);
    assert(zhongzhiOrder.at(-1) === createdTeam.id, "new team was not appended to its group order");
    const reordered = [createdTeam.id, ...zhongzhiOrder.filter((id) => id !== createdTeam.id)];
    const orderSave = await requestJson(baseUrl, "/api/team-order/zhongzhi", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ orderedTeamIds: reordered, revision: afterCreate.payload.teamOrderRevisionByGroup.zhongzhi }),
    });
    assert(orderSave.status === 200, `team order save returned ${orderSave.status}: ${orderSave.payload.error ?? ""}`);
    assert(orderSave.payload.teams?.[0]?.id === createdTeam.id, "team order update was not persisted");

    const retrySameOrder = await requestJson(baseUrl, "/api/team-order/zhongzhi", {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ orderedTeamIds: reordered, revision: orderSave.payload.teamOrderRevisionByGroup.zhongzhi }),
    });
    assert(retrySameOrder.status === 200, `same team order retry returned ${retrySameOrder.status}: ${retrySameOrder.payload.error ?? ""}`);
    assert(
      retrySameOrder.payload.teamOrderRevisionByGroup.zhongzhi === orderSave.payload.teamOrderRevisionByGroup.zhongzhi,
      "same team order retry must not advance the order revision",
    );

    const archived = await requestJson(baseUrl, `/api/teams/${encodeURIComponent(createdTeam.id)}`, {
      method: "PUT",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ status: "withdrawn", revision: orderSave.payload.teams[0].revision }),
    });
    assert(archived.status === 200 && archived.payload.team?.status === "withdrawn", "team withdrawal did not persist");
    const dispatchWithdrawn = await requestJson(baseUrl, "/api/assignments/dispatch", {
      method: "POST",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ teamId: createdTeam.id, revision: afterCreate.payload.activeAssignment.assignmentRevision }),
    });
    assert(dispatchWithdrawn.status === 409, "withdrawn team should not be dispatchable");

    const deleted = await requestJson(baseUrl, `/api/teams/${encodeURIComponent(createdTeam.id)}`, {
      method: "DELETE",
      headers: authHeaders(adminToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ revision: archived.payload.team.revision }),
    });
    assert(deleted.status === 200 && deleted.payload.deletedTeamId === createdTeam.id, "team delete did not persist");
    assert(!deleted.payload.teams.some((team) => team.id === createdTeam.id), "deleted team remained in the group list");

    const judgeState = await requestJson(baseUrl, "/api/state", { headers: authHeaders(judgeToken) });
    assert(judgeState.status === 200, "judge state read failed");
    assert(Array.isArray(judgeState.payload.teams) && judgeState.payload.teams.length <= 1, "judge state exposed independent team navigation data");
    assert(!("accounts" in judgeState.payload), "judge state exposed account-management data");

    const persisted = await requestJson(baseUrl, "/api/state", { headers: authHeaders(adminToken) });
    assert(!persisted.payload.teams.some((team) => team.id === createdTeam.id), "deleted team returned after a fresh state read");
    const savedTeam = persisted.payload.teams.find((team) => team.id === "GZ01");
    assert(savedTeam?.teamName === savedTeamName && savedTeam.projectName === savedProjectName, "team information was not retained after a fresh state read");

    console.log("admin edit regression passed (team entity CRUD, order persistence, permissions, and judge payload boundaries)");
  } catch (error) {
    if (serverOutput.trim()) console.error(serverOutput.trim());
    throw error;
  } finally {
    await stopServer(child);
    await rm(dataDir, { recursive: true, force: true });
  }
}

await main();
