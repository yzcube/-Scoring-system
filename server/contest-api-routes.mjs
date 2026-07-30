import {
  formatCents,
  getEntryTotalCents,
  itemIds,
  itemTitles,
  sanitizeEntry,
  scoreScale,
} from "../shared/scoringRules.js";
import {
  advanceDisplayRankingTransition,
  advanceDisplayToNextTeam,
  advanceDisplayToPreviousTeam,
  closeCompetitionGroup,
  dispatchAssignment,
  enrollJudgeForFutureAssignments,
  finishCompetitionFirstHalf,
  getAccountById,
  getJudgeAccounts,
  getTeamById,
  invalidateDisplayForReview,
  openCompetitionGroup,
  publishDisplaySelection,
  reopenCompetitionGroupForSetup,
  replaceAssignmentJudge,
  saveCompetitionGroupSetup,
  saveCompetitionSecondHalf,
  showDisplayRankings,
  openCompetitionSecondHalf,
  startJudgeRescore,
  updateDisplayRankingAnimation,
  updatePlannedRoster,
  writeScoreEntry,
} from "../domain/contestControl.js";

function getAuditScore(value) {
  return value === "" || value === undefined || value === null
    ? ""
    : formatCents(Math.round(Number(value) * scoreScale));
}

function getEntryAuditSnapshot(entry) {
  const sanitized = sanitizeEntry(entry);
  return {
    submitted: sanitized.submitted,
    total: formatCents(getEntryTotalCents(sanitized)),
    serverRevision: sanitized.serverRevision,
    itemScores: Object.fromEntries(
      itemIds.map((id) => [id, getAuditScore(sanitized.scores[id])]),
    ),
  };
}

function getChangedScores(previousEntry, nextEntry) {
  const previous = sanitizeEntry(previousEntry);
  const next = sanitizeEntry(nextEntry);
  return itemIds
    .filter(
      (id) =>
        getAuditScore(previous.scores[id]) !== getAuditScore(next.scores[id]),
    )
    .map((id) => ({
      id,
      title: itemTitles[id],
      from: getAuditScore(previous.scores[id]),
      to: getAuditScore(next.scores[id]),
    }));
}

