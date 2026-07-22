import {
  calculateCompositeCents,
  createEntry,
  formatCents,
  getEntryTotalCents,
  sanitizeEntry,
} from "../shared/scoringRules.js";
import {
  getActiveCompetitionHalfTeamIds,
  getCompetitionHalfTeamIds,
  getCompetitionRankingScope,
  getOrderedSetupTeams,
} from "../shared/competitionSetup.js";

export class ContestControlError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(status, message) {
  throw new ContestControlError(status, message);
}

function clampInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
}

function requireExpectedRevision(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(400, "请求版本无效，请刷新后重试");
  }
  return value;
}

function assertExpectedRevision(value, currentRevision, conflictMessage) {
  const expectedRevision = requireExpectedRevision(value);
  if (expectedRevision !== currentRevision) fail(409, conflictMessage);
  return expectedRevision;
}

function cleanReason(value) {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

const displayRankingTransitionIntroMs = 250;
const displayRankingTransitionHoldMs = 1500;
const displayRankingTransitionPerPositionMs = 260;

function getDisplayRankingTransitionDurationMs(state, groupId, teamIds, currentTeamId) {
  const scopedTeamIds = new Set(Array.isArray(teamIds) ? teamIds : []);
  const rankedTeams = getOrderedSetupTeams(state, groupId)
    .filter((team) => scopedTeamIds.has(team.id))
    .map((team) => {
      const summary = getCompositeSummary(state, team.id);
      return {
        id: team.id,
        appearanceOrder: team.appearanceOrder,
        scoreValue: summary.display === "--" ? null : Number(summary.display),
      };
    })
    .sort((left, right) => {
      const leftScore = left.scoreValue ?? -1;
      const rightScore = right.scoreValue ?? -1;
      return rightScore - leftScore || left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id);
    });
  const finalIndex = rankedTeams.findIndex((team) => team.id === currentTeamId);
  const crossedPositions = finalIndex < 0 ? 0 : Math.max(0, rankedTeams.length - 1 - finalIndex);
  const travelMs = crossedPositions * displayRankingTransitionPerPositionMs;
  return displayRankingTransitionIntroMs + travelMs + displayRankingTransitionHoldMs;
}

function cloneRevealedTeamIdsByGroup(selection) {
  const source = selection?.revealedTeamIdsByGroup;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(
    Object.entries(source).map(([groupId, teamIds]) => [
      groupId,
      Array.isArray(teamIds) ? [...new Set(teamIds.filter((id) => typeof id === "string" && id))] : [],
    ]),
  );
}

function isRankingTransitionActive(selection) {
  const transition = selection?.rankingTransition;
  return Boolean(
    selection?.rankingAnimationEnabled === true &&
      transition,
  );
}

function getRescoreAssignments(assignment) {
  return assignment?.rescoreAssignmentsByJudge &&
    typeof assignment.rescoreAssignmentsByJudge === "object" &&
    !Array.isArray(assignment.rescoreAssignmentsByJudge)
    ? assignment.rescoreAssignmentsByJudge
    : {};
}

function hasRescoreForTeam(assignment, teamId) {
  return Object.values(getRescoreAssignments(assignment)).some(
    (grant) => grant?.teamId === teamId,
  );
}

function getActiveRoster(state) {
  const accountsById = new Map(getJudgeAccounts(state).map((account) => [account.id, account]));
  return [...new Set(state.judgeRoster.judgeIds.filter((id) => accountsById.get(id)?.status === "active"))];
}

function getCompetitionGroupSetup(state, groupId) {
  return state.competitionSetup?.groups?.[groupId] ?? null;
}

function cloneCompetitionGroupSetup(setup) {
  return {
    ...setup,
    teamIds: [...(setup?.teamIds ?? [])],
    judgeIds: [...(setup?.judgeIds ?? [])],
    halves: {
      first: {
        ...(setup?.halves?.first ?? {}),
        teamIds: getCompetitionHalfTeamIds(setup, "first"),
      },
      second: {
        ...(setup?.halves?.second ?? {}),
        teamIds: getCompetitionHalfTeamIds(setup, "second"),
      },
    },
  };
}

function getEligibleCompetitionTeamIds(state, groupId) {
  return new Set(
    state.teams
      .filter((team) => team.groupId === groupId && team.status === "active")
      .map((team) => team.id),
  );
}

function validateCompetitionTeamSelection(state, groupId, teamIds, { excludedTeamIds = [] } = {}) {
  if (!Array.isArray(teamIds)) fail(400, "参赛队伍配置异常");
  const eligibleTeamIds = getEligibleCompetitionTeamIds(state, groupId);
  const excluded = new Set(excludedTeamIds);
  const normalizedTeamIds = teamIds.filter(
    (id) => typeof id === "string" && eligibleTeamIds.has(id) && !excluded.has(id),
  );
  if (
    normalizedTeamIds.length !== teamIds.length ||
    new Set(normalizedTeamIds).size !== normalizedTeamIds.length
  ) {
    fail(400, excluded.size
      ? "下半场队伍必须属于当前组别、正常参赛、不能重复，也不能与上半场重叠"
      : "开赛队伍必须属于当前组别、正常参赛且不能重复");
  }
  if (!normalizedTeamIds.length) fail(400, "每个半场至少需要一支参赛队伍");
  return normalizedTeamIds;
}

function assertTeamInformationReady(state, teamIds, message) {
  const incompleteTeam = teamIds
    .map((teamId) => getTeamById(state, teamId))
    .find((team) => !team?.teamName?.trim() || !team?.registrationNumber?.trim());
  if (incompleteTeam) fail(409, message);
}

