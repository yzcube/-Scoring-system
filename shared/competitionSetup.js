import { contestGroups } from "./contestData.js";

export function getOrderedSetupTeams(state, groupId) {
  const configuredTeamIds = new Set(state.competitionSetup?.groups?.[groupId]?.teamIds ?? []);
  return (state.teams ?? [])
    .filter((team) => team.groupId === groupId && team.status === "active" && configuredTeamIds.has(team.id))
    .sort((left, right) => left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id));
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
      return [
        group.id,
        {
          groupId: group.id,
          status,
          teamIds,
          judgeIds,
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
