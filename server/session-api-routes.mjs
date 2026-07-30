export function createSessionApiRoutes({ runtime, storage, http, auth, state, presentation, resultExport, input }) {
  const { storageMode, isShuttingDown, getLanUrls } = runtime;
  const { checkStorageHealth } = storage;
  const { readJsonBody, sendJson, sendBinary, HttpError } = http;
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
  const { getProjectionPayload, getScoreboardPayload, getRankingsPayload, getAdminStatePayload, getJudgeStatePayload } = presentation;
  const { getFinalResultExportData, buildFinalResultWorkbook, buildResultExportFilename, spreadsheetContentType } = resultExport;
  const { isKnownGroupId } = input;

  function isLiveProjectionRequest(request) {
    try {
      const referer = new URL(String(request.headers.referer || ""));
      return referer.searchParams.get("live") === "1";
    } catch {
      return false;
    }
  }

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

    if (request.method === "GET" && url.pathname === "/api/projection") {
      request.audit.action = "projection_read";
      const projectionState = await readState();
      request.audit.outcome = "ok";
      sendJson(response, 200, {
        ok: true,
        serverTime: new Date().toISOString(),
        ...getProjectionPayload(projectionState),
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/scoreboard") {
      request.audit.action = "scoreboard_read";
      const controllerRequested = url.searchParams.get("control") === "1";
      const controller = controllerRequested && !isLiveProjectionRequest(request);
      let state;
      if (controller) {
        try {
          state = (await requireSession(request, ["admin"])).state;
        } catch (error) {
          if (![401, 403].includes(error?.status)) throw error;
          const projectionState = await readState();
          request.audit.actor = null;
          request.audit.outcome = "public_fallback";
          sendJson(response, 200, {
            ok: true,
            serverTime: new Date().toISOString(),
            ...getProjectionPayload(projectionState),
          });
          return true;
        }
      } else {
        state = await readState();
      }
      request.audit.outcome = "ok";
      if (!controller) {
        sendJson(response, 200, {
          ok: true,
          serverTime: new Date().toISOString(),
          ...getProjectionPayload(state),
        });
        return true;
      }
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
          : { teamId: null, publicationStatus: "idle", projectionView: "slogan", rankingGroupId: "gaozhi", displayRevision: 0, publishedAt: "", updatedAt: "", rankingAnimationEnabled: false, rankingTransition: null },
        selectedTeam: publicSelectionVisible ? payload.selectedTeam : null,
        selectedTeamId: publicSelectionVisible ? payload.selectedTeamId : null,
        teamOptions: controller ? payload.teamOptions : [],
        rankingSnapshot: controller ? payload.rankingSnapshot : [],
        rankingTransition: publicSelectionVisible ? payload.rankingTransition : null,
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/rankings") {
      request.audit.action = "rankings_read";
      const requestedGroupId = String(url.searchParams.get("groupId") ?? "").trim();
      let rankingState;
      let rankingGroupId = requestedGroupId;
      try {
        rankingState = (await requireSession(request, ["admin"])).state;
        request.audit.outcome = "authenticated";
      } catch (error) {
        if (![401, 403].includes(error?.status)) throw error;
        rankingState = await readState();
        const publishedGroupId = rankingState.displaySelection?.projectionView === "rankings"
          ? String(rankingState.displaySelection.rankingGroupId ?? "")
          : "";
        const requestedPublishedGroup = rankingGroupId || publishedGroupId;
        if (!isKnownGroupId(publishedGroupId) || requestedPublishedGroup !== publishedGroupId) {
          request.audit.actor = null;
          request.audit.outcome = "not_published";
          throw new HttpError(403, "当前排名未发布到大屏");
        }
        rankingGroupId = publishedGroupId;
        request.audit.actor = null;
        request.audit.outcome = "public_projection";
      }
      sendJson(response, 200, {
        ok: true,
        serverTime: new Date().toISOString(),
        ...getRankingsPayload(rankingState, rankingGroupId),
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/admin/results.xlsx") {
      request.audit.action = "results_export";
      const session = await requireSession(request, ["admin"]);
      const groupId = String(url.searchParams.get("groupId") ?? "").trim();
      if (!isKnownGroupId(groupId)) throw new HttpError(400, "请选择有效的导出组别");
      const exportData = getFinalResultExportData(session.state, groupId);
      if (!exportData.rows.length) throw new HttpError(409, "该组暂无最终成绩可导出");
      const createdAt = new Date();
      const workbook = buildFinalResultWorkbook(exportData, { createdAt });
      const filename = buildResultExportFilename(exportData.groupLabel, createdAt);
      request.audit.target = { groupId };
      request.audit.details = {
        groupLabel: exportData.groupLabel,
        exportedTeamCount: exportData.rows.length,
        judgeColumnCount: exportData.judgeColumnCount,
        finalOnly: true,
      };
      request.audit.outcome = "downloaded";
      sendBinary(response, 200, workbook, { contentType: spreadsheetContentType, filename });
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