export function createContestApiRoutes({
  http,
  auth,
  writes,
  input,
  ids,
  teams,
  presentation,
  security = {},
}) {
  const { readJsonBody, sendJson, HttpError } = http;
  const { requireSession, hashPassword, verifyPassword } = auth;
  const { updateState, applyContestControl } = writes;
  const {
    normalizeId,
    normalizeUsername,
    cleanText,
    clampInteger,
    sanitizeGroupId,
    isKnownGroupId,
  } = input;
  const { createTeamId, createAccountId } = ids;
  const { getOrderedTeams, validateTeamOrder, updateTeamOrder, isSameIdOrder } =
    teams;
  const {
    publicAccount,
    publicTeam,
    publicAssignment,
    publicJudgeAssignment = (state) => publicAssignment(state.activeAssignment),
    publicDisplaySelection,
    publicJudgeRoster,
    getScoreboardPayload,
  } = presentation;
  const { requireAdminPasswordRotation = false } = security;

  function requireExpectedRevision(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new HttpError(400, "请求版本无效，请刷新后重试");
    }
    return value;
  }

  function getRegistrationNumber(value, fallback = "") {
    if (value === undefined || value === null) return fallback;
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > 64) throw new HttpError(400, "报名编号不能超过 64 个字符");
    return text;
  }

  function assertRegistrationNumberAvailable(state, teamId, registrationNumber) {
    if (!registrationNumber) return;
    const conflict = state.teams.find((team) => team.id !== teamId && team.registrationNumber === registrationNumber);
    if (conflict) throw new HttpError(409, "报名编号已绑定其他队伍，请先核对编号");
  }

  function assertPublicProjectionMutationRequest(request) {
    const contentType = String(request.headers["content-type"] ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new HttpError(415, "大屏控制请求必须使用 JSON");
    }

    const fetchSite = String(request.headers["sec-fetch-site"] ?? "").trim().toLowerCase();
    if (fetchSite && fetchSite !== "same-origin") {
      throw new HttpError(403, "拒绝跨站大屏控制请求");
    }

    const origin = String(request.headers.origin ?? "").trim();
    if (!origin) return;
    try {
      const originUrl = new URL(origin);
      const requestHost = String(request.headers.host ?? "").trim().toLowerCase();
      if (
        !["http:", "https:"].includes(originUrl.protocol) ||
        !requestHost ||
        originUrl.host.toLowerCase() !== requestHost
      ) {
        throw new Error("origin mismatch");
      }
    } catch {
      throw new HttpError(403, "拒绝跨站大屏控制请求");
    }
  }

  return async function handleContestApi(request, response, url) {
    if (request.method === "POST" && url.pathname === "/api/projection/advance") {
      request.audit.action = "projection_advance";
      assertPublicProjectionMutationRequest(request);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) => advanceDisplayRankingTransition(state, {
          transitionRevision: body.transitionRevision,
        }),
        null,
        [],
      );
      request.audit.target = { transitionRevision: body.transitionRevision };
      request.audit.details = {
        operation: "projection_ranking_advance",
        changed: outcome.changed,
        displayRevision: nextState.displaySelection.displayRevision,
      };
      request.audit.outcome = outcome.changed ? "advanced" : "already_advanced";
      sendJson(response, 200, {
        ok: true,
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/projection/next") {
      request.audit.action = "projection_next_team";
      assertPublicProjectionMutationRequest(request);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) => advanceDisplayToNextTeam(state, {
          expectedRevision: body.displayRevision,
        }),
        null,
        [],
      );
      request.audit.target = {
        fromTeamId: outcome.fromTeamId,
        toTeamId: outcome.toTeamId,
      };
      request.audit.details = {
        operation: "projection_team_advance",
        changed: outcome.changed,
        reason: outcome.reason,
        publicationStatus: outcome.publicationStatus,
        displayRevision: nextState.displaySelection.displayRevision,
      };
      request.audit.outcome = outcome.changed ? "advanced" : "end_of_group";
      sendJson(response, 200, {
        ok: true,
        changed: outcome.changed,
        reason: outcome.reason,
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/projection/previous") {
      request.audit.action = "projection_previous_team";
      assertPublicProjectionMutationRequest(request);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) => advanceDisplayToPreviousTeam(state, {
          expectedRevision: body.displayRevision,
        }),
        null,
        [],
      );
      request.audit.target = {
        fromTeamId: outcome.fromTeamId,
        toTeamId: outcome.toTeamId,
      };
      request.audit.details = {
        operation: "projection_team_previous",
        changed: outcome.changed,
        reason: outcome.reason,
        publicationStatus: outcome.publicationStatus,
        displayRevision: nextState.displaySelection.displayRevision,
      };
      request.audit.outcome = outcome.changed ? "rewound" : "start_of_group";
      sendJson(response, 200, {
        ok: true,
        changed: outcome.changed,
        reason: outcome.reason,
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/judge-rescores"
    ) {
      request.audit.action = "judge_rescore_start";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const teamId = normalizeId(body.teamId, 16);
      const judgeId = normalizeId(body.judgeId);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          startJudgeRescore(state, {
            teamId,
            judgeId,
            mode: body.mode,
            expectedEntryRevision: body.expectedEntryRevision,
            reason: body.reason,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { teamId, judgeId };
      request.audit.details = {
        operation: "start_targeted_historical_judge_rescore",
        mode: outcome.mode,
        reason: outcome.reason,
        previous: getEntryAuditSnapshot(outcome.previousEntry),
        saved: getEntryAuditSnapshot(outcome.persistedEntry),
        changedScores: getChangedScores(
          outcome.previousEntry,
          outcome.persistedEntry,
        ),
        grantRevision: outcome.grant.revision,
        rescoreRevision: nextState.activeAssignment.rescoreRevision,
        globalAssignmentRevision:
          nextState.activeAssignment.assignmentRevision,
        currentTeamId: nextState.activeAssignment.teamId,
        globalAssignmentPreserved: true,
        affectedJudgeOnly: true,
        assignmentScope: "historical_rescore",
        displayInvalidated: outcome.displayInvalidated,
      };
      request.audit.outcome = "assigned";
      sendJson(response, 200, {
        ok: true,
        entry: outcome.persistedEntry,
        activeAssignment: publicAssignment(nextState.activeAssignment),
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/competition-setup/") &&
      url.pathname.endsWith("/first-half/finish")
    ) {
      request.audit.action = "competition_first_half_finish";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 6) return false;
      const groupId = sanitizeGroupId(pathParts[3]);
      if (!isKnownGroupId(pathParts[3])) throw new HttpError(404, "未知组别");
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          finishCompetitionFirstHalf(state, {
            groupId,
            expectedRevision: body.revision,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId, half: "first" };
      request.audit.details = {
        operation: "finish_first_half",
        teamCount: outcome.completedSetup.halves.first.teamIds.length,
        cumulativeTeamCount: outcome.completedSetup.teamIds.length,
        scoresPreserved: true,
        displayHistoryPreserved: true,
      };
      request.audit.outcome = "intermission";
      sendJson(response, 200, {
        ok: true,
        competitionSetup: nextState.competitionSetup,
        judgeRoster: publicJudgeRoster(nextState.judgeRoster),
        activeAssignment: publicAssignment(nextState.activeAssignment),
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (
      request.method === "PUT" &&
      url.pathname.startsWith("/api/competition-setup/") &&
      url.pathname.endsWith("/second-half")
    ) {
      request.audit.action = "competition_second_half_setup_write";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 5) return false;
      const groupId = sanitizeGroupId(pathParts[3]);
      if (!isKnownGroupId(pathParts[3])) throw new HttpError(404, "未知组别");
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          saveCompetitionSecondHalf(state, {
            groupId,
            teamIds: body.teamIds,
            expectedRevision: body.revision,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId, half: "second" };
      request.audit.details = {
        operation: "save_second_half_setup",
        previousTeamCount: outcome.previousSetup.halves.second.teamIds.length,
        nextTeamCount: outcome.nextSetup.halves.second.teamIds.length,
        cumulativeTeamCount: outcome.nextSetup.teamIds.length,
        scoresPreserved: true,
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        competitionSetup: nextState.competitionSetup,
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/competition-setup/") &&
      url.pathname.endsWith("/second-half/open")
    ) {
      request.audit.action = "competition_second_half_open";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 6) return false;
      const groupId = sanitizeGroupId(pathParts[3]);
      if (!isKnownGroupId(pathParts[3])) throw new HttpError(404, "未知组别");
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          openCompetitionSecondHalf(state, {
            groupId,
            expectedRevision: body.revision,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId, half: "second" };
      request.audit.details = {
        operation: "open_second_half",
        halfTeamCount: outcome.openedSetup.halves.second.teamIds.length,
        cumulativeTeamCount: outcome.openedSetup.teamIds.length,
        judgeCount: outcome.openedSetup.judgeIds.length,
        scoresPreserved: true,
      };
      request.audit.outcome = "opened";
      sendJson(response, 200, {
        ok: true,
        competitionSetup: nextState.competitionSetup,
        judgeRoster: publicJudgeRoster(nextState.judgeRoster),
        activeAssignment: publicAssignment(nextState.activeAssignment),
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/assignments/replace-judge"
    ) {
      request.audit.action = "assignment_judge_replace";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          replaceAssignmentJudge(state, {
            outgoingJudgeId: normalizeId(body.outgoingJudgeId),
            incomingJudgeId: normalizeId(body.incomingJudgeId),
            expectedRosterRevision: body.rosterRevision,
            reason: body.reason,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = {
        teamId: nextState.activeAssignment.teamId,
        outgoingJudgeId: outcome.outgoingJudgeId,
        incomingJudgeId: outcome.incomingJudgeId,
      };
      request.audit.details = {
        operation: "replace_current_assignment_judge",
        previousRoster: outcome.previousRoster,
        nextRoster: outcome.nextRoster,
        reason: outcome.reason,
        rosterRevision: nextState.activeAssignment.rosterRevision,
      };
      request.audit.outcome = "replaced";
      sendJson(response, 200, {
        ok: true,
        activeAssignment: publicAssignment(nextState.activeAssignment),
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/competition-setup/") &&
      url.pathname.endsWith("/close")
    ) {
      request.audit.action = "competition_group_close";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 5) return false;
      const groupId = sanitizeGroupId(pathParts[3]);
      if (!isKnownGroupId(pathParts[3])) throw new HttpError(404, "未知组别");
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          closeCompetitionGroup(state, {
            groupId,
            expectedRevision: body.revision,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId };
      request.audit.details = {
        operation: "close_competition_group",
        teamCount: outcome.closedSetup.teamIds.length,
        judgeCount: outcome.closedSetup.judgeIds.length,
        previousAssignment: publicAssignment(outcome.previousAssignment),
        savedAssignment: publicAssignment(nextState.activeAssignment),
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        competitionSetup: nextState.competitionSetup,
        activeAssignment: publicAssignment(nextState.activeAssignment),
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/competition-setup/") &&
      url.pathname.endsWith("/reopen")
    ) {
      request.audit.action = "competition_group_reopen";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 5) return false;
      const groupId = sanitizeGroupId(pathParts[3]);
      if (!isKnownGroupId(pathParts[3])) throw new HttpError(404, "未知组别");
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          reopenCompetitionGroupForSetup(state, {
            groupId,
            expectedRevision: body.revision,
            confirmClearScores: body.confirmClearScores === true,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId };
      request.audit.details = {
        operation: outcome.hadScoringData
          ? "emergency_competition_restart"
          : "withdraw_open_for_reconfiguration",
        clearedEntryCount: outcome.clearedEntryCount,
        clearedTeamIds: outcome.mutation.clearEntriesTeamIds,
        preservedTeamInformation: true,
        preservedAppearanceOrder: true,
        preservedAccounts: true,
      };
      request.audit.outcome = "returned_to_setup";
      sendJson(response, 200, {
        ok: true,
        competitionSetup: nextState.competitionSetup,
        judgeRoster: publicJudgeRoster(nextState.judgeRoster),
        activeAssignment: publicAssignment(nextState.activeAssignment),
        displaySelection: publicDisplaySelection(nextState.displaySelection),
        restart: {
          hadScoringData: outcome.hadScoringData,
          clearedEntryCount: outcome.clearedEntryCount,
        },
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/api/competition-setup/") &&
      url.pathname.endsWith("/open")
    ) {
      request.audit.action = "competition_group_open";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 5) return false;
      const groupId = sanitizeGroupId(pathParts[3]);
      if (!isKnownGroupId(pathParts[3])) throw new HttpError(404, "未知组别");
      const body = await readJsonBody(request);
      const adminAccount = getAccountById(session.state, session.accountId);
      if (requireAdminPasswordRotation && clampInteger(adminAccount?.passwordVersion) <= 1) {
        throw new HttpError(409, "正式开赛前必须先修改管理员初始密码");
      }
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          openCompetitionGroup(state, {
            groupId,
            expectedRevision: body.revision,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId };
      request.audit.details = {
        operation: "open_competition_group",
        previousActiveGroupId: outcome.previousActiveGroupId,
        teamCount: outcome.openedSetup.teamIds.length,
        judgeCount: outcome.openedSetup.judgeIds.length,
      };
      request.audit.outcome = "opened";
      sendJson(response, 200, {
        ok: true,
        competitionSetup: nextState.competitionSetup,
        judgeRoster: publicJudgeRoster(nextState.judgeRoster),
        activeAssignment: publicAssignment(nextState.activeAssignment),
      });
      return true;
    }

    if (
      request.method === "PUT" &&
      url.pathname.startsWith("/api/competition-setup/")
    ) {
      request.audit.action = "competition_group_setup_write";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 4) return false;
      const groupId = sanitizeGroupId(pathParts[3]);
      if (!isKnownGroupId(pathParts[3])) throw new HttpError(404, "未知组别");
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          saveCompetitionGroupSetup(state, {
            groupId,
            teamIds: body.teamIds,
            judgeIds: body.judgeIds,
            expectedRevision: body.revision,
            actorId: session.accountId,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId };
      request.audit.details = {
        operation: "save_competition_group_setup",
        previousTeamCount: outcome.previousSetup.teamIds.length,
        nextTeamCount: outcome.nextSetup.teamIds.length,
        previousJudgeCount: outcome.previousSetup.judgeIds.length,
        nextJudgeCount: outcome.nextSetup.judgeIds.length,
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        competitionSetup: nextState.competitionSetup,
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/teams") {
      request.audit.action = "team_create";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const groupId = sanitizeGroupId(body.groupId);
      if (!isKnownGroupId(body.groupId)) throw new HttpError(404, "未知组别");
      const teamName = cleanText(body.teamName, "");
      const registrationNumber = getRegistrationNumber(body.registrationNumber);
      if (!teamName) throw new HttpError(400, "请输入队伍名称");
      let createdTeam = null;
      const nextState = await updateState(
        (state) => {
          const now = new Date().toISOString();
          assertRegistrationNumberAvailable(state, null, registrationNumber);
          createdTeam = {
            id: createTeamId(state),
            groupId,
            registrationNumber,
            teamName,
            projectName: cleanText(body.projectName),
            appearanceOrder: getOrderedTeams(state, groupId).length + 1,
            status: "active",
            revision: 1,
            judgeRosterSnapshot: [],
            createdAt: now,
            updatedAt: now,
          };
          state.teams.push(createdTeam);
          state.teamOrderRevisionByGroup[groupId] =
            (state.teamOrderRevisionByGroup[groupId] ?? 0) + 1;
          return state;
        },
        () => ({
          type: "team",
          teamId: createdTeam?.id,
          groupId: createdTeam?.groupId,
          orderChanged: true,
        }),
        session,
        ["admin"],
      );
      const savedTeam = getTeamById(nextState, createdTeam.id);
      request.audit.target = { teamId: savedTeam.id, groupId };
      request.audit.details = {
        operation: "create_team",
        registrationNumber: savedTeam.registrationNumber,
        teamName: savedTeam.teamName,
        projectName: savedTeam.projectName,
      };
      request.audit.outcome = "created";
      sendJson(response, 201, {
        ok: true,
        team: publicTeam(savedTeam),
        teamOrderRevisionByGroup: nextState.teamOrderRevisionByGroup,
      });
      return true;
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/teams/")) {
      request.audit.action = "team_delete";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 4) return false;
      const teamId = normalizeId(pathParts[3], 16);
      const body = await readJsonBody(request);
      let deletedTeam = null;
      let affectedTeamIds = [];
      let setupChanged = false;
      let displayInvalidated = false;
      const nextState = await updateState(
        (state) => {
          const team = getTeamById(state, teamId);
          if (!team) throw new HttpError(404, "未知队伍");
          if (requireExpectedRevision(body.revision) !== team.revision)
            throw new HttpError(409, "队伍信息已被其他管理员更新，请刷新后核对");
          if (state.activeAssignment.teamId === teamId)
            throw new HttpError(409, "当前派发队伍不能删除");
          if (
            Object.values(
              state.activeAssignment.rescoreAssignmentsByJudge ?? {},
            ).some((grant) => grant?.teamId === teamId)
          ) {
            throw new HttpError(409, "该队伍仍有指定评委的历史重评任务，不能删除");
          }
          const hasEntries = Object.values(state.entriesByJudge).some(
            (entries) => Boolean(entries?.[teamId]),
          );
          if (team.judgeRosterSnapshot?.length || hasEntries)
            throw new HttpError(409, "该队伍已有评分历史，只能退赛或归档，不能删除");
          const setup = state.competitionSetup?.groups?.[team.groupId];
          if (setup?.teamIds?.includes(teamId) && setup.status !== "draft")
            throw new HttpError(409, "该队伍已纳入开启或结束的赛次，不能删除");

          deletedTeam = { ...team };
          state.teams = state.teams.filter((item) => item.id !== teamId);
          const remainingGroupTeams = state.teams
            .filter((item) => item.groupId === team.groupId)
            .sort((left, right) => left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id));
          const now = new Date().toISOString();
          affectedTeamIds = [];
          remainingGroupTeams.forEach((item, index) => {
            const nextOrder = index + 1;
            if (item.appearanceOrder === nextOrder) return;
            item.appearanceOrder = nextOrder;
            item.revision += 1;
            item.updatedAt = now;
            affectedTeamIds.push(item.id);
          });
          state.teamOrderRevisionByGroup[team.groupId] =
            (state.teamOrderRevisionByGroup[team.groupId] ?? 0) + 1;
          if (setup?.status === "draft" && setup.teamIds.includes(teamId)) {
            state.competitionSetup.groups[team.groupId] = {
              ...setup,
              teamIds: setup.teamIds.filter((id) => id !== teamId),
              halves: {
                ...setup.halves,
                first: {
                  ...setup.halves?.first,
                  teamIds: (setup.halves?.first?.teamIds ?? setup.teamIds).filter((id) => id !== teamId),
                },
                second: {
                  ...setup.halves?.second,
                  teamIds: (setup.halves?.second?.teamIds ?? []).filter((id) => id !== teamId),
                },
              },
              revision: setup.revision + 1,
              updatedAt: now,
              updatedBy: session.accountId,
            };
            state.competitionSetup.revision += 1;
            setupChanged = true;
          }
          const revealedTeamIdsByGroup = Object.fromEntries(
            Object.entries(state.displaySelection.revealedTeamIdsByGroup ?? {}).map(([groupId, teamIds]) => [
              groupId,
              Array.isArray(teamIds) ? teamIds.filter((id) => id !== teamId) : [],
            ]),
          );
          const removedFromRankingHistory = Object.values(state.displaySelection.revealedTeamIdsByGroup ?? {})
            .some((teamIds) => Array.isArray(teamIds) && teamIds.includes(teamId));
          const transitionReferencesTeam = [
            state.displaySelection.rankingTransition?.fromTeamId,
            state.displaySelection.rankingTransition?.toTeamId,
          ].includes(teamId) || state.displaySelection.rankingTransition?.teamIds?.includes(teamId);
          const withdrawsCurrentDisplay = state.displaySelection.teamId === teamId;
          if (withdrawsCurrentDisplay || removedFromRankingHistory || transitionReferencesTeam) {
            state.displaySelection = {
              ...state.displaySelection,
              teamId: withdrawsCurrentDisplay ? null : state.displaySelection.teamId,
              publicationStatus: withdrawsCurrentDisplay ? "idle" : state.displaySelection.publicationStatus,
              displayRevision: state.displaySelection.displayRevision + 1,
              publishedAt: withdrawsCurrentDisplay ? "" : state.displaySelection.publishedAt,
              updatedAt: now,
              revealedTeamIdsByGroup,
              rankingTransition: withdrawsCurrentDisplay || transitionReferencesTeam
                ? null
                : state.displaySelection.rankingTransition,
            };
            displayInvalidated = true;
          }
          return state;
        },
        () => ({
          type: "team_delete",
          teamId,
          groupId: deletedTeam?.groupId,
          teamIds: affectedTeamIds,
          setupChanged,
          displayInvalidated,
        }),
        session,
        ["admin"],
      );
      request.audit.target = { teamId, groupId: deletedTeam.groupId };
      request.audit.details = {
        operation: "delete_team",
        deleted: publicTeam(deletedTeam),
        removedFromDraftSetup: setupChanged,
        reorderedTeamIds: affectedTeamIds,
        displayInvalidated,
      };
      request.audit.outcome = "deleted";
      sendJson(response, 200, {
        ok: true,
        deletedTeamId: teamId,
        teams: getOrderedTeams(nextState, deletedTeam.groupId).map(publicTeam),
        teamOrderRevisionByGroup: nextState.teamOrderRevisionByGroup,
        competitionSetup: nextState.competitionSetup,
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (request.method === "PUT" && url.pathname.startsWith("/api/teams/")) {
      request.audit.action = "team_update";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 4) return false;
      const teamId = normalizeId(pathParts[3], 16);
      const body = await readJsonBody(request);
      let previousTeam = null;
      let displayInvalidated = false;
      const nextState = await updateState(
        (state) => {
          const team = getTeamById(state, teamId);
          if (!team) throw new HttpError(404, "未知队伍");
          if (requireExpectedRevision(body.revision) !== team.revision)
            throw new HttpError(
              409,
              "队伍信息已被其他管理员更新，请刷新后核对",
            );
          const nextStatus =
            body.status === undefined ? team.status : body.status;
          if (!["active", "withdrawn", "archived"].includes(nextStatus))
            throw new HttpError(400, "队伍状态无效");
          if (
            state.activeAssignment.teamId === teamId &&
            nextStatus !== "active"
          )
            throw new HttpError(409, "当前派发队伍不能直接退赛或归档");
          if (
            nextStatus !== "active" &&
            Object.values(
              state.activeAssignment.rescoreAssignmentsByJudge ?? {},
            ).some((grant) => grant?.teamId === teamId)
          ) {
            throw new HttpError(409, "该队伍仍有指定评委的历史重评任务，不能退赛或归档");
          }
          const nextRegistrationNumber = getRegistrationNumber(body.registrationNumber, team.registrationNumber);
          if (body.registrationNumber !== undefined) assertRegistrationNumberAvailable(state, teamId, nextRegistrationNumber);
          previousTeam = { ...team };
          team.registrationNumber = nextRegistrationNumber;
          team.teamName = cleanText(body.teamName, team.teamName);
          team.projectName = cleanText(body.projectName, team.projectName);
          team.status = nextStatus;
          team.revision += 1;
          team.updatedAt = new Date().toISOString();
          displayInvalidated =
            nextStatus !== "active" &&
            invalidateDisplayForReview(state, teamId, undefined, { includeTemporary: true });
          return state;
        },
        () => ({ type: "team", teamId, displayInvalidated }),
        session,
        ["admin"],
      );
      const team = getTeamById(nextState, teamId);
      request.audit.target = { teamId };
      request.audit.details = {
        operation: "update_team",
        previous: publicTeam(previousTeam),
        saved: publicTeam(team),
        displayInvalidated,
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        team: publicTeam(team),
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (
      request.method === "PUT" &&
      (url.pathname.startsWith("/api/team-order/") ||
        url.pathname.startsWith("/api/candidate-order/"))
    ) {
      request.audit.action = "team_order_write";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 4) return false;
      const groupId = pathParts[3];
      const body = await readJsonBody(request);
      let previousOrder = [];
      let nextOrder = [];
      const nextState = await updateState(
        (state) => {
          nextOrder = validateTeamOrder(
            state,
            groupId,
            body.orderedTeamIds ?? body.orderedCandidateIds,
          );
          const currentRevision = state.teamOrderRevisionByGroup[groupId] ?? 0;
          if (requireExpectedRevision(body.revision) !== currentRevision)
            throw new HttpError(
              409,
              "出场顺序已被其他管理员更新，请刷新后重试",
            );
          previousOrder = getOrderedTeams(state, groupId).map(
            (team) => team.id,
          );
          if (!isSameIdOrder(previousOrder, nextOrder))
            updateTeamOrder(state, groupId, nextOrder);
          return state;
        },
        () =>
          isSameIdOrder(previousOrder, nextOrder)
            ? { type: "noop" }
            : { type: "team_order", groupId },
        session,
        ["admin"],
      );
      request.audit.target = { groupId };
      request.audit.details = {
        operation: "reorder",
        previousOrder,
        nextOrder,
        revision: nextState.teamOrderRevisionByGroup[groupId],
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        teams: getOrderedTeams(nextState, groupId).map(publicTeam),
        teamOrderRevisionByGroup: nextState.teamOrderRevisionByGroup,
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/accounts") {
      request.audit.action = "account_create";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const username = normalizeUsername(body.username);
      const displayName = cleanText(body.displayName, "");
      const password = String(body.password ?? "");
      if (!username || !displayName)
        throw new HttpError(400, "账号和显示名格式不正确");
      if (password.length < 8 || password.length > 256)
        throw new HttpError(400, "新账号密码长度应为 8 到 256 位");
      if (body.role && body.role !== "judge")
        throw new HttpError(400, "本期只允许管理员维护评委账号");
      const passwordHash = await hashPassword(password);
      let createdAccount = null;
      const nextState = await updateState(
        (state) => {
          if (state.accounts.some((account) => account.username === username))
            throw new HttpError(409, "账号已存在");
          const now = new Date().toISOString();
          createdAccount = {
            id: createAccountId(state),
            username,
            displayName,
            role: "judge",
            status: "active",
            passwordHash,
            passwordVersion: 1,
            authVersion: 1,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          state.accounts.push(createdAccount);
          return state;
        },
        () => ({ type: "account", accountId: createdAccount?.id }),
        session,
        ["admin"],
      );
      const account = getAccountById(nextState, createdAccount.id);
      request.audit.target = { accountId: account.id };
      request.audit.details = {
        operation: "create_account",
        username: account.username,
        role: account.role,
      };
      request.audit.outcome = "created";
      sendJson(response, 201, { ok: true, account: publicAccount(account) });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/judge-enrollments"
    ) {
      request.audit.action = "judge_enrollment_create";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const username = normalizeUsername(body.username);
      const displayName = cleanText(body.displayName, "");
      const password = String(body.password ?? "");
      const operationId = cleanText(body.operationId, "").slice(0, 80);
      const reason = cleanText(body.reason, "现场临时增补").slice(0, 500);
      const expectedRosterRevision = requireExpectedRevision(body.expectedRosterRevision);
      if (!username || !displayName)
        throw new HttpError(400, "账号和显示名格式不正确");
      if (password.length < 8 || password.length > 256)
        throw new HttpError(400, "新账号密码长度应为 8 到 256 位");
      if (!/^[A-Za-z0-9._:-]{8,80}$/.test(operationId))
        throw new HttpError(400, "临时增员操作标识格式不正确");
      const passwordHash = await hashPassword(password);
      let outcome = null;
      const nextState = await updateState(
        async (state) => {
          const now = new Date().toISOString();
          const previousOperation = state.judgeRoster.enrollmentOperations?.find(
            (item) => item.operationId === operationId,
          );
          if (previousOperation) {
            const previousAccount = getAccountById(state, previousOperation.accountId);
            const replayMatches =
              previousAccount?.username === username &&
              previousOperation.displayName === displayName &&
              previousOperation.reason === reason &&
              previousOperation.expectedRosterRevision === expectedRosterRevision &&
              await verifyPassword(password, previousOperation.credentialHash);
            if (!replayMatches) {
              throw new HttpError(409, "同一增员操作标识的请求内容不一致，请使用新的操作标识");
            }
          }
          const account = {
            id: createAccountId(state),
            username,
            displayName,
            role: "judge",
            status: "active",
            passwordHash,
            passwordVersion: 1,
            authVersion: 1,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          outcome = enrollJudgeForFutureAssignments(state, {
            account,
            expectedRosterRevision,
            operationId,
            reason,
            actorId: session.accountId,
            now,
          });
          return state;
        },
        () => outcome.mutation,
        session,
        ["admin"],
      );
      const account = getAccountById(nextState, outcome.account.id);
      request.audit.target = { accountId: account.id };
      request.audit.details = {
        operation: "create_and_enroll_for_future_assignments",
        operationId,
        username: account.username,
        previousRoster: outcome.previousRoster,
        nextRoster: outcome.nextRoster,
        rosterRevision: nextState.judgeRoster.revision,
        effectiveAfterAssignmentRevision:
          outcome.effectiveAfterAssignmentRevision,
        affectsCurrentAssignment: false,
        idempotentReplay: outcome.idempotentReplay,
        reason,
      };
      request.audit.outcome = outcome.idempotentReplay ? "replayed" : "created";
      sendJson(response, outcome.idempotentReplay ? 200 : 201, {
        ok: true,
        account: publicAccount(account),
        judgeRoster: publicJudgeRoster(nextState.judgeRoster),
        enrollment: {
          mode: "future_assignments",
          affectsCurrentAssignment: false,
          effectiveAfterAssignmentRevision:
            outcome.effectiveAfterAssignmentRevision,
          idempotentReplay: outcome.idempotentReplay,
        },
      });
      return true;
    }

    if (request.method === "PUT" && url.pathname.startsWith("/api/accounts/")) {
      request.audit.action = "account_update";
      const session = await requireSession(request, ["admin"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 4) return false;
      const accountId = normalizeId(pathParts[3]);
      const body = await readJsonBody(request);
      const requestedPassword =
        body.password === undefined ? "" : String(body.password);
      if (
        body.password !== undefined &&
        (requestedPassword.length < 8 || requestedPassword.length > 256)
      ) {
        throw new HttpError(400, "新密码长度应为 8 到 256 位");
      }
      const targetAccount = getAccountById(session.state, accountId);
      if (
        body.password !== undefined &&
        targetAccount?.role === "admin" &&
        (requestedPassword === "admin123" || (
          clampInteger(targetAccount.passwordVersion) <= 1 &&
          await verifyPassword(requestedPassword, targetAccount.passwordHash)
        ))
      ) {
        throw new HttpError(400, "管理员新密码不能与初始密码相同");
      }
      const passwordHash =
        body.password === undefined
          ? ""
          : await hashPassword(requestedPassword);
      let previousAccount = null;
      let previousRoster = null;
      let removedFromPlannedRoster = false;
      const nextState = await updateState(
        (state) => {
          const account = getAccountById(state, accountId);
          if (!account) throw new HttpError(404, "未知账号");
          if (requireExpectedRevision(body.revision) !== account.revision)
            throw new HttpError(409, "账号已被其他管理员更新，请刷新后核对");
          const nextStatus =
            body.status === undefined ? account.status : body.status;
          if (!["active", "disabled", "archived"].includes(nextStatus))
            throw new HttpError(400, "账号状态无效");
          const activeAdmins = state.accounts.filter(
            (item) => item.role === "admin" && item.status === "active",
          );
          if (
            account.role === "admin" &&
            account.status === "active" &&
            nextStatus !== "active" &&
            activeAdmins.length <= 1
          ) {
            throw new HttpError(409, "不能禁用或归档最后一个启用的管理员");
          }
          if (account.role === "judge" && nextStatus !== "active") {
            if (
              state.activeAssignment.rescoreAssignmentsByJudge?.[account.id]
            ) {
              throw new HttpError(409, "该评委仍有未完成的历史重评任务，不能停用或归档");
            }
            const assignmentGroupId = state.activeAssignment.groupId;
            const belongsToOpenAssignment =
              Boolean(state.activeAssignment.teamId) &&
              state.competitionSetup.activeGroupId === assignmentGroupId &&
              state.competitionSetup.groups?.[assignmentGroupId]?.status === "open" &&
              state.activeAssignment.rosterSnapshot.includes(account.id);
            if (belongsToOpenAssignment) {
              throw new HttpError(409, "该账号仍在当前队评分快照中，须完成或取消当前评分后再停用");
            }
            if (state.judgeRoster.judgeIds.includes(account.id)) {
              if (body.removeFromPlannedRoster !== true) {
                throw new HttpError(409, "该账号仍在计划评分名册中，请先从计划名册移出后再停用");
              }
              const rosterOutcome = updatePlannedRoster(state, {
                judgeIds: state.judgeRoster.judgeIds.filter((judgeId) => judgeId !== account.id),
                expectedRevision: body.rosterRevision,
                reason: "停用或归档评委账号时移出后续计划名册",
                actorId: session.accountId,
              });
              previousRoster = rosterOutcome.previousRoster;
              removedFromPlannedRoster = true;
            }
          }
          previousAccount = { ...account };
          account.displayName = cleanText(
            body.displayName,
            account.displayName,
          );
          const statusChanged = nextStatus !== account.status;
          account.status = nextStatus;
          if (body.password !== undefined) {
            account.passwordHash = passwordHash;
            account.passwordVersion += 1;
          }
          if (statusChanged || body.password !== undefined)
            account.authVersion += 1;
          account.revision += 1;
          account.updatedAt = new Date().toISOString();
          return state;
        },
        () => ({ type: "account", accountId, rosterChanged: removedFromPlannedRoster }),
        session,
        ["admin"],
      );
      const account = getAccountById(nextState, accountId);
      request.audit.target = { accountId };
      request.audit.details = {
        operation: "update_account",
        previous: publicAccount(previousAccount),
        saved: publicAccount(account),
        passwordReset: body.password !== undefined,
        removedFromPlannedRoster,
        previousRoster: removedFromPlannedRoster ? previousRoster : undefined,
        nextRoster: removedFromPlannedRoster ? nextState.judgeRoster.judgeIds : undefined,
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        account: publicAccount(account),
        judgeRoster: removedFromPlannedRoster
          ? publicJudgeRoster(nextState.judgeRoster)
          : undefined,
      });
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/judge-roster") {
      request.audit.action = "judge_roster_write";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      let previousRoster = [];
      const nextState = await updateState(
        (state) => {
          const judgeIds = Array.isArray(body.judgeIds)
            ? body.judgeIds.map((id) => normalizeId(id)).filter(Boolean)
            : body.judgeIds;
          const outcome = updatePlannedRoster(state, {
            judgeIds,
            expectedRevision: body.revision,
            reason: body.reason,
            actorId: session.accountId,
          });
          previousRoster = outcome.previousRoster;
          return state;
        },
        { type: "roster" },
        session,
        ["admin"],
      );
      request.audit.target = { roster: "effective_judges" };
      request.audit.details = {
        operation: "set_planned_roster",
        previousRoster,
        nextRoster: nextState.judgeRoster.judgeIds,
        affectsCurrentAssignment: false,
        effectiveAfterAssignmentRevision:
          nextState.activeAssignment.assignmentRevision,
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, { ok: true, judgeRoster: publicJudgeRoster(nextState.judgeRoster) });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/assignments/dispatch"
    ) {
      request.audit.action = "assignment_dispatch";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const teamId = normalizeId(body.teamId, 16);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          dispatchAssignment(state, {
            teamId,
            expectedRevision: body.revision,
            force: body.force,
            reason: body.reason,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { teamId };
      request.audit.details = {
        operation: "assignment_dispatch",
        previousAssignment: publicAssignment(outcome.previousAssignment),
        savedAssignment: publicAssignment(nextState.activeAssignment),
        forced: outcome.forced,
        reason: outcome.reason,
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        activeAssignment: publicAssignment(nextState.activeAssignment),
        judgeRoster: publicJudgeRoster(nextState.judgeRoster),
      });
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/display-selection") {
      request.audit.action = "display_publish";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          publishDisplaySelection(state, {
            teamId: normalizeId(body.teamId, 16),
            publicationStatus: body.publicationStatus,
            expectedRevision: body.revision,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { teamId: nextState.displaySelection.teamId };
      request.audit.details = {
        operation: "display_publish",
        previous: publicDisplaySelection(outcome.previousSelection),
        saved: publicDisplaySelection(nextState.displaySelection),
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        displaySelection: publicDisplaySelection(nextState.displaySelection),
        ...getScoreboardPayload(nextState),
      });
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/display-settings") {
      request.audit.action = "display_ranking_animation_update";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          updateDisplayRankingAnimation(state, {
            enabled: body.rankingAnimationEnabled,
            expectedRevision: body.revision,
          }),
        session,
        ["admin"],
      );
      request.audit.target = { setting: "rankingAnimationEnabled" };
      request.audit.details = {
        operation: "display_ranking_animation_update",
        previousEnabled: outcome.previousSelection.rankingAnimationEnabled === true,
        savedEnabled: nextState.displaySelection.rankingAnimationEnabled === true,
        displayRevision: nextState.displaySelection.displayRevision,
      };
      request.audit.outcome = outcome.changed ? "saved" : "unchanged";
      sendJson(response, 200, {
        ok: true,
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/display-view") {
      request.audit.action = "display_view_update";
      const session = await requireSession(request, ["admin"]);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) => showDisplayRankings(state, {
          groupId: sanitizeGroupId(body.groupId),
          expectedRevision: body.revision,
        }),
        session,
        ["admin"],
      );
      request.audit.target = { groupId: nextState.displaySelection.rankingGroupId };
      request.audit.details = {
        operation: "display_show_rankings",
        previous: publicDisplaySelection(outcome.previousSelection),
        saved: publicDisplaySelection(nextState.displaySelection),
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    if (request.method === "PUT" && url.pathname.startsWith("/api/entries/")) {
      request.audit.action = "entry_write";
      const session = await requireSession(request, ["admin", "judge"]);
      const pathParts = url.pathname.split("/");
      if (pathParts.length !== 5) return false;
      const judgeId = normalizeId(pathParts[3]);
      const teamId = normalizeId(pathParts[4], 16);
      const body = await readJsonBody(request);
      const { state: nextState, outcome } = await applyContestControl(
        (state) =>
          writeScoreEntry(state, {
            actor: session.account,
            judgeId,
            teamId,
            entry: body.entry ?? body,
            assignmentRevision: body.assignmentRevision,
          }),
        session,
        ["admin", "judge"],
      );
      const {
        previousEntry,
        persistedEntry,
        assignmentChanged,
        rescoreCompleted,
        rescoreActive,
        rescoreMode,
        rescoreRevision,
        displayInvalidated,
      } = outcome;
      const operation =
        session.account.role === "admin" &&
        itemIds.every((id) => persistedEntry.scores[id] === "") &&
        (previousEntry.submitted ||
          itemIds.some((id) => previousEntry.scores[id] !== ""))
          ? "admin_clear_scores"
          : session.account.role === "admin" &&
              previousEntry.submitted &&
              !persistedEntry.submitted
            ? "admin_reopen_submission"
            : session.account.role === "judge" && rescoreCompleted
              ? "judge_rescore_submit"
              : session.account.role === "judge" && rescoreActive
                ? "judge_rescore_save"
              : session.account.role === "judge" && persistedEntry.submitted
                ? "judge_submit"
              : "save_scores";
      request.audit.target = { judgeId, teamId };
      request.audit.details = {
        operation,
        previous: getEntryAuditSnapshot(previousEntry),
        saved: getEntryAuditSnapshot(persistedEntry),
        changedScores: getChangedScores(previousEntry, persistedEntry),
        assignmentChanged,
        rescoreCompleted,
        rescoreMode,
        rescoreRevision,
        assignmentScope:
          rescoreActive || rescoreCompleted
            ? "historical_rescore"
            : "current_assignment",
        displayInvalidated,
      };
      request.audit.outcome = "saved";
      sendJson(response, 200, {
        ok: true,
        entry: persistedEntry,
        activeAssignment:
          session.account.role === "judge"
            ? publicJudgeAssignment(nextState, judgeId)
            : publicAssignment(nextState.activeAssignment),
        displaySelection: publicDisplaySelection(nextState.displaySelection),
      });
      return true;
    }

    return false;
  };
}