export function saveCompetitionGroupSetup(
  state,
  {
    groupId,
    teamIds,
    judgeIds,
    expectedRevision,
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const setup = getCompetitionGroupSetup(state, groupId);
  if (!setup) fail(404, "未知比赛组别");
  if (setup.status === "open") fail(409, "该组比赛已开启，当前赛次配置已冻结");
  if (setup.status === "closed") fail(409, "该组比赛已结束，不能修改历史赛次配置");
  assertExpectedRevision(expectedRevision, setup.revision, "开赛配置已被其他管理员更新，请刷新后重试");
  if (!Array.isArray(teamIds) || !Array.isArray(judgeIds)) {
    fail(400, "开赛队伍或评委配置异常");
  }
  const eligibleTeamIds = getEligibleCompetitionTeamIds(state, groupId);
  const eligibleJudgeIds = new Set(
    getJudgeAccounts(state)
      .filter((account) => account.status === "active")
      .map((account) => account.id),
  );
  const normalizedTeamIds = teamIds.filter(
    (id) => typeof id === "string" && eligibleTeamIds.has(id),
  );
  const normalizedJudgeIds = judgeIds.filter(
    (id) => typeof id === "string" && eligibleJudgeIds.has(id),
  );
  if (
    normalizedTeamIds.length !== teamIds.length ||
    new Set(normalizedTeamIds).size !== normalizedTeamIds.length
  ) {
    fail(400, "开赛队伍必须属于当前组别、正常参赛且不能重复");
  }
  if (!normalizedTeamIds.length) fail(400, "每场比赛至少需要一支参赛队伍");
  if (
    normalizedJudgeIds.length !== judgeIds.length ||
    new Set(normalizedJudgeIds).size !== normalizedJudgeIds.length
  ) {
    fail(400, "开赛评委必须为启用账号且不能重复");
  }
  if (normalizedJudgeIds.length < 3) fail(400, "每场比赛至少需要 3 位启用评委");

  const previousSetup = cloneCompetitionGroupSetup(setup);
  state.competitionSetup.groups[groupId] = {
    ...setup,
    teamIds: normalizedTeamIds,
    judgeIds: normalizedJudgeIds,
    activeHalf: null,
    halves: {
      first: {
        status: "draft",
        teamIds: [...normalizedTeamIds],
        openedAt: "",
        closedAt: "",
      },
      second: {
        status: "draft",
        teamIds: [],
        openedAt: "",
        closedAt: "",
      },
    },
    revision: setup.revision + 1,
    updatedAt: now,
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  state.competitionSetup.revision += 1;
  return {
    previousSetup,
    nextSetup: state.competitionSetup.groups[groupId],
    mutation: { type: "competition_setup", operation: "save" },
  };
}

export function openCompetitionGroup(
  state,
  {
    groupId,
    expectedRevision,
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const setup = getCompetitionGroupSetup(state, groupId);
  if (!setup) fail(404, "未知比赛组别");
  if (setup.status === "open" && state.competitionSetup.activeGroupId === groupId) {
    fail(409, "该组比赛已经开启");
  }
  if (setup.status === "closed") fail(409, "该组比赛已结束，不能重复开启");
  assertExpectedRevision(expectedRevision, setup.revision, "开赛配置已被其他管理员更新，请刷新后重试");
  if (!setup.teamIds.length) fail(400, "请至少选择一支参赛队伍后再开赛");
  if (setup.judgeIds.length < 3) fail(400, "请至少选择 3 位启用评委后再开赛");
  const eligibleTeamIds = getEligibleCompetitionTeamIds(state, groupId);
  if (setup.teamIds.some((teamId) => !eligibleTeamIds.has(teamId))) {
    fail(409, "开赛配置中的队伍状态已变化，请重新核对本场参赛队伍");
  }
  assertTeamInformationReady(
    state,
    setup.teamIds,
    "开赛队伍缺少报名编号或队伍名称，请先在队伍管理中补全资料",
  );
  const eligibleJudgeIds = new Set(
    getJudgeAccounts(state)
      .filter((account) => account.status === "active")
      .map((account) => account.id),
  );
  if (setup.judgeIds.some((judgeId) => !eligibleJudgeIds.has(judgeId))) {
    fail(409, "开赛配置中的评委状态已变化，请重新核对本场评分评委");
  }
  const assignment = state.activeAssignment;
  if (
    assignment.teamId &&
    !["final", "closed"].includes(assignment.status)
  ) {
    fail(409, "当前派发评分尚未完成，不能开启其他组别");
  }

  const previousActiveGroupId = state.competitionSetup.activeGroupId;
  if (previousActiveGroupId && previousActiveGroupId !== groupId) {
    const previous = getCompetitionGroupSetup(state, previousActiveGroupId);
    const unresolvedTeams = previous?.teamIds.filter((teamId) => {
      const team = getTeamById(state, teamId);
      return !team || (team.status === "active" && !getCompositeSummary(state, teamId).isFinal);
    }) ?? [];
    if (unresolvedTeams.length) {
      fail(409, "当前组别仍有未完成队伍，不能提前开启其他组别");
    }
    fail(409, "请先显式结束当前组比赛，再开启其他组别");
  }
  state.competitionSetup.groups[groupId] = {
    ...setup,
    status: "open",
    activeHalf: "first",
    halves: {
      first: {
        status: "open",
        teamIds: [...setup.teamIds],
        openedAt: now,
        closedAt: "",
      },
      second: {
        status: "draft",
        teamIds: [],
        openedAt: "",
        closedAt: "",
      },
    },
    revision: setup.revision + 1,
    openedAt: now,
    closedAt: "",
    updatedAt: now,
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  state.competitionSetup.activeGroupId = groupId;
  state.competitionSetup.revision += 1;
  state.judgeRoster = {
    ...state.judgeRoster,
    judgeIds: [...setup.judgeIds],
    revision: state.judgeRoster.revision + 1,
    lockedAt: "",
    effectiveMode: "next_assignment",
    reason: "开启分组比赛",
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
    updatedAt: now,
  };
  state.activeAssignment = {
    groupId,
    teamId: null,
    status: "idle",
    assignmentRevision: assignment.assignmentRevision + 1,
    rosterRevision: clampInteger(assignment.rosterRevision) + 1,
    rosterSnapshot: [],
    rescoreRevision: clampInteger(assignment.rescoreRevision),
    rescoreAssignmentsByJudge: {},
    updatedAt: now,
    forcedReason: "",
  };
  return {
    previousActiveGroupId,
    openedSetup: state.competitionSetup.groups[groupId],
    mutation: {
      type: "competition_setup",
      operation: "open",
    },
  };
}

export function finishCompetitionFirstHalf(
  state,
  {
    groupId,
    expectedRevision,
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const setup = getCompetitionGroupSetup(state, groupId);
  if (!setup) fail(404, "未知比赛组别");
  if (
    setup.status !== "open" ||
    state.competitionSetup.activeGroupId !== groupId ||
    setup.activeHalf !== "first" ||
    setup.halves?.first?.status !== "open"
  ) {
    fail(409, "只有正在进行的上半场可以结束");
  }
  assertExpectedRevision(expectedRevision, setup.revision, "半场状态已被其他管理员更新，请刷新后重试");
  const assignment = state.activeAssignment;
  if (Object.keys(getRescoreAssignments(assignment)).length) {
    fail(409, "仍有指定评委的历史重评任务未完成，不能结束上半场");
  }
  if (
    assignment.groupId === groupId &&
    assignment.teamId &&
    !["final", "closed"].includes(assignment.status)
  ) {
    fail(409, "当前派发评分尚未完成，不能结束上半场");
  }
  const firstHalfTeamIds = getCompetitionHalfTeamIds(setup, "first");
  const unresolvedTeams = firstHalfTeamIds.filter((teamId) => {
    const team = getTeamById(state, teamId);
    return !team || (team.status === "active" && !getCompositeSummary(state, teamId).isFinal);
  });
  if (unresolvedTeams.length) {
    fail(409, `上半场仍有 ${unresolvedTeams.length} 支未完成队伍，不能进入中场休息`);
  }
  const previousSetup = cloneCompetitionGroupSetup(setup);
  const previousAssignment = { ...assignment, rosterSnapshot: [...assignment.rosterSnapshot] };
  state.competitionSetup.groups[groupId] = {
    ...setup,
    activeHalf: null,
    halves: {
      ...setup.halves,
      first: {
        ...setup.halves.first,
        status: "closed",
        closedAt: now,
      },
    },
    revision: setup.revision + 1,
    updatedAt: now,
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  state.competitionSetup.revision += 1;
  state.judgeRoster = {
    ...state.judgeRoster,
    revision: state.judgeRoster.revision + 1,
    lockedAt: "",
    effectiveMode: "next_assignment",
    reason: "上半场结束，等待下半场",
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
    updatedAt: now,
  };
  state.activeAssignment = {
    groupId,
    teamId: null,
    status: "idle",
    assignmentRevision: assignment.assignmentRevision + 1,
    rosterRevision: clampInteger(assignment.rosterRevision) + 1,
    rosterSnapshot: [],
    rescoreRevision: clampInteger(assignment.rescoreRevision),
    rescoreAssignmentsByJudge: {},
    updatedAt: now,
    forcedReason: "",
  };
  return {
    previousSetup,
    completedSetup: state.competitionSetup.groups[groupId],
    previousAssignment,
    mutation: { type: "competition_setup", operation: "finish_first_half" },
  };
}

export function saveCompetitionSecondHalf(
  state,
  {
    groupId,
    teamIds,
    expectedRevision,
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const setup = getCompetitionGroupSetup(state, groupId);
  if (!setup) fail(404, "未知比赛组别");
  if (
    setup.status !== "open" ||
    state.competitionSetup.activeGroupId !== groupId ||
    setup.activeHalf !== null ||
    setup.halves?.first?.status !== "closed" ||
    setup.halves?.second?.status !== "draft"
  ) {
    fail(409, "只能在上半场结束后的中场休息期间配置下半场");
  }
  assertExpectedRevision(expectedRevision, setup.revision, "下半场配置已被其他管理员更新，请刷新后重试");
  const firstHalfTeamIds = getCompetitionHalfTeamIds(setup, "first");
  const normalizedTeamIds = validateCompetitionTeamSelection(state, groupId, teamIds, {
    excludedTeamIds: firstHalfTeamIds,
  });
  const previousSetup = cloneCompetitionGroupSetup(setup);
  state.competitionSetup.groups[groupId] = {
    ...setup,
    teamIds: [...firstHalfTeamIds, ...normalizedTeamIds],
    halves: {
      ...setup.halves,
      second: {
        ...setup.halves.second,
        status: "draft",
        teamIds: [...normalizedTeamIds],
        openedAt: "",
        closedAt: "",
      },
    },
    revision: setup.revision + 1,
    updatedAt: now,
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  state.competitionSetup.revision += 1;
  return {
    previousSetup,
    nextSetup: state.competitionSetup.groups[groupId],
    mutation: { type: "competition_setup", operation: "save_second_half" },
  };
}

export function openCompetitionSecondHalf(
  state,
  {
    groupId,
    expectedRevision,
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const setup = getCompetitionGroupSetup(state, groupId);
  if (!setup) fail(404, "未知比赛组别");
  if (
    setup.status !== "open" ||
    state.competitionSetup.activeGroupId !== groupId ||
    setup.activeHalf !== null ||
    setup.halves?.first?.status !== "closed" ||
    setup.halves?.second?.status !== "draft"
  ) {
    fail(409, "当前状态不能开启下半场");
  }
  assertExpectedRevision(expectedRevision, setup.revision, "下半场配置已被其他管理员更新，请刷新后重试");
  const secondHalfTeamIds = getCompetitionHalfTeamIds(setup, "second");
  if (!secondHalfTeamIds.length) fail(400, "请先选择并保存下半场参赛队伍");
  const eligibleTeamIds = getEligibleCompetitionTeamIds(state, groupId);
  if (secondHalfTeamIds.some((teamId) => !eligibleTeamIds.has(teamId))) {
    fail(409, "下半场配置中的队伍状态已变化，请重新核对参赛队伍");
  }
  assertTeamInformationReady(
    state,
    secondHalfTeamIds,
    "下半场队伍缺少报名编号或队伍名称，请先在队伍管理中补全资料",
  );
  const activeRoster = getActiveRoster(state);
  if (activeRoster.length < 3) fail(409, "下半场至少需要 3 位启用评委");
  const assignment = state.activeAssignment;
  if (assignment.teamId || Object.keys(getRescoreAssignments(assignment)).length) {
    fail(409, "仍有未结束的评分或重评任务，不能开启下半场");
  }
  state.competitionSetup.groups[groupId] = {
    ...setup,
    judgeIds: [...activeRoster],
    activeHalf: "second",
    halves: {
      ...setup.halves,
      second: {
        ...setup.halves.second,
        status: "open",
        openedAt: now,
        closedAt: "",
      },
    },
    revision: setup.revision + 1,
    updatedAt: now,
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  state.competitionSetup.revision += 1;
  state.judgeRoster = {
    ...state.judgeRoster,
    judgeIds: [...activeRoster],
    revision: state.judgeRoster.revision + 1,
    lockedAt: "",
    effectiveMode: "next_assignment",
    reason: "开启下半场",
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
    updatedAt: now,
  };
  state.activeAssignment = {
    ...assignment,
    groupId,
    teamId: null,
    status: "idle",
    assignmentRevision: assignment.assignmentRevision + 1,
    rosterRevision: clampInteger(assignment.rosterRevision) + 1,
    rosterSnapshot: [],
    updatedAt: now,
    forcedReason: "",
  };
  return {
    openedSetup: state.competitionSetup.groups[groupId],
    mutation: { type: "competition_setup", operation: "open_second_half" },
  };
}

export function closeCompetitionGroup(
  state,
  {
    groupId,
    expectedRevision,
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const setup = getCompetitionGroupSetup(state, groupId);
  if (!setup) fail(404, "未知比赛组别");
  if (setup.status !== "open" || state.competitionSetup.activeGroupId !== groupId) {
    fail(409, "只有当前已开启组别可以结束比赛");
  }
  if (setup.activeHalf !== "second" || setup.halves?.second?.status !== "open") {
    fail(409, "请先结束上半场并开启下半场，再结束本组比赛");
  }
  assertExpectedRevision(expectedRevision, setup.revision, "开赛配置已被其他管理员更新，请刷新后重试");
  const assignment = state.activeAssignment;
  if (Object.keys(getRescoreAssignments(assignment)).length) {
    fail(409, "仍有指定评委的历史重评任务未完成，不能结束本组比赛");
  }
  if (
    assignment.groupId === groupId &&
    assignment.teamId &&
    !["final", "closed"].includes(assignment.status)
  ) {
    fail(409, "当前派发评分尚未完成，不能结束本组比赛");
  }
  const unresolvedTeams = setup.teamIds.filter((teamId) => {
    const team = getTeamById(state, teamId);
    return !team || (team.status === "active" && !getCompositeSummary(state, teamId).isFinal);
  });
  if (unresolvedTeams.length) {
    fail(409, `本组仍有 ${unresolvedTeams.length} 支未完成队伍，不能结束比赛`);
  }
  const previousSetup = cloneCompetitionGroupSetup(setup);
  const previousAssignment = { ...assignment, rosterSnapshot: [...assignment.rosterSnapshot] };
  state.competitionSetup.groups[groupId] = {
    ...setup,
    status: "closed",
    activeHalf: null,
    halves: {
      ...setup.halves,
      second: {
        ...setup.halves.second,
        status: "closed",
        closedAt: now,
      },
    },
    revision: setup.revision + 1,
    closedAt: now,
    updatedAt: now,
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  state.competitionSetup.activeGroupId = null;
  state.competitionSetup.revision += 1;
  state.activeAssignment = {
    ...assignment,
    status: "closed",
    assignmentRevision: assignment.assignmentRevision + 1,
    updatedAt: now,
    forcedReason: "",
  };
  return {
    previousSetup,
    closedSetup: state.competitionSetup.groups[groupId],
    previousAssignment,
    mutation: { type: "competition_close", assignmentChanged: true },
  };
}

export function getCompetitionRestartImpact(state, groupId) {
  const teamIds = state.teams
    .filter((team) => team.groupId === groupId)
    .map((team) => team.id);
  const teamIdSet = new Set(teamIds);
  let entryCount = 0;
  Object.values(state.entriesByJudge).forEach((entries) => {
    Object.entries(entries ?? {}).forEach(([teamId, entry]) => {
      if (!teamIdSet.has(teamId)) return;
      const hasScores = Object.values(entry?.scores ?? {}).some(
        (score) => score !== "" && score !== null && score !== undefined,
      );
      if (entry?.submitted || clampInteger(entry?.serverRevision) > 0 || hasScores) {
        entryCount += 1;
      }
    });
  });
  return { teamIds, entryCount, hasScoringData: entryCount > 0 };
}

export function reopenCompetitionGroupForSetup(
  state,
  {
    groupId,
    expectedRevision,
    confirmClearScores = false,
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const setup = getCompetitionGroupSetup(state, groupId);
  if (!setup) fail(404, "未知比赛组别");
  if (setup.status === "draft") fail(409, "该组尚未开赛，可以直接调整配置");
  if (setup.status === "closed") fail(409, "该组比赛已经结束，历史赛次已锁定");
  assertExpectedRevision(expectedRevision, setup.revision, "开赛配置已被其他管理员更新，请刷新后重试");
  const activeGroupId = state.competitionSetup.activeGroupId;
  if (activeGroupId && activeGroupId !== groupId) {
    fail(409, "其他组别正在比赛，不能重开当前历史组别");
  }

  const restartImpact = getCompetitionRestartImpact(state, groupId);
  const groupTeamIds = restartImpact.teamIds;
  const groupTeamIdSet = new Set(groupTeamIds);
  const previousRescoreAssignments = getRescoreAssignments(state.activeAssignment);
  const remainingRescoreAssignments = Object.fromEntries(
    Object.entries(previousRescoreAssignments).filter(([, grant]) =>
      !groupTeamIdSet.has(grant?.teamId),
    ),
  );
  const clearedRescoreCount =
    Object.keys(previousRescoreAssignments).length -
    Object.keys(remainingRescoreAssignments).length;
  const clearedEntryCount = restartImpact.entryCount;
  const hadScoringData = restartImpact.hasScoringData;
  if (hadScoringData && !confirmClearScores) {
    fail(409, "本组已有评分数据，应急重新开赛需再次确认清除本组评分");
  }

  Object.keys(state.entriesByJudge).forEach((judgeId) => {
    const nextEntries = { ...(state.entriesByJudge[judgeId] ?? {}) };
    groupTeamIds.forEach((teamId) => delete nextEntries[teamId]);
    if (Object.keys(nextEntries).length) state.entriesByJudge[judgeId] = nextEntries;
    else delete state.entriesByJudge[judgeId];
  });
  state.teams.forEach((team) => {
    if (!groupTeamIdSet.has(team.id) || !team.judgeRosterSnapshot?.length) return;
    team.judgeRosterSnapshot = [];
    team.revision += 1;
    team.updatedAt = now;
  });
  state.competitionSetup.groups[groupId] = {
    ...setup,
    status: "draft",
    activeHalf: null,
    halves: {
      first: {
        status: "draft",
        teamIds: [...setup.teamIds],
        openedAt: "",
        closedAt: "",
      },
      second: {
        status: "draft",
        teamIds: [],
        openedAt: "",
        closedAt: "",
      },
    },
    revision: setup.revision + 1,
    openedAt: "",
    closedAt: "",
    updatedAt: now,
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  if (activeGroupId === groupId) state.competitionSetup.activeGroupId = null;
  state.competitionSetup.revision += 1;
  state.judgeRoster = {
    ...state.judgeRoster,
    judgeIds: [...setup.judgeIds],
    revision: state.judgeRoster.revision + 1,
    lockedAt: "",
    effectiveMode: "next_assignment",
    reason: hadScoringData ? "应急重新开赛" : "撤回开赛重新配置",
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
    updatedAt: now,
  };
  if (state.activeAssignment.groupId === groupId) {
    state.activeAssignment = {
      groupId,
      teamId: null,
      status: "idle",
      assignmentRevision: state.activeAssignment.assignmentRevision + 1,
      rosterRevision: clampInteger(state.activeAssignment.rosterRevision) + 1,
      rosterSnapshot: [],
      rescoreRevision:
        clampInteger(state.activeAssignment.rescoreRevision) +
        (clearedRescoreCount ? 1 : 0),
      rescoreAssignmentsByJudge: remainingRescoreAssignments,
      updatedAt: now,
      forcedReason: "",
    };
  } else if (clearedRescoreCount) {
    state.activeAssignment = {
      ...state.activeAssignment,
      rescoreRevision: clampInteger(state.activeAssignment.rescoreRevision) + 1,
      rescoreAssignmentsByJudge: remainingRescoreAssignments,
    };
  }
  let displayChanged = false;
  const revealedTeamIdsByGroup = cloneRevealedTeamIdsByGroup(state.displaySelection);
  const hadRevealedTeams = Boolean(revealedTeamIdsByGroup[groupId]?.length);
  if (hadRevealedTeams) revealedTeamIdsByGroup[groupId] = [];
  const transitionBelongsToGroup = state.displaySelection.rankingTransition?.groupId === groupId;
  if (groupTeamIdSet.has(state.displaySelection.teamId) || hadRevealedTeams || transitionBelongsToGroup) {
    const shouldWithdrawDisplay = groupTeamIdSet.has(state.displaySelection.teamId);
    state.displaySelection = {
      ...state.displaySelection,
      teamId: shouldWithdrawDisplay ? null : state.displaySelection.teamId,
      publicationStatus: shouldWithdrawDisplay ? "idle" : state.displaySelection.publicationStatus,
      displayRevision: state.displaySelection.displayRevision + 1,
      publishedAt: shouldWithdrawDisplay ? "" : state.displaySelection.publishedAt,
      updatedAt: now,
      revealedTeamIdsByGroup,
      rankingTransition: shouldWithdrawDisplay || transitionBelongsToGroup
        ? null
        : state.displaySelection.rankingTransition,
    };
    displayChanged = true;
  }
  return {
    hadScoringData,
    clearedEntryCount,
    reopenedSetup: state.competitionSetup.groups[groupId],
    mutation: {
      type: "competition_restart",
      teamIds: groupTeamIds,
      clearEntriesTeamIds: hadScoringData ? groupTeamIds : [],
      assignmentReset:
        state.activeAssignment.groupId === groupId || clearedRescoreCount > 0,
      displayInvalidated: displayChanged,
    },
    clearedRescoreCount,
  };
}

export function getAccountById(state, accountId) {
  return state.accounts.find((account) => account.id === accountId) ?? null;
}

export function replaceAssignmentJudge(
  state,
  {
    outgoingJudgeId,
    incomingJudgeId,
    expectedRosterRevision,
    reason = "",
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const assignment = state.activeAssignment;
  const team = getTeamById(state, assignment.teamId);
  if (!team || !["scoring", "awaiting_submissions", "final"].includes(assignment.status)) {
    fail(409, "当前没有可调整评委的派发队伍");
  }
  assertExpectedRevision(
    expectedRosterRevision,
    clampInteger(assignment.rosterRevision),
    "当前队评委快照已被其他管理员更新，请刷新后重试",
  );
  const normalizedReason = cleanReason(reason);
  if (normalizedReason.length < 3) fail(400, "应急替换评委必须填写至少 3 个字符的原因");
  if (!assignment.rosterSnapshot.includes(outgoingJudgeId)) {
    fail(409, "被替换评委不在当前队有效评委快照中");
  }
  const incomingJudge = getAccountById(state, incomingJudgeId);
  if (!incomingJudge || incomingJudge.role !== "judge" || incomingJudge.status !== "active") {
    fail(409, "替补账号必须是启用评委");
  }
  if (assignment.rosterSnapshot.includes(incomingJudgeId)) {
    fail(409, "替补评委已在当前队有效评委快照中");
  }

  const previousRoster = [...assignment.rosterSnapshot];
  const nextRoster = previousRoster.map((judgeId) =>
    judgeId === outgoingJudgeId ? incomingJudgeId : judgeId,
  );
  for (const judgeId of [outgoingJudgeId, incomingJudgeId]) {
    if (!state.entriesByJudge[judgeId]?.[team.id]) continue;
    const nextEntries = { ...state.entriesByJudge[judgeId] };
    delete nextEntries[team.id];
    if (Object.keys(nextEntries).length) state.entriesByJudge[judgeId] = nextEntries;
    else delete state.entriesByJudge[judgeId];
  }
  team.judgeRosterSnapshot = [...nextRoster];
  team.revision += 1;
  team.updatedAt = now;
  state.activeAssignment = {
    ...assignment,
    rosterSnapshot: [...nextRoster],
    rosterRevision: clampInteger(assignment.rosterRevision) + 1,
    updatedAt: now,
    forcedReason: normalizedReason,
  };
  updateAssignmentSubmissionStatus(state, now);
  const displayInvalidated = invalidateDisplayForReview(state, team.id, now);
  return {
    previousRoster,
    nextRoster,
    outgoingJudgeId,
    incomingJudgeId,
    reason: normalizedReason,
    mutation: {
      type: "assignment_roster_replace",
      teamIds: [team.id],
      clearEntryJudgeIds: [outgoingJudgeId, incomingJudgeId],
      clearEntryTeamId: team.id,
      displayInvalidated,
      actorId,
    },
  };
}

export function getTeamById(state, teamId) {
  return state.teams.find((team) => team.id === teamId) ?? null;
}

export function getJudgeAccounts(state) {
  return state.accounts.filter((account) => account.role === "judge");
}

export function updatePlannedRoster(
  state,
  {
    judgeIds,
    expectedRevision,
    reason = "",
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  assertExpectedRevision(expectedRevision, state.judgeRoster.revision, "计划评分名册已被其他管理员更新，请刷新后重试");
  if (!Array.isArray(judgeIds)) fail(400, "计划评分名册数据异常");
  const activeJudgeIds = new Set(
    getJudgeAccounts(state)
      .filter((account) => account.status === "active")
      .map((account) => account.id),
  );
  const normalizedIds = judgeIds.filter(
    (id) => typeof id === "string" && id && activeJudgeIds.has(id),
  );
  if (
    normalizedIds.length < 3 ||
    new Set(normalizedIds).size !== normalizedIds.length ||
    normalizedIds.length !== judgeIds.length
  ) {
    fail(400, "计划评分名册至少需要 3 位启用评委，且不能重复");
  }
  const previousRoster = [...state.judgeRoster.judgeIds];
  state.judgeRoster = {
    ...state.judgeRoster,
    judgeIds: normalizedIds,
    revision: state.judgeRoster.revision + 1,
    effectiveMode: state.activeAssignment.teamId
      ? "future_assignments"
      : "next_assignment",
    reason: cleanReason(reason),
    updatedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
    updatedAt: now,
  };
  return {
    previousRoster,
    nextRoster: [...normalizedIds],
    affectsCurrentAssignment: false,
    effectiveAfterAssignmentRevision: state.activeAssignment.assignmentRevision,
    mutation: { type: "roster" },
  };
}

export function enrollJudgeForFutureAssignments(
  state,
  {
    account,
    expectedRosterRevision,
    operationId,
    reason = "",
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const normalizedOperationId =
    typeof operationId === "string" ? operationId.trim().slice(0, 80) : "";
  if (!normalizedOperationId) fail(400, "临时增员操作缺少幂等标识");
  const normalizedExpectedRosterRevision = requireExpectedRevision(expectedRosterRevision);
  const operations = Array.isArray(state.judgeRoster.enrollmentOperations)
    ? state.judgeRoster.enrollmentOperations
    : [];
  const previousOperation = operations.find(
    (item) => item.operationId === normalizedOperationId,
  );
  if (previousOperation) {
    if (
      previousOperation.username !== account?.username ||
      previousOperation.displayName !== account?.displayName ||
      previousOperation.reason !== reason ||
      previousOperation.expectedRosterRevision !== normalizedExpectedRosterRevision
    ) {
      fail(409, "同一增员操作标识的请求内容不一致，请使用新的操作标识");
    }
    const replayedAccount = getAccountById(state, previousOperation.accountId);
    if (!replayedAccount) fail(409, "增员操作记录与账号状态不一致，请人工核对");
    return {
      account: replayedAccount,
      idempotentReplay: true,
      previousRoster: [...state.judgeRoster.judgeIds],
      nextRoster: [...state.judgeRoster.judgeIds],
      affectsCurrentAssignment: false,
      effectiveAfterAssignmentRevision:
        previousOperation.effectiveAfterAssignmentRevision,
      mutation: { type: "noop" },
    };
  }
  assertExpectedRevision(
    normalizedExpectedRosterRevision,
    state.judgeRoster.revision,
    "计划评分名册已被其他管理员更新，请刷新后重试",
  );
  if (
    !account ||
    typeof account.id !== "string" ||
    !account.id ||
    typeof account.username !== "string" ||
    !account.username ||
    account.role !== "judge" ||
    account.status !== "active"
  ) {
    fail(400, "临时评委账号数据异常");
  }
  if (
    state.accounts.some(
      (item) => item.id === account.id || item.username === account.username,
    )
  ) {
    fail(409, "账号已存在");
  }

  state.accounts.push(account);
  const rosterOutcome = updatePlannedRoster(state, {
    judgeIds: [...state.judgeRoster.judgeIds, account.id],
    expectedRevision: state.judgeRoster.revision,
    reason,
    actorId,
    now,
  });
  state.judgeRoster.enrollmentOperations = [
    ...operations,
    {
      operationId: normalizedOperationId,
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      reason,
      expectedRosterRevision: normalizedExpectedRosterRevision,
      credentialHash: account.passwordHash,
      rosterRevision: state.judgeRoster.revision,
      effectiveAfterAssignmentRevision:
        rosterOutcome.effectiveAfterAssignmentRevision,
      createdAt: now,
    },
  ];
  return {
    account,
    idempotentReplay: false,
    ...rosterOutcome,
    mutation: {
      type: "judge_enrollment",
      accountId: account.id,
      auditEvent: {
        eventId: normalizedOperationId,
        action: "judge_enrollment_create",
        actorId,
        targetId: account.id,
        details: {
          username: account.username,
          previousRosterRevision: state.judgeRoster.revision - 1,
          nextRosterRevision: state.judgeRoster.revision,
          previousRoster: rosterOutcome.previousRoster,
          nextRoster: rosterOutcome.nextRoster,
          rosterRevision: state.judgeRoster.revision,
          enrollmentMode: "future_assignments",
          affectsCurrentAssignment: false,
          effectiveAfterAssignmentRevision: rosterOutcome.effectiveAfterAssignmentRevision,
          reason,
        },
        createdAt: now,
      },
    },
  };
}

export function getTeamRoster(state, team) {
  const source = team?.judgeRosterSnapshot?.length ? team.judgeRosterSnapshot : state.judgeRoster.judgeIds;
  const judgeIds = new Set(getJudgeAccounts(state).map((account) => account.id));
  return [...new Set(source.filter((id) => judgeIds.has(id)))];
}

export function getEntry(state, judgeId, teamId) {
  return state.entriesByJudge[judgeId]?.[teamId] ?? createEntry();
}

export function getCompositeSummary(state, teamId) {
  const team = getTeamById(state, teamId);
  const roster = team ? getTeamRoster(state, team) : [];
  const accountsById = new Map(getJudgeAccounts(state).map((account) => [account.id, account]));
  const displayRoster = roster.toSorted((leftId, rightId) => {
    const leftUsername = accountsById.get(leftId)?.username ?? leftId;
    const rightUsername = accountsById.get(rightId)?.username ?? rightId;
    return leftUsername.localeCompare(rightUsername, "en", { numeric: true, sensitivity: "base" }) || leftId.localeCompare(rightId);
  });
  const submittedTotals = roster
    .map((judgeId) => {
      const entry = getEntry(state, judgeId, teamId);
      if (!entry.submitted) return null;
      const totalCents = getEntryTotalCents(entry);
      return { judgeId, totalCents, score: formatCents(totalCents) };
    })
    .filter(Boolean)
    .sort((left, right) => left.totalCents - right.totalCents || left.judgeId.localeCompare(right.judgeId));
  const anonymousScores = displayRoster.map((judgeId) => {
    const entry = getEntry(state, judgeId, teamId);
    return entry.submitted ? { submitted: true, score: formatCents(getEntryTotalCents(entry)) } : { submitted: false, score: "--" };
  });
  const hasEnoughJudges = roster.length >= 3;
  const isFinal = hasEnoughJudges && submittedTotals.length === roster.length;
  if (submittedTotals.length < 3 || !hasEnoughJudges) {
    return {
      rosterCount: roster.length,
      submittedCount: submittedTotals.length,
      display: "--",
      status: hasEnoughJudges ? "至少 3 位评委提交后计算" : "有效评委不足 3 位，不能计算综合分",
      high: null,
      low: null,
      anonymousScores,
      isFinal: false,
    };
  }
  const composite = calculateCompositeCents(submittedTotals.map((item) => item.totalCents));
  return {
    rosterCount: roster.length,
    submittedCount: submittedTotals.length,
    display: formatCents(composite.compositeCents),
    status: isFinal ? "最终综合分" : "暂算综合分",
    high: { score: formatCents(composite.highCents) },
    low: { score: formatCents(composite.lowCents) },
    anonymousScores,
    isFinal,
  };
}

export function updateAssignmentSubmissionStatus(state, now = new Date().toISOString()) {
  const assignment = state.activeAssignment;
  if (!assignment.teamId || assignment.status === "closed") return false;
  const summary = getCompositeSummary(state, assignment.teamId);
  const nextStatus = summary.isFinal ? "final" : summary.submittedCount > 0 ? "awaiting_submissions" : "scoring";
  if (assignment.status === nextStatus) return false;
  assignment.status = nextStatus;
  assignment.updatedAt = now;
  return true;
}

export function invalidateDisplayForReview(
  state,
  teamId,
  now = new Date().toISOString(),
  { includeTemporary = false } = {},
) {
  const reviewableStatuses = includeTemporary
    ? ["final", "temporary", "review_required"]
    : ["final"];
  const invalidatesCurrentDisplay =
    state.displaySelection.teamId === teamId &&
    reviewableStatuses.includes(state.displaySelection.publicationStatus);
  const revealedTeamIdsByGroup = cloneRevealedTeamIdsByGroup(state.displaySelection);
  let removedFromRankingHistory = false;
  if (invalidatesCurrentDisplay || includeTemporary) {
    Object.keys(revealedTeamIdsByGroup).forEach((groupId) => {
      const previousTeamIds = revealedTeamIdsByGroup[groupId] ?? [];
      const nextTeamIds = previousTeamIds.filter((id) => id !== teamId);
      if (nextTeamIds.length !== previousTeamIds.length) removedFromRankingHistory = true;
      revealedTeamIdsByGroup[groupId] = nextTeamIds;
    });
  }
  const transitionReferencesTeam = [
    state.displaySelection.rankingTransition?.fromTeamId,
    state.displaySelection.rankingTransition?.toTeamId,
  ].includes(teamId) || state.displaySelection.rankingTransition?.teamIds?.includes(teamId);
  const clearsRankingTransition = invalidatesCurrentDisplay || removedFromRankingHistory ||
    (includeTemporary && transitionReferencesTeam);
  if (!invalidatesCurrentDisplay && !removedFromRankingHistory && !clearsRankingTransition) return false;
  state.displaySelection = {
    ...state.displaySelection,
    publicationStatus: invalidatesCurrentDisplay
      ? "review_required"
      : state.displaySelection.publicationStatus,
    displayRevision: state.displaySelection.displayRevision + 1,
    updatedAt: now,
    revealedTeamIdsByGroup,
    rankingTransition: clearsRankingTransition
      ? null
      : state.displaySelection.rankingTransition,
  };
  return true;
}

export function startJudgeRescore(
  state,
  {
    teamId,
    judgeId,
    mode,
    expectedEntryRevision,
    reason = "",
    actorId = "",
    now = new Date().toISOString(),
  },
) {
  const assignment = state.activeAssignment;
  const team = getTeamById(state, teamId);
  const judge = getAccountById(state, judgeId);
  if (!team || !judge || judge.role !== "judge") fail(404, "未知评委或队伍");
  if (judge.status !== "active") fail(409, "只能给启用中的评委安排历史重评");
  if (team.status !== "active") fail(409, "退赛或归档队伍不能安排历史重评");
  const setup = getCompetitionGroupSetup(state, team.groupId);
  if (
    !setup ||
    setup.status !== "open" ||
    state.competitionSetup.activeGroupId !== team.groupId ||
    !setup.teamIds.includes(team.id)
  ) {
    fail(409, "只能重评当前已开启赛次中的历史队伍");
  }
  if (assignment.teamId === team.id) {
    fail(409, "当前正在评分的队伍请使用当前队应急撤回，无需创建历史重评任务");
  }
  if (!team.judgeRosterSnapshot?.includes(judge.id)) {
    fail(409, "该评委不在此队冻结评委名册中");
  }
  const normalizedMode = mode === "retain" || mode === "clear" ? mode : "";
  if (!normalizedMode) fail(400, "历史重评模式无效");
  const normalizedReason = cleanReason(reason);
  if (normalizedReason.length < 3) fail(400, "历史重评必须填写至少 3 个字符的原因");

  const rescoreAssignments = getRescoreAssignments(assignment);
  if (rescoreAssignments[judge.id]) {
    fail(409, "该评委已有未完成的历史重评任务");
  }
  const summary = getCompositeSummary(state, team.id);
  if (!summary.isFinal && !hasRescoreForTeam(assignment, team.id)) {
    fail(409, "该队尚未形成最终成绩，不能作为历史队开启重评");
  }
  const previousEntry = getEntry(state, judge.id, team.id);
  assertExpectedRevision(
    expectedEntryRevision,
    previousEntry.serverRevision,
    "该评委的历史评分已更新，请刷新后重试",
  );
  if (!previousEntry.submitted) {
    fail(409, "该评委的历史评分当前不是已提交状态");
  }

  const resetEntry = normalizedMode === "clear" ? createEntry() : previousEntry;
  const persistedEntry = {
    ...sanitizeEntry(resetEntry),
    submitted: false,
    updatedAt: now,
    serverRevision: previousEntry.serverRevision + 1,
    serverUpdatedAt: now,
  };
  const grant = {
    teamId: team.id,
    mode: normalizedMode,
    revision: persistedEntry.serverRevision,
    reason: normalizedReason,
    startedAt: now,
    startedBy: typeof actorId === "string" ? actorId.slice(0, 32) : "",
  };
  state.entriesByJudge[judge.id] = {
    ...(state.entriesByJudge[judge.id] ?? {}),
    [team.id]: persistedEntry,
  };
  state.activeAssignment = {
    ...assignment,
    rescoreRevision: clampInteger(assignment.rescoreRevision) + 1,
    rescoreAssignmentsByJudge: {
      ...rescoreAssignments,
      [judge.id]: grant,
    },
  };
  const displayInvalidated = invalidateDisplayForReview(
    state,
    team.id,
    now,
    { includeTemporary: true },
  );
  return {
    previousEntry,
    persistedEntry,
    grant,
    mode: normalizedMode,
    reason: normalizedReason,
    displayInvalidated,
    mutation: {
      type: "entry",
      judgeId: judge.id,
      teamId: team.id,
      rescoreChanged: true,
      displayInvalidated,
    },
  };
}

export function dispatchAssignment(state, { teamId, expectedRevision, force = false, reason = "", now = new Date().toISOString() }) {
  const assignment = state.activeAssignment;
  assertExpectedRevision(expectedRevision, assignment.assignmentRevision, "当前派发已被其他管理员更新，请刷新后重试");
  const targetTeam = getTeamById(state, teamId);
  if (!targetTeam) fail(404, "未知队伍");
  if (targetTeam.status !== "active") fail(409, "退赛或归档队伍不能派发评分");
  const activeGroupId = state.competitionSetup?.activeGroupId;
  const activeSetup = activeGroupId ? getCompetitionGroupSetup(state, activeGroupId) : null;
  if (!activeSetup || activeSetup.status !== "open") fail(409, "请先在开赛配置中开启比赛组别");
  const activeHalfTeamIds = getActiveCompetitionHalfTeamIds(activeSetup);
  if (!activeSetup.activeHalf || !activeHalfTeamIds.length) {
    fail(409, "当前处于中场休息，请先配置并开启下半场");
  }
  if (targetTeam.groupId !== activeGroupId || !activeHalfTeamIds.includes(targetTeam.id)) {
    fail(409, "该队伍不在当前半场的派发范围内");
  }
  if (assignment.teamId === targetTeam.id) {
    fail(409, "该队已处于当前派发状态，无需重复派发");
  }
  if (hasRescoreForTeam(assignment, targetTeam.id)) {
    fail(409, "该队仍有指定评委的历史重评任务，不能同时作为当前派发队伍");
  }

  const previousAssignment = { ...assignment, rosterSnapshot: [...assignment.rosterSnapshot] };
  const forcedReason = cleanReason(reason);
  const isReplacingIncompleteAssignment = assignment.teamId && assignment.teamId !== targetTeam.id && assignment.status !== "final" && assignment.status !== "closed";
  if (isReplacingIncompleteAssignment && !force) fail(409, "上一队尚未完成有效名册提交，不能派发下一队");

  const roster = getActiveRoster(state);
  if (roster.length < 3) fail(409, "有效评分名册不足 3 位启用评委，不能派发");
  const didLockRoster = !state.judgeRoster.lockedAt;
  if (didLockRoster) {
    state.judgeRoster = { ...state.judgeRoster, lockedAt: now, updatedAt: now };
  }
  const didCreateTeamSnapshot = !targetTeam.judgeRosterSnapshot?.length;
  if (didCreateTeamSnapshot) {
    targetTeam.judgeRosterSnapshot = [...roster];
    targetTeam.revision += 1;
    targetTeam.updatedAt = now;
  }
  state.activeAssignment = {
    groupId: targetTeam.groupId,
    teamId: targetTeam.id,
    status: "scoring",
    assignmentRevision: assignment.assignmentRevision + 1,
    rosterRevision: clampInteger(assignment.rosterRevision) + 1,
    rosterSnapshot: [...targetTeam.judgeRosterSnapshot],
    rescoreRevision: clampInteger(assignment.rescoreRevision),
    rescoreAssignmentsByJudge: { ...getRescoreAssignments(assignment) },
    updatedAt: now,
    forcedReason: isReplacingIncompleteAssignment ? forcedReason : "",
  };
  updateAssignmentSubmissionStatus(state, now);
  return {
    previousAssignment,
    forced: Boolean(isReplacingIncompleteAssignment),
    reason: isReplacingIncompleteAssignment ? forcedReason : "",
    mutation: {
      type: "assignment",
      teamIds: didCreateTeamSnapshot ? [teamId] : [],
      rosterChanged: didLockRoster,
    },
  };
}

export function publishDisplaySelection(state, { teamId, publicationStatus, expectedRevision, now = new Date().toISOString() }) {
  assertExpectedRevision(expectedRevision, state.displaySelection.displayRevision, "成绩展示已被其他管理员更新，请刷新后重试");
  const previousSelection = { ...state.displaySelection };
  const revealedTeamIdsByGroup = cloneRevealedTeamIdsByGroup(state.displaySelection);
  if (publicationStatus === "idle" || !teamId) {
    state.displaySelection = {
      ...state.displaySelection,
      teamId: null,
      publicationStatus: "idle",
      projectionView: "slogan",
      displayRevision: state.displaySelection.displayRevision + 1,
      publishedAt: "",
      updatedAt: now,
      revealedTeamIdsByGroup,
      rankingTransition: null,
    };
    return { previousSelection, mutation: { type: "display" } };
  }
  const team = getTeamById(state, teamId);
  if (!team) fail(404, "未知队伍");
  if (team.status !== "active") fail(409, "退赛或归档队伍不能发布成绩展示");
  const summary = getCompositeSummary(state, team.id);
  if (publicationStatus === "final" && !summary.isFinal) fail(409, "该队尚未形成最终综合分，不能发布到大屏");
  if (publicationStatus === "temporary" && summary.submittedCount < 1) fail(409, "至少 1 位评委提交后才能临时发布");
  if (publicationStatus === "waiting" && summary.submittedCount !== 0) fail(409, "已有评委提交的队伍不能作为待评分队伍展示");
  if (!["final", "temporary", "waiting"].includes(publicationStatus)) fail(400, "成绩展示状态无效");
  if (isRankingTransitionActive(state.displaySelection)) {
    fail(409, "实时排名正在展示，请先在大屏按右键继续");
  }
  const previousTeam = getTeamById(state, state.displaySelection.teamId);
  const previousTeamWasDisplayed = Boolean(
    previousTeam &&
      state.displaySelection.projectionView === "scoreboard" &&
      ["final", "temporary", "waiting"].includes(state.displaySelection.publicationStatus),
  );
  const isTeamChange = previousTeamWasDisplayed && previousTeam.id !== team.id;
  if (
    previousTeamWasDisplayed &&
    getCompositeSummary(state, previousTeam.id).submittedCount > 0
  ) {
    revealedTeamIdsByGroup[previousTeam.groupId] = [
      ...new Set([...(revealedTeamIdsByGroup[previousTeam.groupId] ?? []), previousTeam.id]),
    ];
  }
  const transitionTeamIds = isTeamChange
    ? [...(revealedTeamIdsByGroup[previousTeam.groupId] ?? [])]
    : [];
  const shouldAnimateRanking = Boolean(
    state.displaySelection.rankingAnimationEnabled === true &&
      isTeamChange &&
      getCompositeSummary(state, previousTeam.id).submittedCount > 0 &&
      transitionTeamIds.some((id) => getCompositeSummary(state, id).submittedCount > 0),
  );
  if (summary.submittedCount > 0) {
    revealedTeamIdsByGroup[team.groupId] = [
      ...new Set([...(revealedTeamIdsByGroup[team.groupId] ?? []), team.id]),
    ];
  }
  const nextRevision = state.displaySelection.displayRevision + 1;
  state.displaySelection = {
    ...state.displaySelection,
    teamId: team.id,
    publicationStatus,
    projectionView: "scoreboard",
    rankingGroupId: team.groupId,
    displayRevision: nextRevision,
    publishedAt: now,
    updatedAt: now,
    revealedTeamIdsByGroup,
    rankingTransition: shouldAnimateRanking
      ? {
          transitionRevision: nextRevision,
          groupId: previousTeam.groupId,
          fromTeamId: previousTeam.id,
          toTeamId: team.id,
          startedAt: now,
          durationMs: getDisplayRankingTransitionDurationMs(
            state,
            previousTeam.groupId,
            transitionTeamIds,
            previousTeam.id,
          ),
          teamIds: transitionTeamIds,
        }
      : null,
  };
  return { previousSelection, mutation: { type: "display" } };
}

function moveDisplayToAdjacentTeam(
  state,
  { expectedRevision, now = new Date().toISOString() },
  offset,
) {
  assertExpectedRevision(expectedRevision, state.displaySelection.displayRevision, "大屏展示已更新，请稍后再试");
  if (state.displaySelection.projectionView !== "scoreboard" || !state.displaySelection.teamId) {
    fail(409, "当前大屏不在队伍成绩页");
  }
  const currentTeam = getTeamById(state, state.displaySelection.teamId);
  if (!currentTeam) fail(409, "当前大屏队伍已不存在");
  const setup = getCompetitionGroupSetup(state, currentTeam.groupId);
  const displayScopeTeamIds = new Set(getCompetitionRankingScope(setup).teamIds);
  const orderedTeams = getOrderedSetupTeams(state, currentTeam.groupId)
    .filter((team) => displayScopeTeamIds.has(team.id));
  const currentIndex = orderedTeams.findIndex((team) => team.id === currentTeam.id);
  if (currentIndex < 0) fail(409, "当前队伍不在本组已配置的参赛范围内");
  const targetTeam = orderedTeams[currentIndex + offset] ?? null;
  const isPrevious = offset < 0;
  if (!targetTeam) {
    return {
      previousSelection: { ...state.displaySelection },
      changed: false,
      reason: isPrevious ? "start_of_group" : "end_of_group",
      fromTeamId: currentTeam.id,
      toTeamId: null,
      publicationStatus: state.displaySelection.publicationStatus,
      mutation: { type: "noop" },
    };
  }
  const summary = getCompositeSummary(state, targetTeam.id);
  const publicationStatus = summary.isFinal
    ? "final"
    : summary.submittedCount > 0
      ? "temporary"
      : "waiting";
  const outcome = publishDisplaySelection(state, {
    teamId: targetTeam.id,
    publicationStatus,
    expectedRevision,
    now,
  });
  return {
    ...outcome,
    changed: true,
    reason: isPrevious ? "rewound" : "advanced",
    fromTeamId: currentTeam.id,
    toTeamId: targetTeam.id,
    publicationStatus,
  };
}

export function advanceDisplayToNextTeam(
  state,
  options,
) {
  return moveDisplayToAdjacentTeam(state, options, 1);
}

export function advanceDisplayToPreviousTeam(
  state,
  options,
) {
  return moveDisplayToAdjacentTeam(state, options, -1);
}

export function showDisplayRankings(state, { groupId, expectedRevision, now = new Date().toISOString() }) {
  assertExpectedRevision(expectedRevision, state.displaySelection.displayRevision, "成绩展示已被其他管理员更新，请刷新后重试");
  if (!groupId || !state.competitionSetup?.groups?.[groupId]) fail(400, "总排名展示组别无效");
  const previousSelection = { ...state.displaySelection };
  state.displaySelection = {
    ...state.displaySelection,
    projectionView: "rankings",
    rankingGroupId: groupId,
    rankingTransition: null,
    displayRevision: state.displaySelection.displayRevision + 1,
    updatedAt: now,
  };
  return { previousSelection, mutation: { type: "display" } };
}

export function updateDisplayRankingAnimation(
  state,
  { enabled, expectedRevision, now = new Date().toISOString() },
) {
  assertExpectedRevision(expectedRevision, state.displaySelection.displayRevision, "成绩展示已被其他管理员更新，请刷新后重试");
  if (typeof enabled !== "boolean") fail(400, "实时排名动画开关无效");
  const previousSelection = { ...state.displaySelection };
  if (state.displaySelection.rankingAnimationEnabled === enabled) {
    return { previousSelection, changed: false, mutation: { type: "noop" } };
  }
  state.displaySelection = {
    ...state.displaySelection,
    rankingAnimationEnabled: enabled,
    rankingTransition: null,
    displayRevision: state.displaySelection.displayRevision + 1,
    updatedAt: now,
  };
  return { previousSelection, changed: true, mutation: { type: "display" } };
}

export function advanceDisplayRankingTransition(
  state,
  { transitionRevision, now = new Date().toISOString() },
) {
  const expectedTransitionRevision = requireExpectedRevision(transitionRevision);
  const currentTransition = state.displaySelection.rankingTransition;
  const previousSelection = { ...state.displaySelection };
  if (!currentTransition) {
    return { previousSelection, changed: false, mutation: { type: "noop" } };
  }
  if (currentTransition.transitionRevision !== expectedTransitionRevision) {
    fail(409, "大屏排名过场已更新，请稍后再试");
  }
  state.displaySelection = {
    ...state.displaySelection,
    rankingTransition: null,
    displayRevision: state.displaySelection.displayRevision + 1,
    updatedAt: now,
  };
  return { previousSelection, changed: true, mutation: { type: "display" } };
}

export function writeScoreEntry(state, { actor, judgeId, teamId, entry, assignmentRevision, now = new Date().toISOString() }) {
  const judge = getAccountById(state, judgeId);
  const team = getTeamById(state, teamId);
  if (!judge || judge.role !== "judge" || !team) fail(404, "未知评委或队伍");
  if (!actor || !["admin", "judge"].includes(actor.role)) fail(403, "当前账号无权执行该操作");
  const groupSetup = getCompetitionGroupSetup(state, team.groupId);
  if (groupSetup?.status === "closed") {
    fail(409, "本组比赛已结束并锁定，不能修改历史评分");
  }
  const assignment = state.activeAssignment;
  const activeRescoreGrant = getRescoreAssignments(assignment)[judgeId] ?? null;
  const isJudgeRescore =
    actor.role === "judge" && activeRescoreGrant?.teamId === teamId;
  if (actor.role === "admin" && activeRescoreGrant?.teamId === teamId) {
    fail(409, "该评分正由指定评委重评，请等待重评提交后再处置");
  }
  if (actor.role === "judge") {
    if (actor.id !== judgeId) fail(403, "评委只能提交自己的评分");
    if (
      !groupSetup ||
      groupSetup.status !== "open" ||
      state.competitionSetup.activeGroupId !== team.groupId
    ) {
      fail(409, "当前组比赛已结束，请等待管理员开启新的评分派发");
    }
    if (activeRescoreGrant && !isJudgeRescore) {
      fail(409, "管理员已安排历史队重评，完成后才能继续当前队评分");
    }
    if (isJudgeRescore) {
      assertExpectedRevision(
        assignmentRevision,
        activeRescoreGrant.revision,
        "历史重评任务已更新，请先同步后再评分",
      );
      if (!team.judgeRosterSnapshot?.includes(judgeId)) {
        fail(403, "当前账号不在该队冻结评委名册中");
      }
    } else {
      if (assignment.teamId !== teamId || !["scoring", "awaiting_submissions"].includes(assignment.status)) {
        fail(409, "当前队伍已由管理员切换，请等待新的评分派发");
      }
      assertExpectedRevision(assignmentRevision, assignment.assignmentRevision, "当前派发已更新，请先同步后再评分");
      if (!assignment.rosterSnapshot.includes(judgeId)) fail(403, "当前账号不在本队有效评分名册中");
    }
  }

  const savedEntry = sanitizeEntry(entry);
  const previousEntry = getEntry(state, judgeId, teamId);
  if (actor.role === "judge" && previousEntry.submitted && !isJudgeRescore) fail(409, "已提交评分需管理员撤回后修改");
  if (savedEntry.serverRevision !== previousEntry.serverRevision) fail(409, "评分已被其他设备更新，请同步后重试");
  const persistedEntry = {
    ...savedEntry,
    updatedAt: now,
    serverRevision: previousEntry.serverRevision + 1,
    serverUpdatedAt: now,
  };
  state.entriesByJudge[judgeId] = { ...(state.entriesByJudge[judgeId] ?? {}), [teamId]: persistedEntry };
  const assignmentChanged = (
    groupSetup?.status === "open" &&
    state.competitionSetup.activeGroupId === team.groupId &&
    state.activeAssignment.teamId === teamId &&
    ["scoring", "awaiting_submissions", "final"].includes(state.activeAssignment.status)
  ) && updateAssignmentSubmissionStatus(state, now);
  let rescoreCompleted = false;
  if (isJudgeRescore && persistedEntry.submitted) {
    const nextRescoreAssignments = {
      ...getRescoreAssignments(state.activeAssignment),
    };
    delete nextRescoreAssignments[judgeId];
    state.activeAssignment = {
      ...state.activeAssignment,
      rescoreRevision: clampInteger(state.activeAssignment.rescoreRevision) + 1,
      rescoreAssignmentsByJudge: nextRescoreAssignments,
    };
    rescoreCompleted = true;
  }
  const displayInvalidated = invalidateDisplayForReview(
    state,
    teamId,
    now,
    { includeTemporary: actor.role === "admin" || isJudgeRescore },
  );
  return {
    previousEntry,
    persistedEntry,
    assignmentChanged,
    rescoreCompleted,
    rescoreActive: isJudgeRescore && !rescoreCompleted,
    rescoreMode: isJudgeRescore ? activeRescoreGrant.mode : null,
    rescoreRevision: isJudgeRescore ? activeRescoreGrant.revision : null,
    displayInvalidated,
    mutation: {
      type: "entry",
      judgeId,
      teamId,
      assignmentChanged,
      ...(rescoreCompleted ? { rescoreChanged: true } : {}),
      displayInvalidated,
    },
  };
}
