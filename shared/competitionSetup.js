import { contestGroups } from "./contestData.js";

export const competitionHalfIds = ["first", "second"];

export function getOrderedSetupTeams(state, groupId) {
  const configuredTeamIds = new Set(state.competitionSetup?.groups?.[groupId]?.teamIds ?? []);
  return (state.teams ?? [])
    .filter((team) => team.groupId === groupId && team.status === "active" && configuredTeamIds.has(team.id))
    .sort((left, right) => left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id));
}

export function getCompetitionHalfTeamIds(setup, halfId) {
  if (!competitionHalfIds.includes(halfId)) return [];
  const teamIds = setup?.halves?.[halfId]?.teamIds;
  if (Array.isArray(teamIds)) return [...teamIds];
  return halfId === "first" && Array.isArray(setup?.teamIds) ? [...setup.teamIds] : [];
}

export function getActiveCompetitionHalfTeamIds(setup) {
  return setup?.activeHalf
    ? getCompetitionHalfTeamIds(setup, setup.activeHalf)
    : [];
}

export function getCompetitionRankingScope(setup) {
  const secondHalf = setup?.halves?.second;
  const isOverall = Boolean(
    setup?.activeHalf === "second" ||
    secondHalf?.status === "open" ||
    secondHalf?.status === "closed" ||
    secondHalf?.openedAt,
  );
  return {
    id: isOverall ? "overall" : "first_half",
    label: isOverall ? "上下半场累计" : "仅上半场",
    title: isOverall ? "总排名" : "上半场排名",
    teamIds: isOverall
      ? [...(setup?.teamIds ?? [])]
      : getCompetitionHalfTeamIds(setup, "first"),
  };
}

export function getOrderedActiveHalfTeams(state, groupId) {
  const setup = state.competitionSetup?.groups?.[groupId];
  const activeTeamIds = new Set(getActiveCompetitionHalfTeamIds(setup));
  return getOrderedSetupTeams(state, groupId).filter((team) => activeTeamIds.has(team.id));
}

function defaultNormalizeId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,32}$/.test(id) ? id : "";
}

function defaultClampInteger(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : 0;
}

