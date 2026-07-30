import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionService } from "./auth-session.mjs";

class TestHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createRequest(token) {
  return {
    headers: { authorization: `Bearer ${token}` },
    headersDistinct: { authorization: [`Bearer ${token}`] },
    audit: {},
  };
}

function createFileService(sessionFile, stateRef) {
  return createSessionService({
    storageMode: "file",
    getMysqlPool: () => null,
    mysqlId: (value) => value,
    mysqlSessionsTable: "sessions",
    readState: async () => stateRef.current,
    getAccountById: (state, accountId) => state.accounts.find((account) => account.id === accountId),
    HttpError: TestHttpError,
    fileSessionPath: sessionFile,
    setAuditActor: () => {},
    clampInteger: (value) => Math.max(0, Math.trunc(Number(value) || 0)),
  });
}

test("file sessions remain valid across service restarts until explicitly revoked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contest-sessions-"));
  const sessionFile = join(directory, "sessions.json");
  const account = { id: "admin", username: "admin", role: "admin", status: "active", authVersion: 1 };
  const stateRef = { current: { accounts: [account] } };
  try {
    const firstService = createFileService(sessionFile, stateRef);
    const created = await firstService.createSession(account, "display-control");
    assert.equal(created.expiresAt, null);

    const persisted = await readFile(sessionFile, "utf8");
    assert.equal(persisted.includes(created.token), false, "the raw bearer token must never be persisted");
    assert.match(persisted, /"tokenHash"/);

    const restartedService = createFileService(sessionFile, stateRef);
    const restored = await restartedService.getSession(createRequest(created.token));
    assert.equal(restored?.accountId, account.id);
    assert.equal(restored?.expiresAt, null);
    assert.equal((await restartedService.requireSession(createRequest(created.token), ["admin"])).account.id, account.id);

    await restartedService.revokeSession(restored);
    const afterLogoutService = createFileService(sessionFile, stateRef);
    assert.equal(await afterLogoutService.getSession(createRequest(created.token)), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("account auth-version changes still invalidate persistent sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contest-session-version-"));
  const sessionFile = join(directory, "sessions.json");
  const account = { id: "001", username: "001", role: "judge", status: "active", authVersion: 1 };
  const stateRef = { current: { accounts: [account] } };
  try {
    const service = createFileService(sessionFile, stateRef);
    const created = await service.createSession(account, "judge-tablet");
    stateRef.current = { accounts: [{ ...account, authVersion: 2 }] };
    await assert.rejects(
      service.requireSession(createRequest(created.token), ["judge"]),
      (error) => error instanceof TestHttpError && error.status === 401,
    );
    const restartedService = createFileService(sessionFile, stateRef);
    assert.equal(await restartedService.getSession(createRequest(created.token)), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mysql sessions ignore legacy expiry timestamps but still require non-revoked rows", async () => {
  const queries = [];
  const account = { id: "admin", username: "admin", role: "admin", status: "active", authVersion: 3 };
  const pool = {
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("INSERT INTO")) return [{ affectedRows: 1 }];
      if (String(sql).includes("SELECT session_id")) {
        return [[{
          session_id: "0123456789abcdef0123456789abcdef",
          account_id: account.id,
          auth_version: account.authVersion,
          expires_at: 1,
          device_id: "admin-console",
        }]];
      }
      if (String(sql).includes("SELECT auth_version")) return [[{ auth_version: account.authVersion }]];
      return [{ affectedRows: 1 }];
    },
  };
  const service = createSessionService({
    storageMode: "mysql",
    getMysqlPool: () => pool,
    mysqlId: (value) => value,
    mysqlSessionsTable: "sessions",
    readState: async () => ({ accounts: [account] }),
    getAccountById: (state, accountId) => state.accounts.find((item) => item.id === accountId),
    HttpError: TestHttpError,
    setAuditActor: () => {},
    clampInteger: (value) => Math.max(0, Math.trunc(Number(value) || 0)),
  });

  const created = await service.createSession(account, "admin-console");
  const insert = queries.find((query) => query.sql.includes("INSERT INTO"));
  assert.equal(insert.params[4], Number.MAX_SAFE_INTEGER);
  assert.equal(created.expiresAt, null);

  const restored = await service.getSession(createRequest(created.token));
  assert.equal(restored.accountId, account.id);
  await service.assertQueuedSession({ accounts: [account] }, restored, ["admin"]);
  const sessionQueries = queries.filter((query) => query.sql.includes("SELECT"));
  assert.equal(sessionQueries.some((query) => query.sql.includes("expires_at >")), false);
});
