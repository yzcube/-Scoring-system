export function createSessionApiRoutes({ runtime, storage, http, auth, state, presentation }) {
  const { storageMode, isShuttingDown, getLanUrls } = runtime;
  const { checkStorageHealth } = storage;
  const { readJsonBody, sendJson, HttpError } = http;
  const {
    normalizeUsername,
    assertLoginNotLimited,
    verifyPassword,
    consumePasswordVerificationCost,
    recordFailedLogin,
    clearFailedLogins,
    createSession,
    publicAccount,
    setAuditActor,
    requireSession,
    getSession,
  } = auth;
  const { readState, getAccountById, queueSessionRevocation } = state;
  const { getScoreboardPayload, getRankingsPayload, getAdminStatePayload, getJudgeStatePayload } = presentation;

  return async function handleSessionApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/health") {
      request.audit.action = "health_check";
      const healthDetails = {
        storage: storageMode,
        serverTime: new Date().toISOString(),
        lanUrls: getLanUrls(),
      };
      if (isShuttingDown()) {
        request.audit.outcome = "shutting_down";
        sendJson(response, 503, { ok: false, status: "shutting_down", ...healthDetails });
        return true;
      }
      try {
        await checkStorageHealth();
      } catch {
        request.audit.outcome = "storage_unavailable";
        sendJson(response, 503, { ok: false, status: "storage_unavailable", ...healthDetails });
        return true;
      }
      request.audit.outcome = "ok";
      sendJson(response, 200, { ok: true, status: "ok", ...healthDetails });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      request.audit.action = "login";
      const body = await readJsonBody(request);
      const username = normalizeUsername(body.username);
      request.audit.details = { username };
      assertLoginNotLimited(username || "unknown");
      const state = await readState();
      const account = state.accounts.find((item) => item.username === username);
      const password = String(body.password ?? "");
      const passwordMatches = account ? await verifyPassword(password, account.passwordHash) : (await consumePasswordVerificationCost(password), false);
      if (!account || account.status !== "active" || !passwordMatches) {
        recordFailedLogin(username || "unknown");
        request.audit.outcome = "rejected";
        throw new HttpError(401, "账号或密码不正确");
      }
      clearFailedLogins(username);
      const session = await createSession(account, body.deviceId);
      setAuditActor(request, account);
      request.audit.outcome = "created";
      sendJson(response, 200, {
        ok: true,
        account: publicAccount(account),
        token: session.token,
        expiresAt: session.expiresAt,
        serverTime: new Date().toISOString(),
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      request.audit.action = "session_check";
      const session = await requireSession(request);
      request.audit.outcome = "valid";
      sendJson(response, 200, { ok: true, account: publicAccount(session.account), serverTime: new Date().toISOString() });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/session/clone") {
      request.audit.action = "session_clone";
      const currentSession = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const clonedSession = await createSession(currentSession.account, body.deviceId);
      request.audit.outcome = "created";
      request.audit.details = { destination: "admin_module_tab" };
      sendJson(response, 200, {
        ok: true,
        token: clonedSession.token,
        expiresAt: clonedSession.expiresAt,
        serverTime: new Date().toISOString(),
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      request.audit.action = "logout";
      const session = await getSession(request);
      if (session) {
        const state = await readState();
        setAuditActor(request, getAccountById(state, session.accountId));
        await queueSessionRevocation(session);
        request.audit.outcome = "deleted";
      } else {
        request.audit.outcome = "no_active_session";
      }
      sendJson(response, 200, { ok: true, serverTime: new Date().toISOString() });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/scoreboard") {
      request.audit.action = "scoreboard_read";
      const controller = url.searchParams.get("control") === "1";
      const state = controller
        ? (await requireSession(request, ["admin"])).state
        : await readState();
      request.audit.outcome = "ok";
      const payload = getScoreboardPayload(
        state,
        controller ? url.searchParams.get("teamId") : "",
        { controller },
      );
      const publicSelectionVisible = controller || Boolean(payload.displayTeam);
      sendJson(response, 200, {
        ok: true,
        serverTime: new Date().toISOString(),
        ...payload,
        displaySelection: publicSelectionVisible
          ? payload.displaySelection
          : { teamId: null, publicationStatus: "idle", displayRevision: 0, publishedAt: "", updatedAt: "" },
        selectedTeam: publicSelectionVisible ? payload.selectedTeam : null,
        selectedTeamId: publicSelectionVisible ? payload.selectedTeamId : null,
        teamOptions: controller ? payload.teamOptions : [],
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/rankings") {
      request.audit.action = "rankings_read";
      const session = await requireSession(request, ["admin"]);
      request.audit.outcome = "ok";
      sendJson(response, 200, { ok: true, serverTime: new Date().toISOString(), ...getRankingsPayload(session.state, url.searchParams.get("groupId")) });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      request.audit.action = "state_read";
      const session = await requireSession(request, ["admin", "judge"]);
      request.audit.outcome = "ok";
      const payload = session.account.role === "admin" ? getAdminStatePayload(session.state, session.account) : getJudgeStatePayload(session.state, session.account.id);
      sendJson(response, 200, { ok: true, serverTime: new Date().toISOString(), ...payload });
      return true;
    }

    return false;
  };
}
