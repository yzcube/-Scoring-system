import { contestGroups, defaultCandidates, defaultCandidateOrderByGroup, defaultGroupId } from "../shared/contestData.js";
import { normalizeCompetitionSetup } from "../shared/competitionSetup.js";
import {
  createBlankScores,
  itemIds,
  itemMax,
  sanitizeEntry,
  scoreScale,
  toScore,
} from "../shared/scoringRules.js";

export { createBlankScores, itemIds, itemMax, sanitizeEntry, scoreScale, toScore };
export const defaultJudgeIds = ["001", "002", "003", "004", "005", "006", "007"];

const legacyJudgeIdMap = {
  judge01: "001",
  judge02: "002",
  judge03: "003",
  judge04: "004",
  judge05: "005",
  judge06: "006",
  judge07: "007",
};

function clampInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : fallback;
}

function cleanText(value, fallback = "", maxLength = 255) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

const registrationNumberMaxLength = 64;

function cleanProjectName(value, fallback = "") {
  const text = cleanText(value, fallback);
  return /^队伍编号\s*[：:]/.test(text) || /^报名编号\s*[：:]/.test(text) ? "" : text;
}

function normalizeId(value, maxLength = 32) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]+$/.test(id) && id.length <= maxLength ? id : "";
}

function normalizeUsername(value) {
  const username = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9._-]{3,64}$/.test(username) ? username : "";
}

function normalizeJudgeId(value) {
  return legacyJudgeIdMap[value] ?? normalizeId(value);
}

function isKnownGroupId(value) {
  return contestGroups.some((group) => group.id === value);
}

function sanitizeGroupId(value) {
  return isKnownGroupId(value) ? value : defaultGroupId;
}

function defaultTeams() {
  const orderById = new Map(
    Object.entries(defaultCandidateOrderByGroup).flatMap(([, ids]) => ids.map((id, index) => [id, index + 1])),
  );
  return defaultCandidates.map((candidate) => ({
    id: candidate.id,
    groupId: candidate.groupId,
    registrationNumber: cleanText(candidate.registrationNumber, "", registrationNumberMaxLength),
    teamName: cleanText(candidate.team, "未命名队伍"),
    projectName: cleanText(candidate.product),
    appearanceOrder: orderById.get(candidate.id) ?? 1,
    status: "active",
    revision: 0,
    judgeRosterSnapshot: [],
    createdAt: "",
    updatedAt: "",
  }));
}

function normalizeAppearanceOrder(teams) {
  return contestGroups.flatMap((group) =>
    teams
      .filter((team) => team.groupId === group.id)
      .sort((left, right) => left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id))
      .map((team, index) => ({ ...team, appearanceOrder: index + 1 })),
  );
}