export function normalizeCompetitionSetup(
  rawSetup,
  state,
  {
    normalizeTeamId = defaultNormalizeId,
    normalizeJudgeId = defaultNormalizeId,
    clampInteger = defaultClampInteger,
  } = {},
) {
  const allJudges = state.accounts.filter((account) => account.role === "judge");
  const knownJudgeIds = new Set(allJudges.map((account) => account.id));
  const activeJudgeIds = allJudges
    .filter((account) => account.status === "active")
    .map((account) => account.id);
  const legacyActiveGroupId = state.activeAssignment?.teamId
    ? state.activeAssignment.groupId
    : null;

  const groups = Object.fromEntries(
    contestGroups.map((group) => {
      const groupTeams = state.teams
        .filter((team) => team.groupId === group.id)
        .sort((left, right) => left.appearanceOrder - right.appearanceOrder);
      const knownTeamIds = new Set(groupTeams.map((team) => team.id));
      const activeTeamIds = groupTeams
        .filter((team) => team.status === "active")
        .map((team) => team.id);
      const rawGroup = rawSetup?.groups?.[group.id];
      const legacyOpen = !rawGroup && legacyActiveGroupId === group.id;
      const status = ["draft", "open", "closed"].includes(rawGroup?.status)
        ? rawGroup.status
        : legacyOpen
          ? "open"
          : "draft";
      const hasSavedTeamIds = Array.isArray(rawGroup?.teamIds);
      const hasSavedJudgeIds = Array.isArray(rawGroup?.judgeIds);
      const teamIds = hasSavedTeamIds
        ? rawGroup.teamIds
            .map((id) => normalizeTeamId(id))
            .filter((id, index, values) => knownTeamIds.has(id) && values.indexOf(id) === index)
        : activeTeamIds;
      const judgeIds = hasSavedJudgeIds
        ? rawGroup.judgeIds
            .map((id) => normalizeJudgeId(id))
            .filter((id, index, values) => knownJudgeIds.has(id) && values.indexOf(id) === index)
        : legacyOpen && state.activeAssignment.rosterSnapshot.length
          ? [...state.activeAssignment.rosterSnapshot]
          : [...activeJudgeIds];
      const normalizeHalfTeamIds = (value) =>
        (Array.isArray(value) ? value : [])
          .map((id) => normalizeTeamId(id))
          .filter((id, index, values) => knownTeamIds.has(id) && values.indexOf(id) === index);
      const hasSavedHalves = rawGroup?.halves && typeof rawGroup.halves === "object" && !Array.isArray(rawGroup.halves);
      let firstTeamIds = hasSavedHalves
        ? normalizeHalfTeamIds(rawGroup.halves?.first?.teamIds)
        : [...teamIds];
      let secondTeamIds = hasSavedHalves
        ? normalizeHalfTeamIds(rawGroup.halves?.second?.teamIds)
        : [];
      if (hasSavedHalves && !firstTeamIds.length && !secondTeamIds.length && teamIds.length) {
        firstTeamIds = [...teamIds];
      }
      const firstTeamIdSet = new Set(firstTeamIds);
      secondTeamIds = secondTeamIds.filter((id) => !firstTeamIdSet.has(id));
      const normalizeHalfStatus = (value, fallback) =>
        ["draft", "open", "closed"].includes(value) ? value : fallback;
      let firstStatus = hasSavedHalves
        ? normalizeHalfStatus(rawGroup.halves?.first?.status, status === "open" ? "open" : status === "closed" ? "closed" : "draft")
        : status === "open"
          ? "open"
          : status === "closed"
            ? "closed"
            : "draft";
      let secondStatus = hasSavedHalves
        ? normalizeHalfStatus(rawGroup.halves?.second?.status, "draft")
        : "draft";
      let activeHalf = competitionHalfIds.includes(rawGroup?.activeHalf)
        ? rawGroup.activeHalf
        : null;
      if (status === "draft") {
        activeHalf = null;
        firstStatus = "draft";
        secondStatus = "draft";
      } else if (status === "closed") {
        activeHalf = null;
        if (firstStatus === "open") firstStatus = "closed";
        if (secondStatus === "open") secondStatus = "closed";
      } else {
        if (!activeHalf) {
          if (firstStatus === "open") activeHalf = "first";
          else if (secondStatus === "open") activeHalf = "second";
          else if (firstStatus !== "closed") activeHalf = "first";
        }
        if (activeHalf === "first") {
          firstStatus = "open";
          if (secondStatus === "open") secondStatus = "draft";
        } else if (activeHalf === "second") {
          firstStatus = "closed";
          secondStatus = "open";
        }
      }
      const halves = {
        first: {
          status: firstStatus,
          teamIds: firstTeamIds,
          openedAt: typeof rawGroup?.halves?.first?.openedAt === "string"
            ? rawGroup.halves.first.openedAt.slice(0, 64)
            : !hasSavedHalves && status !== "draft"
              ? typeof rawGroup?.openedAt === "string" ? rawGroup.openedAt.slice(0, 64) : ""
              : "",
          closedAt: typeof rawGroup?.halves?.first?.closedAt === "string"
            ? rawGroup.halves.first.closedAt.slice(0, 64)
            : !hasSavedHalves && status === "closed"
              ? typeof rawGroup?.closedAt === "string" ? rawGroup.closedAt.slice(0, 64) : ""
              : "",
        },
        second: {
          status: secondStatus,
          teamIds: secondTeamIds,
          openedAt: typeof rawGroup?.halves?.second?.openedAt === "string" ? rawGroup.halves.second.openedAt.slice(0, 64) : "",
          closedAt: typeof rawGroup?.halves?.second?.closedAt === "string" ? rawGroup.halves.second.closedAt.slice(0, 64) : "",
        },
      };
      const cumulativeTeamIds = [...new Set([...halves.first.teamIds, ...halves.second.teamIds])];
      return [
        group.id,
        {
          groupId: group.id,
          status,
          teamIds: cumulativeTeamIds,
          judgeIds,
          activeHalf,
          halves,
          revision: clampInteger(rawGroup?.revision),
          openedAt: typeof rawGroup?.openedAt === "string" ? rawGroup.openedAt.slice(0, 64) : "",
          closedAt: typeof rawGroup?.closedAt === "string" ? rawGroup.closedAt.slice(0, 64) : "",
          updatedAt: typeof rawGroup?.updatedAt === "string" ? rawGroup.updatedAt.slice(0, 64) : "",
          updatedBy: defaultNormalizeId(rawGroup?.updatedBy),
        },
      ];
    }),
  );
  const hasSavedActiveGroupId =
    rawSetup && Object.prototype.hasOwnProperty.call(rawSetup, "activeGroupId");
  const requestedActiveGroupId = hasSavedActiveGroupId
    ? contestGroups.some((group) => group.id === rawSetup.activeGroupId)
      ? rawSetup.activeGroupId
      : null
    : legacyActiveGroupId;
  const openGroupIds = Object.values(groups)
    .filter((group) => group.status === "open")
    .map((group) => group.groupId);
  if (requestedActiveGroupId && groups[requestedActiveGroupId]?.status !== "open") {
    throw new Error("比赛状态异常：当前组别指针指向未开启组别");
  }
  if (openGroupIds.length > 1) {
    throw new Error("比赛状态异常：只能有一个已开启组别");
  }
  if (openGroupIds.length === 1 && openGroupIds[0] !== requestedActiveGroupId) {
    throw new Error("比赛状态异常：已开启组别与当前组别指针不一致");
  }
  return {
    activeGroupId:
      requestedActiveGroupId && groups[requestedActiveGroupId]?.status === "open"
        ? requestedActiveGroupId
        : null,
    revision: clampInteger(rawSetup?.revision),
    groups,
  };
}
