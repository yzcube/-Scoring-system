import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const persistentSessionExpiresAt = Number.MAX_SAFE_INTEGER;

export function createPasswordService({ cost, r = 8, p, maxmem, concurrency }) {
  const verificationSalt = randomBytes(16).toString("base64url");
  let activeKdfs = 0;
  const waitingKdfs = [];

  async function runKdf(work) {
    if (activeKdfs >= concurrency) {
      await new Promise((resolve) => waitingKdfs.push(resolve));
    }
    activeKdfs += 1;
    try {
      return await work();
    } finally {
      activeKdfs -= 1;
      waitingKdfs.shift()?.();
    }
  }

  function isSupportedScryptParameters(inputCost, inputR, inputP) {
    return (
      Number.isSafeInteger(inputCost) &&
      inputCost >= 2 ** 14 &&
      inputCost <= 2 ** 17 &&
      (inputCost & (inputCost - 1)) === 0 &&
      Number.isSafeInteger(inputR) &&
      inputR >= 1 &&
      inputR <= 32 &&
      Number.isSafeInteger(inputP) &&
      inputP >= 1 &&
      inputP <= 8
    );
  }

  async function hashPassword(password) {
    const salt = randomBytes(16).toString("base64url");
    const derived = await runKdf(() => scrypt(password, salt, 64, { N: cost, r, p, maxmem }));
    return ["scrypt", "v1", cost, r, p, salt, derived.toString("base64url")].join("$");
  }

  async function verifyPassword(password, encodedHash) {
    const parts = String(encodedHash ?? "").split("$");
    const hasVersion = parts[1] === "v1";
    const [scheme, version, rawCost, rawR, rawP, salt, expected] = hasVersion
      ? parts
      : [parts[0], "legacy", parts[1], parts[2], parts[3], parts[4], parts[5]];
    const inputCost = Number(rawCost);
    const inputR = Number(rawR);
    const inputP = Number(rawP);
    if (scheme !== "scrypt" || !["v1", "legacy"].includes(version) || !isSupportedScryptParameters(inputCost, inputR, inputP) || !salt || !expected) {
      return false;
    }
    try {
      const expectedBuffer = Buffer.from(expected, "base64url");
      if (expectedBuffer.length !== 64) return false;
      const actual = await runKdf(() => scrypt(password, salt, expectedBuffer.length, { N: inputCost, r: inputR, p: inputP, maxmem }));
      return timingSafeEqual(expectedBuffer, actual);
    } catch {
      return false;
    }
  }

  async function consumePasswordVerificationCost(password) {
    await runKdf(() => scrypt(password, verificationSalt, 64, { N: cost, r, p, maxmem }));
  }

  return { hashPassword, verifyPassword, consumePasswordVerificationCost };
}