function normalizeTeams(rawState) {
  if (!Array.isArray(rawState?.teams) || !rawState.teams.length) {
    const overrides = rawState?.candidateOverrides && typeof rawState.candidateOverrides === "object" ? rawState.candidateOverrides : {};
    const orderByGroup = rawState?.candidateOrderByGroup && typeof rawState.candidateOrderByGroup === "object" ? rawState.candidateOrderByGroup : {};
    const orderById = new Map(
      Object.values(orderByGroup).flatMap((ids) => (Array.isArray(ids) ? ids.map((id, index) => [id, index + 1]) : [])),
    );
    return normalizeAppearanceOrder(
      defaultTeams().map((team) => ({
        ...team,
        registrationNumber: cleanText(overrides[team.id]?.registrationNumber ?? overrides[team.id]?.registrationNo ?? overrides[team.id]?.teamNumber, team.registrationNumber, registrationNumberMaxLength),
        teamName: cleanText(overrides[team.id]?.team, team.teamName),
        projectName: cleanProjectName(overrides[team.id]?.product, team.projectName),
        appearanceOrder: orderById.get(team.id) ?? team.appearanceOrder,
      })),
    );
  }

  const defaultsById = new Map(defaultTeams().map((team) => [team.id, team]));
  const ids = new Set();
  const teams = rawState.teams.reduce((result, rawTeam) => {
    const id = normalizeId(rawTeam?.id, 16);
    if (!id || ids.has(id)) return result;
    ids.add(id);
    const fallback = defaultsById.get(id);
    result.push({
      id,
      groupId: sanitizeGroupId(rawTeam?.groupId),
      registrationNumber: cleanText(rawTeam?.registrationNumber ?? rawTeam?.registrationNo ?? rawTeam?.teamNumber, fallback?.registrationNumber || "", registrationNumberMaxLength),
      teamName: cleanText(rawTeam?.teamName ?? rawTeam?.team, fallback?.teamName || "未命名队伍"),
      projectName: cleanProjectName(rawTeam?.projectName ?? rawTeam?.product, fallback?.projectName || ""),
      appearanceOrder: Math.max(1, clampInteger(rawTeam?.appearanceOrder, result.length + 1)),
      status: ["active", "withdrawn", "archived"].includes(rawTeam?.status) ? rawTeam.status : "active",
      revision: clampInteger(rawTeam?.revision),
      judgeRosterSnapshot: Array.isArray(rawTeam?.judgeRosterSnapshot)
        ? rawTeam.judgeRosterSnapshot.map((idValue) => normalizeJudgeId(idValue)).filter(Boolean)
        : [],
      createdAt: typeof rawTeam?.createdAt === "string" ? rawTeam.createdAt.slice(0, 64) : "",
      updatedAt: typeof rawTeam?.updatedAt === "string" ? rawTeam.updatedAt.slice(0, 64) : "",
    });
    return result;
  }, []);
  return normalizeAppearanceOrder(teams);
}

function normalizeEntries(rawEntries, teams) {
  const teamIds = new Set(teams.map((team) => team.id));
  const source = rawEntries && typeof rawEntries === "object" ? rawEntries : {};
  const entries = [];
  Object.entries(source).forEach(([rawJudgeId, rawJudgeEntries]) => {
    const judgeId = normalizeJudgeId(rawJudgeId);
    if (!judgeId || !rawJudgeEntries || typeof rawJudgeEntries !== "object") return;
    Object.entries(rawJudgeEntries).forEach(([teamId, rawEntry]) => {
      if (!teamIds.has(teamId)) return;
      const entry = sanitizeEntry(rawEntry);
      if (!entry.serverRevision && !entry.submitted && itemIds.every((id) => entry.scores[id] === "")) return;
      entries.push({ judgeId, teamId, ...entry });
    });
  });
  return entries;
}

function normalizeAccounts(rawAccounts) {
  if (!Array.isArray(rawAccounts)) return [];
  const ids = new Set();
  const usernames = new Set();
  return rawAccounts.flatMap((rawAccount) => {
    const id = normalizeId(rawAccount?.id);
    const username = normalizeUsername(rawAccount?.username);
    const role = ["admin", "judge"].includes(rawAccount?.role) ? rawAccount.role : "";
    if (!id || !username || !role || ids.has(id) || usernames.has(username)) return [];
    ids.add(id);
    usernames.add(username);
    return [{
      id,
      username,
      displayName: cleanText(rawAccount?.displayName, role === "admin" ? "管理员" : "评委"),
      role,
      status: ["active", "disabled", "archived"].includes(rawAccount?.status) ? rawAccount.status : "active",
      passwordHash: typeof rawAccount?.passwordHash === "string" ? rawAccount.passwordHash.slice(0, 1024) : "",
      passwordVersion: Math.max(1, clampInteger(rawAccount?.passwordVersion, 1)),
      authVersion: Math.max(1, clampInteger(rawAccount?.authVersion, 1)),
      revision: Math.max(1, clampInteger(rawAccount?.revision, 1)),
      createdAt: typeof rawAccount?.createdAt === "string" ? rawAccount.createdAt.slice(0, 64) : "",
      updatedAt: typeof rawAccount?.updatedAt === "string" ? rawAccount.updatedAt.slice(0, 64) : "",
    }];
  });
}

function normalizeRoster(rawRoster, knownJudgeIds, accountById) {
  const source = Array.isArray(rawRoster?.judgeIds) ? rawRoster.judgeIds : defaultJudgeIds;
  const seen = new Set();
  const judgeIds = source
    .map((id) => normalizeJudgeId(id))
    .filter((id) => id && knownJudgeIds.has(id) && !seen.has(id) && seen.add(id));
  const operationIds = new Set();
  const enrollmentOperations = Array.isArray(rawRoster?.enrollmentOperations)
    ? rawRoster.enrollmentOperations.flatMap((rawOperation) => {
        const operationId = cleanText(rawOperation?.operationId, "", 80);
        const accountId = normalizeJudgeId(rawOperation?.accountId);
        const account = accountById.get(accountId);
        if (!operationId || operationIds.has(operationId) || account?.role !== "judge") return [];
        operationIds.add(operationId);
        return [{
          operationId,
          accountId,
          username: account.username,
          displayName: cleanText(rawOperation?.displayName, account.displayName, 120),
          reason: cleanText(rawOperation?.reason, "", 500),
          expectedRosterRevision: clampInteger(rawOperation?.expectedRosterRevision),
          credentialHash: typeof rawOperation?.credentialHash === "string" ? rawOperation.credentialHash.slice(0, 1024) : "",
          rosterRevision: clampInteger(rawOperation?.rosterRevision),
          effectiveAfterAssignmentRevision: clampInteger(rawOperation?.effectiveAfterAssignmentRevision),
          createdAt: typeof rawOperation?.createdAt === "string" ? rawOperation.createdAt.slice(0, 64) : "",
        }];
      })
    : [];
  return {
    judgeIds: judgeIds.length ? judgeIds : defaultJudgeIds.filter((id) => knownJudgeIds.has(id)),
    revision: clampInteger(rawRoster?.revision),
    lockedAt: typeof rawRoster?.lockedAt === "string" ? rawRoster.lockedAt.slice(0, 64) : "",
    effectiveMode: ["next_assignment", "future_assignments"].includes(rawRoster?.effectiveMode) ? rawRoster.effectiveMode : "next_assignment",
    reason: cleanText(rawRoster?.reason, "", 500),
    updatedBy: normalizeId(rawRoster?.updatedBy),
    enrollmentOperations,
    updatedAt: typeof rawRoster?.updatedAt === "string" ? rawRoster.updatedAt.slice(0, 64) : "",
  };
}

function normalizeActiveAssignment(rawAssignment, teams, knownJudgeIds) {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const team = teamById.get(normalizeId(rawAssignment?.teamId, 16));
  const validStatuses = new Set(["idle", "scoring", "awaiting_submissions", "final", "closed"]);
  const rosterSnapshot = Array.isArray(rawAssignment?.rosterSnapshot)
    ? rawAssignment.rosterSnapshot.map((id) => normalizeJudgeId(id)).filter((id, index, values) => knownJudgeIds.has(id) && values.indexOf(id) === index)
    : [];
  return {
    groupId: team?.groupId ?? sanitizeGroupId(rawAssignment?.groupId ?? rawAssignment?.activeGroupId),
    teamId: team?.id ?? null,
    status: team && validStatuses.has(rawAssignment?.status) ? rawAssignment.status : "idle",
    assignmentRevision: clampInteger(rawAssignment?.assignmentRevision ?? rawAssignment?.activeGroupRevision),
    rosterSnapshot: rosterSnapshot.length ? rosterSnapshot : team ? [...team.judgeRosterSnapshot] : [],
    updatedAt: typeof rawAssignment?.updatedAt === "string" ? rawAssignment.updatedAt.slice(0, 64) : "",
    forcedReason: typeof rawAssignment?.forcedReason === "string" ? rawAssignment.forcedReason.slice(0, 500) : "",
  };
}