export function createSessionService({
  storageMode,
  getMysqlPool,
  mysqlId,
  mysqlSessionsTable,
  readState,
  getAccountById,
  HttpError,
  fileSessionPath = "",
  setAuditActor,
  clampInteger,
}) {
  const sessionsByTokenHash = new Map();
  const loginFailuresByUsername = new Map();
  const loginWindowMs = 10 * 60 * 1000;
  const loginAttemptLimit = 5;
  const loginLockMs = 10 * 60 * 1000;
  let fileSessionsLoaded = storageMode !== "file";
  let fileSessionLoadPromise = null;
  let fileSessionWriteQueue = Promise.resolve();

  function getBearerToken(request) {
    const distinctValues = request.headersDistinct?.authorization;
    if (Array.isArray(distinctValues) && distinctValues.length !== 1) return "";
    const header = request.headers.authorization;
    if (typeof header !== "string") return "";
    const match = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    return match?.[1] ?? "";
  }

  function getSessionTokenHash(token) {
    return createHash("sha256").update(token).digest();
  }

  function getSessionTokenKey(token) {
    return getSessionTokenHash(token).toString("base64url");
  }

  function sanitizePersistedFileSession(rawSession) {
    const tokenHash = typeof rawSession?.tokenHash === "string" && /^[A-Za-z0-9_-]{43}$/.test(rawSession.tokenHash)
      ? rawSession.tokenHash
      : "";
    const accountId = typeof rawSession?.accountId === "string" ? rawSession.accountId.slice(0, 80) : "";
    const sessionId = typeof rawSession?.sessionId === "string" && /^[a-f0-9]{32}$/.test(rawSession.sessionId)
      ? rawSession.sessionId
      : "";
    const authVersion = clampInteger(rawSession?.authVersion);
    if (!tokenHash || !accountId || !sessionId) return null;
    return {
      tokenHash,
      accountId,
      authVersion,
      sessionId,
      deviceId: typeof rawSession?.deviceId === "string" ? rawSession.deviceId.slice(0, 80) : "",
      expiresAt: null,
    };
  }

  async function ensureFileSessionsLoaded() {
    if (fileSessionsLoaded || storageMode !== "file") return;
    if (!fileSessionLoadPromise) {
      fileSessionLoadPromise = (async () => {
        if (!fileSessionPath) {
          fileSessionsLoaded = true;
          return;
        }
        try {
          const parsed = JSON.parse(await readFile(fileSessionPath, "utf8"));
          const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
          sessions.forEach((rawSession) => {
            const session = sanitizePersistedFileSession(rawSession);
            if (!session) return;
            sessionsByTokenHash.set(session.tokenHash, session);
          });
        } catch (error) {
          if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        fileSessionsLoaded = true;
      })();
    }
    await fileSessionLoadPromise;
  }

  async function persistFileSessions() {
    if (storageMode !== "file" || !fileSessionPath) return;
    const snapshot = JSON.stringify({
      version: 1,
      sessions: [...sessionsByTokenHash.entries()].map(([tokenHash, session]) => ({
        tokenHash,
        accountId: session.accountId,
        authVersion: session.authVersion,
        sessionId: session.sessionId,
        deviceId: session.deviceId,
      })),
    }, null, 2);
    fileSessionWriteQueue = fileSessionWriteQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(fileSessionPath), { recursive: true });
        const temporaryPath = `${fileSessionPath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, fileSessionPath);
        await chmod(fileSessionPath, 0o600);
      });
    await fileSessionWriteQueue;
  }

  async function createSession(account, deviceId) {
    await ensureFileSessionsLoaded();
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomBytes(16).toString("hex");
    const session = {
      accountId: account.id,
      authVersion: account.authVersion,
      sessionId,
      deviceId: typeof deviceId === "string" ? deviceId.slice(0, 80) : "",
      expiresAt: null,
    };
    if (storageMode === "mysql") {
      await getMysqlPool().query(
        `
          INSERT INTO ${mysqlId(mysqlSessionsTable)} (session_id, account_id, token_hash, auth_version, expires_at, device_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        [session.sessionId, session.accountId, getSessionTokenHash(token), session.authVersion, persistentSessionExpiresAt, session.deviceId],
      );
    } else {
      sessionsByTokenHash.set(getSessionTokenKey(token), session);
      await persistFileSessions();
    }
    return { token, sessionId, expiresAt: null };
  }

  async function getSession(request) {
    await ensureFileSessionsLoaded();
    const token = getBearerToken(request);
    if (!token) return null;
    if (storageMode === "mysql") {
      const [rows] = await getMysqlPool().query(
        `
          SELECT session_id, account_id, auth_version, expires_at, device_id
          FROM ${mysqlId(mysqlSessionsTable)}
          WHERE token_hash = ? AND revoked_at IS NULL
          LIMIT 1
        `,
        [getSessionTokenHash(token)],
      );
      const session = rows[0];
      if (!session) return null;
      return {
        accountId: session.account_id,
        authVersion: clampInteger(session.auth_version),
        sessionId: session.session_id,
        deviceId: session.device_id,
        expiresAt: null,
        token,
      };
    }
    const session = sessionsByTokenHash.get(getSessionTokenKey(token));
    return session ? { ...session, token } : null;
  }

  async function revokeSession(session) {
    if (!session) return;
    if (storageMode === "mysql") {
      await getMysqlPool().query(
        `UPDATE ${mysqlId(mysqlSessionsTable)} SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`,
        [Date.now(), session.sessionId],
      );
      return;
    }
    await ensureFileSessionsLoaded();
    sessionsByTokenHash.delete(getSessionTokenKey(session.token));
    await persistFileSessions();
  }

  async function assertQueuedSession(state, session, allowedRoles) {
    if (!session) return;
    if (storageMode === "mysql") {
      const [rows] = await getMysqlPool().query(
        `
          SELECT auth_version
          FROM ${mysqlId(mysqlSessionsTable)}
          WHERE session_id = ? AND revoked_at IS NULL
          LIMIT 1
        `,
        [session.sessionId],
      );
      if (!rows[0] || clampInteger(rows[0].auth_version) !== session.authVersion) {
        throw new HttpError(401, "登录已失效，请重新登录");
      }
    } else {
      await ensureFileSessionsLoaded();
      const current = sessionsByTokenHash.get(getSessionTokenKey(session.token));
      if (!current || current.sessionId !== session.sessionId || current.authVersion !== session.authVersion) {
        throw new HttpError(401, "登录已失效，请重新登录");
      }
    }
    const account = getAccountById(state, session.accountId);
    if (!account || account.status !== "active" || account.authVersion !== session.authVersion) {
      await revokeSession(session).catch(() => {});
      throw new HttpError(401, "登录已失效，请重新登录");
    }
    if (allowedRoles.length && !allowedRoles.includes(account.role)) {
      throw new HttpError(403, "当前账号无权执行该操作");
    }
  }

  async function requireSession(request, allowedRoles = []) {
    const session = await getSession(request);
    if (!session) {
      if (request.audit) request.audit.outcome = "unauthorized";
      throw new HttpError(401, "登录已失效，请重新登录");
    }
    const state = await readState();
    const account = getAccountById(state, session.accountId);
    if (!account || account.status !== "active" || account.authVersion !== session.authVersion) {
      await revokeSession(session).catch(() => {});
      if (request.audit) request.audit.outcome = "session_invalidated";
      throw new HttpError(401, "登录已失效，请重新登录");
    }
    if (allowedRoles.length && !allowedRoles.includes(account.role)) {
      if (request.audit) request.audit.outcome = "forbidden";
      setAuditActor(request, account);
      throw new HttpError(403, "当前账号无权执行该操作");
    }
    setAuditActor(request, account);
    return { ...session, account, state };
  }

  function getLoginFailureState(username) {
    const current = loginFailuresByUsername.get(username);
    if (!current) return { attempts: [], blockedUntil: 0 };
    const now = Date.now();
    const attempts = current.attempts.filter((timestamp) => now - timestamp < loginWindowMs);
    const next = { attempts, blockedUntil: current.blockedUntil > now ? current.blockedUntil : 0 };
    loginFailuresByUsername.set(username, next);
    return next;
  }

  function assertLoginNotLimited(username) {
    const state = getLoginFailureState(username);
    if (state.blockedUntil > Date.now()) throw new HttpError(429, "登录尝试过于频繁，请稍后再试");
  }

  function recordFailedLogin(username) {
    const state = getLoginFailureState(username);
    state.attempts.push(Date.now());
    if (state.attempts.length >= loginAttemptLimit) state.blockedUntil = Date.now() + loginLockMs;
    loginFailuresByUsername.set(username, state);
  }

  function clearFailedLogins(username) {
    loginFailuresByUsername.delete(username);
  }

  function getActiveSessionCount() {
    return storageMode === "mysql" ? 0 : sessionsByTokenHash.size;
  }

  return {
    assertLoginNotLimited,
    assertQueuedSession,
    clearFailedLogins,
    createSession,
    getActiveSessionCount,
    getSession,
    recordFailedLogin,
    requireSession,
    revokeSession,
  };
}