function normalizeDisplaySelection(rawSelection, teams) {
  const teamIds = new Set(teams.map((team) => team.id));
  const teamId = normalizeId(rawSelection?.teamId, 16);
  const publicationStatus = ["temporary", "final", "review_required"].includes(rawSelection?.publicationStatus) && teamIds.has(teamId)
    ? rawSelection.publicationStatus
    : "idle";
  return {
    teamId: publicationStatus === "idle" ? null : teamId,
    publicationStatus,
    displayRevision: clampInteger(rawSelection?.displayRevision),
    publishedAt: typeof rawSelection?.publishedAt === "string" ? rawSelection.publishedAt.slice(0, 64) : "",
    updatedAt: typeof rawSelection?.updatedAt === "string" ? rawSelection.updatedAt.slice(0, 64) : "",
  };
}

export function normalizeCompetitionState(rawState = {}) {
  const teams = normalizeTeams(rawState);
  const accounts = normalizeAccounts(rawState.accounts);
  const entries = normalizeEntries(rawState.entriesByJudge ?? rawState, teams);
  const entryJudgeIds = new Set(entries.map((entry) => entry.judgeId));
  const accountJudgeIds = accounts.filter((account) => account.role === "judge").map((account) => account.id);
  const teamSnapshotJudgeIds = teams.flatMap((team) => team.judgeRosterSnapshot);
  const knownJudgeIds = new Set([...defaultJudgeIds, ...accountJudgeIds, ...entryJudgeIds, ...teamSnapshotJudgeIds]);
  const judgeRoster = normalizeRoster(rawState.judgeRoster, knownJudgeIds, new Map(accounts.map((account) => [account.id, account])));
  const teamOrderRevisionByGroup = Object.fromEntries(
    contestGroups.map((group) => [group.id, clampInteger(rawState.teamOrderRevisionByGroup?.[group.id] ?? rawState.candidateOrderRevision)]),
  );
  const activeAssignment = normalizeActiveAssignment(rawState.activeAssignment ?? rawState, teams, knownJudgeIds);
  const competitionSetup = normalizeCompetitionSetup(
    rawState.competitionSetup,
    { teams, accounts, activeAssignment },
    { normalizeTeamId: (id) => normalizeId(id, 16), normalizeJudgeId, clampInteger },
  );
  const displaySelection = normalizeDisplaySelection(rawState.displaySelection, teams);
  return { teams, accounts, entries, judgeRoster, competitionSetup, teamOrderRevisionByGroup, activeAssignment, displaySelection };
}

export function getTransferSummary(state) {
  return {
    teams: state.teams.length,
    accounts: state.accounts.length,
    dynamicJudges: state.accounts.filter((account) => account.role === "judge" && !defaultJudgeIds.includes(account.id)).length,
    entries: state.entries.length,
    submitted: state.entries.filter((entry) => entry.submitted).length,
    revised: state.entries.filter((entry) => entry.serverRevision > 0).length,
    rosterCount: state.judgeRoster.judgeIds.length,
    assignment: state.activeAssignment.teamId || "idle",
    display: state.displaySelection.teamId || "idle",
  };
}

export function getControlRows(state) {
  return [
    ["judge_roster", state.judgeRoster, state.judgeRoster.revision, state.judgeRoster.updatedAt],
    ["competition_setup", state.competitionSetup, state.competitionSetup.revision, ""],
    ["active_assignment", state.activeAssignment, state.activeAssignment.assignmentRevision, state.activeAssignment.updatedAt],
    ["display_selection", state.displaySelection, state.displaySelection.displayRevision, state.displaySelection.updatedAt],
    ...contestGroups.map((group) => [
      `team_order:${group.id}`,
      { groupId: group.id },
      state.teamOrderRevisionByGroup[group.id] ?? 0,
      "",
    ]),
  ];
}
