import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { contestGroups, defaultCandidates, defaultCandidateOrderByGroup, defaultGroupId } from "./shared/contestData.js";
import { normalizeCompetitionSetup } from "./shared/competitionSetup.js";
import { deriveAdminWorkflowStatus } from "./shared/adminWorkflow.js";
import {
  createBlankScores,
  itemIds,
  sanitizeEntry,
} from "./shared/scoringRules.js";
import {
  ContestControlError,
  getAccountById,
  getCompositeSummary,
  getCompetitionRestartImpact,
  getEntry,
  getJudgeAccounts,
  getTeamById,
  getTeamRoster,
  updateAssignmentSubmissionStatus,
} from "./domain/contestControl.js";
import { createPasswordService, createSessionService } from "./server/auth-session.mjs";
import { createStateStore } from "./server/state-store.mjs";
import { createHttpRoutes, parseRequestUrl } from "./server/http-routes.mjs";
import { createSessionApiRoutes } from "./server/session-api-routes.mjs";
import { createContestApiRoutes } from "./server/contest-api-routes.mjs";
import { createContestStorage } from "./server/storage/contest-storage.mjs";
import { getFormalRoundResidue, readBoundedInteger, resolveAdminPasswordRotationPolicy } from "./server/runtime-policy.mjs";

const port = readBoundedInteger(process.env.PORT, 8776, { name: "PORT", min: 1, max: 65_535 });
const host = process.env.HOST || "0.0.0.0";
const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const distDir = join(rootDir, "dist");
const dataDir = process.env.CONTEST_DATA_DIR ? resolve(process.env.CONTEST_DATA_DIR) : join(rootDir, "data");
const stateFile = join(dataDir, "contest-state.json");
const logDir = process.env.CONTEST_LOG_DIR ? resolve(process.env.CONTEST_LOG_DIR) : join(dataDir, "logs");
const storageMode = (
  process.env.CONTEST_STORAGE ||
  (process.env.NODE_ENV === "production" ? "mysql" : "file")
)
  .trim()
  .toLowerCase();
const requireAdminPasswordRotation = resolveAdminPasswordRotationPolicy({
  explicit: process.env.CONTEST_REQUIRE_ADMIN_PASSWORD_ROTATION,
  storageMode,
  nodeEnv: process.env.NODE_ENV,
});
const mysqlTablePrefix = process.env.CONTEST_MYSQL_TABLE_PREFIX || "contest_final_";
const mysqlConnectionConfig = process.env.CONTEST_DATABASE_URL
  ? {
      uri: process.env.CONTEST_DATABASE_URL,
      waitForConnections: true,
      connectionLimit: readBoundedInteger(process.env.CONTEST_MYSQL_CONNECTION_LIMIT, 5, { name: "CONTEST_MYSQL_CONNECTION_LIMIT", min: 1, max: 100 }),
      queueLimit: 0,
      decimalNumbers: true,
    }
  : {
      host: process.env.CONTEST_MYSQL_HOST || "127.0.0.1",
      port: readBoundedInteger(process.env.CONTEST_MYSQL_PORT, 3306, { name: "CONTEST_MYSQL_PORT", min: 1, max: 65_535 }),
      user: process.env.CONTEST_MYSQL_USER || "contest_scoring",
      password: process.env.CONTEST_MYSQL_PASSWORD || "",
      database: process.env.CONTEST_MYSQL_DATABASE || "campus_final_scoring",
      waitForConnections: true,
      connectionLimit: readBoundedInteger(process.env.CONTEST_MYSQL_CONNECTION_LIMIT, 5, { name: "CONTEST_MYSQL_CONNECTION_LIMIT", min: 1, max: 100 }),
      queueLimit: 0,
      charset: "utf8mb4",
      decimalNumbers: true,
    };
const maxRequestBodyBytes = readBoundedInteger(process.env.MAX_REQUEST_BODY_BYTES, 64 * 1024, { name: "MAX_REQUEST_BODY_BYTES", min: 1024, max: 10 * 1024 * 1024 });
const sessionTtlMs = readBoundedInteger(process.env.SESSION_TTL_MS, 12 * 60 * 60 * 1000, { name: "SESSION_TTL_MS", min: 60_000, max: 7 * 24 * 60 * 60 * 1000 });
const passwordScryptCost = readBoundedInteger(process.env.CONTEST_SCRYPT_N, 2 ** 15, { name: "CONTEST_SCRYPT_N", min: 2 ** 14, max: 2 ** 17 });
const passwordScryptR = 8;
const passwordScryptP = readBoundedInteger(process.env.CONTEST_SCRYPT_P, 3, { name: "CONTEST_SCRYPT_P", min: 1, max: 8 });
const passwordScryptMaxmem = readBoundedInteger(process.env.CONTEST_SCRYPT_MAXMEM, 128 * 1024 * 1024, { name: "CONTEST_SCRYPT_MAXMEM", min: 32 * 1024 * 1024, max: 1024 * 1024 * 1024 });
const passwordKdfConcurrency = readBoundedInteger(process.env.CONTEST_SCRYPT_CONCURRENCY, 2, { name: "CONTEST_SCRYPT_CONCURRENCY", min: 1, max: 32 });
if ((passwordScryptCost & (passwordScryptCost - 1)) !== 0) {
  throw new Error("CONTEST_SCRYPT_N must be a power of two");
}
const loginWindowMs = 10 * 60 * 1000;
const loginAttemptLimit = 5;
const loginLockMs = 10 * 60 * 1000;
const registrationNumberMaxLength = 64;
const httpHeadersTimeoutMs = readTimeout(process.env.CONTEST_HEADERS_TIMEOUT_MS, 15_000, 1_000);
const httpRequestTimeoutMs = readTimeout(process.env.CONTEST_REQUEST_TIMEOUT_MS, 30_000, 5_000);
const httpKeepAliveTimeoutMs = readTimeout(process.env.CONTEST_KEEP_ALIVE_TIMEOUT_MS, 5_000, 1_000);
const seedAccounts = [
  { id: "001", username: "001", displayName: "评委 01", role: "judge", password: "001" },
  { id: "002", username: "002", displayName: "评委 02", role: "judge", password: "002" },
  { id: "003", username: "003", displayName: "评委 03", role: "judge", password: "003" },
  { id: "004", username: "004", displayName: "评委 04", role: "judge", password: "004" },
  { id: "005", username: "005", displayName: "评委 05", role: "judge", password: "005" },
  { id: "006", username: "006", displayName: "评委 06", role: "judge", password: "006" },
  { id: "007", username: "007", displayName: "评委 07", role: "judge", password: "007" },
  { id: "admin", username: "admin", displayName: "管理员", role: "admin", password: "admin123" },
];
const legacyJudgeIdMap = {
  judge01: "001",
  judge02: "002",
  judge03: "003",
  judge04: "004",
  judge05: "005",
  judge06: "006",
  judge07: "007",
};

let auditLogQueue = Promise.resolve();
let isShuttingDown = false;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const passwordService = createPasswordService({
  cost: passwordScryptCost,
  r: passwordScryptR,
  p: passwordScryptP,
  maxmem: passwordScryptMaxmem,
  concurrency: passwordKdfConcurrency,
});
const { consumePasswordVerificationCost, hashPassword, verifyPassword } = passwordService;

function readTimeout(value, fallback, minimum) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum ? Math.trunc(numeric) : fallback;
}

function clampInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.trunc(numeric);
}

function cleanText(value, fallback = "", maxLength = 255) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, maxLength);
}

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
  return legacyJudgeIdMap[value] ?? value;
}

function isKnownGroupId(groupId) {
  return contestGroups.some((group) => group.id === groupId);
}

function getGroupLabel(groupId) {
  return contestGroups.find((group) => group.id === groupId)?.label ?? "未知组别";
}

function getTeamOrderControlKey(groupId) {
  return `team_order:${groupId}`;
}

function sanitizeGroupId(groupId) {
  return isKnownGroupId(groupId) ? groupId : defaultGroupId;
}

function createDefaultTeams() {
  const indexesByGroup = Object.fromEntries(
    contestGroups.map((group) => [
      group.id,
      new Map((defaultCandidateOrderByGroup[group.id] ?? []).map((id, index) => [id, index + 1])),
    ]),
  );
  return defaultCandidates.map((candidate) => ({
    id: candidate.id,
    groupId: candidate.groupId,
    registrationNumber: cleanText(candidate.registrationNumber, "", registrationNumberMaxLength),
    teamName: cleanText(candidate.team, "未命名队伍"),
    projectName: cleanText(candidate.product),
    appearanceOrder: indexesByGroup[candidate.groupId]?.get(candidate.id) ?? 1,
    status: "active",
    revision: 0,
    judgeRosterSnapshot: [],
    createdAt: "",
    updatedAt: "",
  }));
}

function normalizeTeamAppearance(teams) {
  const normalized = teams.map((team) => ({ ...team }));
  contestGroups.forEach((group) => {
    const groupTeams = normalized
      .filter((team) => team.groupId === group.id)
      .sort((left, right) => left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id));
    groupTeams.forEach((team, index) => {
      team.appearanceOrder = index + 1;
    });
  });
  return normalized;
}

function sanitizeTeams(savedTeams) {
  if (!Array.isArray(savedTeams) || !savedTeams.length) return createDefaultTeams();
  const defaultsById = new Map(createDefaultTeams().map((team) => [team.id, team]));
  const seenIds = new Set();
  const teams = savedTeams.reduce((result, rawTeam) => {
    const id = normalizeId(rawTeam?.id, 16);
    if (!id || seenIds.has(id)) return result;
    const groupId = sanitizeGroupId(rawTeam?.groupId);
    const fallback = defaultsById.get(id);
    const status = ["active", "withdrawn", "archived"].includes(rawTeam?.status) ? rawTeam.status : "active";
    seenIds.add(id);
    result.push({
      id,
      groupId,
      registrationNumber: cleanText(rawTeam?.registrationNumber ?? rawTeam?.registrationNo ?? rawTeam?.teamNumber, fallback?.registrationNumber || "", registrationNumberMaxLength),
      teamName: cleanText(rawTeam?.teamName ?? rawTeam?.team, fallback?.teamName || "未命名队伍"),
      projectName: cleanProjectName(rawTeam?.projectName ?? rawTeam?.product, fallback?.projectName || ""),
      appearanceOrder: Math.max(1, clampInteger(rawTeam?.appearanceOrder, result.length + 1)),
      status,
      revision: clampInteger(rawTeam?.revision),
      judgeRosterSnapshot: Array.isArray(rawTeam?.judgeRosterSnapshot)
        ? rawTeam.judgeRosterSnapshot
            .map((idValue) => normalizeId(idValue))
            .filter((idValue, index, values) => Boolean(idValue) && values.indexOf(idValue) === index)
        : [],
      createdAt: typeof rawTeam?.createdAt === "string" ? rawTeam.createdAt.slice(0, 64) : "",
      updatedAt: typeof rawTeam?.updatedAt === "string" ? rawTeam.updatedAt.slice(0, 64) : "",
    });
    return result;
  }, []);
  return teams.length ? normalizeTeamAppearance(teams) : createDefaultTeams();
}

function sanitizeAccounts(savedAccounts) {
  if (!Array.isArray(savedAccounts)) return [];
  const ids = new Set();
  const usernames = new Set();
  return savedAccounts.reduce((result, rawAccount) => {
    const id = normalizeId(rawAccount?.id);
    const username = normalizeUsername(rawAccount?.username);
    const role = ["admin", "judge"].includes(rawAccount?.role) ? rawAccount.role : "";
    if (!id || !username || !role || ids.has(id) || usernames.has(username)) return result;
    ids.add(id);
    usernames.add(username);
    result.push({
      id,
      username,
      displayName: cleanText(rawAccount?.displayName ?? rawAccount?.name, role === "admin" ? "管理员" : "评委"),
      role,
      status: ["active", "disabled", "archived"].includes(rawAccount?.status) ? rawAccount.status : "active",
      passwordHash: typeof rawAccount?.passwordHash === "string" ? rawAccount.passwordHash.slice(0, 1024) : "",
      passwordVersion: clampInteger(rawAccount?.passwordVersion),
      authVersion: clampInteger(rawAccount?.authVersion),
      revision: clampInteger(rawAccount?.revision),
      createdAt: typeof rawAccount?.createdAt === "string" ? rawAccount.createdAt.slice(0, 64) : "",
      updatedAt: typeof rawAccount?.updatedAt === "string" ? rawAccount.updatedAt.slice(0, 64) : "",
    });
    return result;
  }, []);
}

function createEmptyState() {
  return {
    version: 4,
    teams: [],
    accounts: [],
    entriesByJudge: {},
    judgeRoster: {
      judgeIds: [],
      revision: 0,
      lockedAt: "",
      effectiveMode: "next_assignment",
      reason: "",
      updatedBy: "",
      enrollmentOperations: [],
      updatedAt: "",
    },
    competitionSetup: {
      activeGroupId: null,
      revision: 0,
      groups: Object.fromEntries(
        contestGroups.map((group) => [
          group.id,
          {
            groupId: group.id,
            status: "draft",
            teamIds: [],
            judgeIds: [],
            revision: 0,
            openedAt: "",
            closedAt: "",
            updatedAt: "",
            updatedBy: "",
          },
        ]),
      ),
    },
    teamOrderRevisionByGroup: Object.fromEntries(contestGroups.map((group) => [group.id, 0])),
    activeAssignment: {
      groupId: defaultGroupId,
      teamId: null,
      status: "idle",
      assignmentRevision: 0,
      rosterRevision: 0,
      rosterSnapshot: [],
      rescoreRevision: 0,
      rescoreAssignmentsByJudge: {},
      updatedAt: "",
      forcedReason: "",
    },
    displaySelection: {
      teamId: null,
      publicationStatus: "idle",
      displayRevision: 0,
      publishedAt: "",
      updatedAt: "",
    },
  };
}

async function createInitialState() {
  const state = createEmptyState();
  state.teams = createDefaultTeams();
  state.accounts = await Promise.all(
    seedAccounts.map(async (seed) => ({
      id: seed.id,
      username: seed.username,
      displayName: seed.displayName,
      role: seed.role,
      status: "active",
      passwordHash: await hashPassword(seed.password),
      passwordVersion: 1,
      authVersion: 1,
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
  );
  state.judgeRoster.judgeIds = state.accounts.filter((account) => account.role === "judge").map((account) => account.id);
  state.judgeRoster.updatedAt = new Date().toISOString();
  state.competitionSetup = normalizeCompetitionSetup(null, state, { normalizeTeamId: (id) => normalizeId(id, 16), normalizeJudgeId: normalizeId, clampInteger });
  return state;
}

function sanitizeJudgeRoster(rawRoster, accounts) {
  const judgeIds = new Set(accounts.filter((account) => account.role === "judge").map((account) => account.id));
  const savedIds = Array.isArray(rawRoster?.judgeIds) ? rawRoster.judgeIds : [];
  const rosterIds = savedIds.map((id) => normalizeId(id)).filter((id, index, values) => judgeIds.has(id) && values.indexOf(id) === index);
  const fallback = accounts.filter((account) => account.role === "judge" && account.status === "active").map((account) => account.id);
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const operationIds = new Set();
  const enrollmentOperations = Array.isArray(rawRoster?.enrollmentOperations)
    ? rawRoster.enrollmentOperations.flatMap((rawOperation) => {
        const operationId = typeof rawOperation?.operationId === "string" ? rawOperation.operationId.trim().slice(0, 80) : "";
        const accountId = normalizeId(rawOperation?.accountId);
        const account = accountById.get(accountId);
        if (!operationId || operationIds.has(operationId) || !account || account.role !== "judge") return [];
        operationIds.add(operationId);
        return [{
          operationId,
          accountId,
          username: account.username,
          displayName: typeof rawOperation?.displayName === "string" ? rawOperation.displayName.trim().slice(0, 120) : account.displayName,
          reason: typeof rawOperation?.reason === "string" ? rawOperation.reason.trim().slice(0, 500) : "",
          expectedRosterRevision: clampInteger(rawOperation?.expectedRosterRevision),
          credentialHash: typeof rawOperation?.credentialHash === "string" ? rawOperation.credentialHash.slice(0, 1024) : "",
          rosterRevision: clampInteger(rawOperation?.rosterRevision),
          effectiveAfterAssignmentRevision: clampInteger(rawOperation?.effectiveAfterAssignmentRevision),
          createdAt: typeof rawOperation?.createdAt === "string" ? rawOperation.createdAt.slice(0, 64) : "",
        }];
      })
    : [];
  return {
    judgeIds: rosterIds.length ? rosterIds : fallback,
    revision: clampInteger(rawRoster?.revision),
    lockedAt: typeof rawRoster?.lockedAt === "string" ? rawRoster.lockedAt.slice(0, 64) : "",
    effectiveMode: ["next_assignment", "future_assignments"].includes(rawRoster?.effectiveMode)
      ? rawRoster.effectiveMode
      : "next_assignment",
    reason: typeof rawRoster?.reason === "string" ? rawRoster.reason.trim().slice(0, 500) : "",
    updatedBy: normalizeId(rawRoster?.updatedBy),
    enrollmentOperations,
    updatedAt: typeof rawRoster?.updatedAt === "string" ? rawRoster.updatedAt.slice(0, 64) : "",
  };
}

function sanitizeEntries(rawEntries, accounts, teams) {
  const source = rawEntries && typeof rawEntries === "object" ? rawEntries : {};
  const teamIds = new Set(teams.map((team) => team.id));
  const entriesByJudge = {};
  accounts
    .filter((account) => account.role === "judge")
    .forEach((account) => {
      const legacyId = Object.entries(legacyJudgeIdMap).find(([, value]) => value === account.id)?.[0];
      const rawJudgeEntries = source[account.id] ?? source[legacyId] ?? {};
      if (!rawJudgeEntries || typeof rawJudgeEntries !== "object") return;
      const entries = {};
      Object.entries(rawJudgeEntries).forEach(([teamId, rawEntry]) => {
        if (!teamIds.has(teamId)) return;
        const entry = sanitizeEntry(rawEntry);
        if (entry.serverRevision || entry.submitted || itemIds.some((id) => entry.scores[id] !== "")) entries[teamId] = entry;
      });
      if (Object.keys(entries).length) entriesByJudge[account.id] = entries;
    });
  return entriesByJudge;
}

function sanitizeTeamOrderRevisions(rawRevisions, legacyRevision = 0) {
  return Object.fromEntries(
    contestGroups.map((group) => [group.id, clampInteger(rawRevisions?.[group.id], clampInteger(legacyRevision))]),
  );
}

function sanitizeActiveAssignment(rawAssignment, state) {
  const rawTeamId = normalizeId(rawAssignment?.teamId, 16);
  const team = rawTeamId ? getTeamById(state, rawTeamId) : null;
  const validStatuses = new Set(["idle", "scoring", "awaiting_submissions", "final", "closed"]);
  const status = team && validStatuses.has(rawAssignment?.status) ? rawAssignment.status : "idle";
  const judgeIds = new Set(getJudgeAccounts(state).map((account) => account.id));
  const rosterSnapshot = Array.isArray(rawAssignment?.rosterSnapshot)
    ? rawAssignment.rosterSnapshot.map((id) => normalizeId(id)).filter((id, index, values) => judgeIds.has(id) && values.indexOf(id) === index)
    : [];
  const rescoreAssignmentsByJudge = {};
  const rawRescoreAssignments =
    rawAssignment?.rescoreAssignmentsByJudge &&
    typeof rawAssignment.rescoreAssignmentsByJudge === "object" &&
    !Array.isArray(rawAssignment.rescoreAssignmentsByJudge)
      ? rawAssignment.rescoreAssignmentsByJudge
      : {};
  const accountsById = new Map(
    getJudgeAccounts(state).map((account) => [account.id, account]),
  );
  Object.entries(rawRescoreAssignments).forEach(([rawJudgeId, rawGrant]) => {
    const judgeId = normalizeId(rawJudgeId);
    const judge = accountsById.get(judgeId);
    const grantTeam = getTeamById(state, normalizeId(rawGrant?.teamId, 16));
    const grantRevision = clampInteger(rawGrant?.revision);
    const entry = grantTeam ? state.entriesByJudge[judgeId]?.[grantTeam.id] : null;
    const setup = grantTeam
      ? state.competitionSetup?.groups?.[grantTeam.groupId]
      : null;
    const reason =
      typeof rawGrant?.reason === "string"
        ? rawGrant.reason.trim().slice(0, 500)
        : "";
    if (
      !judge ||
      judge.status !== "active" ||
      !grantTeam ||
      grantTeam.status !== "active" ||
      grantTeam.id === team?.id ||
      !grantTeam.judgeRosterSnapshot?.includes(judgeId) ||
      !entry ||
      entry.serverRevision < grantRevision ||
      grantRevision < 1 ||
      !["retain", "clear"].includes(rawGrant?.mode) ||
      reason.length < 3 ||
      setup?.status !== "open" ||
      state.competitionSetup?.activeGroupId !== grantTeam.groupId
    ) return;
    rescoreAssignmentsByJudge[judgeId] = {
      teamId: grantTeam.id,
      mode: rawGrant.mode,
      revision: grantRevision,
      reason,
      startedAt:
        typeof rawGrant?.startedAt === "string"
          ? rawGrant.startedAt.slice(0, 64)
          : "",
      startedBy: normalizeId(rawGrant?.startedBy),
    };
  });
  return {
    groupId: team?.groupId ?? sanitizeGroupId(rawAssignment?.groupId),
    teamId: team?.id ?? null,
    status,
    assignmentRevision: clampInteger(rawAssignment?.assignmentRevision),
    rosterRevision: clampInteger(rawAssignment?.rosterRevision),
    rosterSnapshot: rosterSnapshot.length ? rosterSnapshot : team ? getTeamRoster(state, team) : [],
    rescoreRevision: clampInteger(rawAssignment?.rescoreRevision),
    rescoreAssignmentsByJudge,
    updatedAt: typeof rawAssignment?.updatedAt === "string" ? rawAssignment.updatedAt.slice(0, 64) : "",
    forcedReason: typeof rawAssignment?.forcedReason === "string" ? rawAssignment.forcedReason.slice(0, 500) : "",
  };
}

function sanitizeDisplaySelection(rawSelection, state) {
  const team = getTeamById(state, normalizeId(rawSelection?.teamId, 16));
  const statuses = new Set(["idle", "temporary", "final", "review_required"]);
  const publicationStatus = team?.status === "active" && statuses.has(rawSelection?.publicationStatus) ? rawSelection.publicationStatus : "idle";
  return {
    teamId: team?.status === "active" && publicationStatus !== "idle" ? team.id : null,
    publicationStatus,
    displayRevision: clampInteger(rawSelection?.displayRevision),
    publishedAt: typeof rawSelection?.publishedAt === "string" ? rawSelection.publishedAt.slice(0, 64) : "",
    updatedAt: typeof rawSelection?.updatedAt === "string" ? rawSelection.updatedAt.slice(0, 64) : "",
  };
}

function sanitizeV4State(savedState = {}) {
  const state = createEmptyState();
  state.teams = sanitizeTeams(savedState.teams);
  state.accounts = sanitizeAccounts(savedState.accounts);
  state.entriesByJudge = sanitizeEntries(savedState.entriesByJudge, state.accounts, state.teams);
  state.judgeRoster = sanitizeJudgeRoster(savedState.judgeRoster, state.accounts);
  state.teamOrderRevisionByGroup = sanitizeTeamOrderRevisions(savedState.teamOrderRevisionByGroup, savedState.candidateOrderRevision);
  state.activeAssignment = sanitizeActiveAssignment(savedState.activeAssignment, state);
  state.competitionSetup = normalizeCompetitionSetup(savedState.competitionSetup, state, { normalizeTeamId: (id) => normalizeId(id, 16), normalizeJudgeId: normalizeId, clampInteger });
  state.activeAssignment = sanitizeActiveAssignment(savedState.activeAssignment, state);
  state.displaySelection = sanitizeDisplaySelection(savedState.displaySelection, state);
  updateAssignmentSubmissionStatus(state, state.activeAssignment.updatedAt);
  return state;
}

function applyLegacyTeamOverrides(teams, legacyOverrides) {
  const overrides = legacyOverrides && typeof legacyOverrides === "object" ? legacyOverrides : {};
  return teams.map((team) => {
    const override = overrides[team.id];
    if (!override || typeof override !== "object") return team;
    return {
      ...team,
        registrationNumber: cleanText(override.registrationNumber ?? override.registrationNo ?? override.teamNumber, team.registrationNumber, registrationNumberMaxLength),
      teamName: cleanText(override.team, team.teamName),
      projectName: cleanProjectName(override.product, team.projectName),
    };
  });
}

function applyLegacyTeamOrder(teams, legacyOrder) {
  let orderedTeams = [...teams];
  contestGroups.forEach((group) => {
    const expected = orderedTeams.filter((team) => team.groupId === group.id).map((team) => team.id);
    const saved = Array.isArray(legacyOrder?.[group.id]) ? legacyOrder[group.id] : [];
    const valid = saved.length === expected.length && new Set(saved).size === expected.length && saved.every((id) => expected.includes(id));
    const order = valid ? saved : expected;
    const positionById = new Map(order.map((id, index) => [id, index + 1]));
    orderedTeams = orderedTeams.map((team) => (team.groupId === group.id ? { ...team, appearanceOrder: positionById.get(team.id) } : team));
  });
  return normalizeTeamAppearance(orderedTeams);
}

async function migrateLegacyState(savedState = {}) {
  const state = await createInitialState();
  state.teams = applyLegacyTeamOrder(applyLegacyTeamOverrides(state.teams, savedState.candidateOverrides), savedState.candidateOrderByGroup);
  state.teamOrderRevisionByGroup = sanitizeTeamOrderRevisions({}, savedState.candidateOrderRevision);
  state.entriesByJudge = sanitizeEntries(savedState.entriesByJudge ?? savedState, state.accounts, state.teams);
  state.activeAssignment = {
    ...state.activeAssignment,
    groupId: sanitizeGroupId(savedState.activeGroupId),
    assignmentRevision: clampInteger(savedState.activeGroupRevision),
    updatedAt: typeof savedState.activeGroupUpdatedAt === "string" ? savedState.activeGroupUpdatedAt.slice(0, 64) : "",
  };
  return state;
}

async function ensureAccountHashes(state) {
  let changed = false;
  for (const account of state.accounts) {
    if (account.passwordHash) continue;
    const seed = seedAccounts.find((item) => item.id === account.id && item.username === account.username);
    if (!seed) throw new Error(`账号 ${account.username} 缺少密码哈希，无法安全迁移`);
    account.passwordHash = await hashPassword(seed.password);
    account.passwordVersion = Math.max(1, account.passwordVersion);
    account.authVersion = Math.max(1, account.authVersion);
    account.revision = Math.max(1, account.revision);
    account.updatedAt = new Date().toISOString();
    changed = true;
  }
  return changed;
}

function getStateSummary(state) {
  let submittedCount = 0;
  let revisedCount = 0;
  getJudgeAccounts(state).forEach((judge) => {
    state.teams.forEach((team) => {
      const entry = getEntry(state, judge.id, team.id);
      if (entry.submitted) submittedCount += 1;
      if (entry.serverRevision > 0) revisedCount += 1;
    });
  });
  return { submittedCount, revisedCount, teams: state.teams.length, accounts: state.accounts.length };
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    status: account.status,
    revision: account.revision,
    passwordVersion: account.passwordVersion,
    authVersion: account.authVersion,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function publicTeam(team) {
  if (!team) return null;
  return {
    id: team.id,
    groupId: team.groupId,
    registrationNumber: team.registrationNumber,
    teamName: team.teamName,
    projectName: team.projectName,
    appearanceOrder: team.appearanceOrder,
    status: team.status,
    revision: team.revision,
    hasScoringHistory: Boolean(team.judgeRosterSnapshot?.length),
  };
}

function publicAssignmentBase(assignment) {
  return {
    groupId: assignment.groupId,
    teamId: assignment.teamId,
    status: assignment.status,
    assignmentRevision: assignment.assignmentRevision,
    rosterRevision: assignment.rosterRevision,
    rosterSnapshot: [...(assignment.rosterSnapshot ?? [])],
    updatedAt: assignment.updatedAt,
  };
}

function publicAssignment(assignment) {
  return {
    ...publicAssignmentBase(assignment),
    rescoreRevision: clampInteger(assignment.rescoreRevision),
    rescoreAssignmentsByJudge: Object.fromEntries(
      Object.entries(assignment.rescoreAssignmentsByJudge ?? {}).map(
        ([judgeId, grant]) => [judgeId, { ...grant }],
      ),
    ),
  };
}

function publicJudgeAssignment(state, judgeId) {
  const assignment = state.activeAssignment;
  const grant = assignment.rescoreAssignmentsByJudge?.[judgeId];
  if (!grant) return publicAssignmentBase(assignment);
  const team = getTeamById(state, grant.teamId);
  if (!team) return publicAssignmentBase(assignment);
  return {
    groupId: team.groupId,
    teamId: team.id,
    status: "scoring",
    assignmentRevision: grant.revision,
    rosterRevision: 0,
    rosterSnapshot: [judgeId],
    updatedAt: grant.startedAt,
    rescore: true,
    rescoreMode: grant.mode,
    rescoreReason: grant.reason,
  };
}

function publicDisplaySelection(selection) {
  return {
    teamId: selection.teamId,
    publicationStatus: selection.publicationStatus,
    displayRevision: selection.displayRevision,
    publishedAt: selection.publishedAt,
    updatedAt: selection.updatedAt,
  };
}

function publicJudgeRoster(roster) {
  return {
    judgeIds: [...(roster?.judgeIds ?? [])],
    revision: clampInteger(roster?.revision),
    lockedAt: typeof roster?.lockedAt === "string" ? roster.lockedAt : "",
    effectiveMode: ["next_assignment", "future_assignments"].includes(roster?.effectiveMode)
      ? roster.effectiveMode
      : "next_assignment",
    reason: typeof roster?.reason === "string" ? roster.reason : "",
    updatedBy: normalizeId(roster?.updatedBy),
    updatedAt: typeof roster?.updatedAt === "string" ? roster.updatedAt : "",
  };
}

function getAdminStatePayload(state, account) {
  const summariesByTeam = Object.fromEntries(
    state.teams.map((team) => [team.id, getCompositeSummary(state, team.id)]),
  );
  const security = {
    adminPasswordRotationRequired: requireAdminPasswordRotation,
    adminPasswordRotated: !requireAdminPasswordRotation || clampInteger(account?.passwordVersion) > 1,
  };
  return {
    entriesByJudge: state.entriesByJudge,
    teams: state.teams.map((team) => ({
      ...publicTeam(team),
      judgeRosterSnapshot: [...(team.judgeRosterSnapshot ?? [])],
    })),
    summariesByTeam,
    accounts: state.accounts.map(publicAccount),
    judgeRoster: publicJudgeRoster(state.judgeRoster),
    competitionSetup: {
      ...state.competitionSetup,
      groups: Object.fromEntries(
        Object.entries(state.competitionSetup.groups).map(([groupId, setup]) => [
          groupId,
          { ...setup, teamIds: [...setup.teamIds], judgeIds: [...setup.judgeIds] },
        ]),
      ),
    },
    teamOrderRevisionByGroup: state.teamOrderRevisionByGroup,
    activeAssignment: publicAssignment(state.activeAssignment),
    displaySelection: publicDisplaySelection(state.displaySelection),
    restartImpactByGroup: Object.fromEntries(
      Object.keys(state.competitionSetup.groups).map((groupId) => [
        groupId,
        getCompetitionRestartImpact(state, groupId),
      ]),
    ),
    security,
    workflowByGroup: Object.fromEntries(
      Object.keys(state.competitionSetup.groups).map((groupId) => [
        groupId,
        deriveAdminWorkflowStatus(
          { ...state, summariesByTeam },
          {
            groupId,
            requireAdminPasswordRotation,
            adminAccountId: account?.id,
          },
        ),
      ]),
    ),
  };
}

function getJudgeStatePayload(state, judgeId) {
  const assignment = publicJudgeAssignment(state, judgeId);
  const team = assignment.teamId ? getTeamById(state, assignment.teamId) : null;
  return {
    entriesByJudge: team ? { [judgeId]: { [team.id]: getEntry(state, judgeId, team.id) } } : { [judgeId]: {} },
    teams: team ? [publicTeam(team)] : [],
    judgeRoster: { ...publicJudgeRoster(state.judgeRoster), judgeIds: [] },
    competitionSetup: { activeGroupId: state.competitionSetup.activeGroupId, revision: state.competitionSetup.revision, groups: {} },
    teamOrderRevisionByGroup: {},
    activeAssignment: assignment,
    displaySelection: publicDisplaySelection(state.displaySelection),
  };
}

function getLogFilePath(timestamp = new Date()) {
  return join(logDir, `contest-server-${timestamp.toISOString().slice(0, 10)}.jsonl`);
}

function safeLogValue(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9_-]+/gi, "Bearer [redacted]")
      .replace(/(password|token|authorization|hash)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeLogValue(String(value.message ?? "")),
      status: value.status,
    };
  }
  if (Array.isArray(value)) return value.map((item) => safeLogValue(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/(password|token|authorization|hash)/i.test(key))
      .map(([key, item]) => [key, safeLogValue(item)]),
  );
}

function logAudit(level, event, details = {}) {
  const timestamp = new Date();
  const record = safeLogValue({ timestamp: timestamp.toISOString(), level, event, pid: process.pid, port, host, ...details });
  const line = [
    record.timestamp,
    level.toUpperCase(),
    event,
    record.requestId ? `request=${record.requestId}` : "",
    record.action ? `action=${record.action}` : "",
    record.actor?.id ? `actor=${record.actor.id}` : "",
    record.statusCode ? `status=${record.statusCode}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  auditLogQueue = auditLogQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(logDir, { recursive: true });
      await appendFile(getLogFilePath(timestamp), `${JSON.stringify(record)}\n`);
    })
    .catch((error) => console.error(`audit log write failed: ${error.message}`));
}

async function flushAuditLog() {
  await auditLogQueue.catch(() => {});
}

function createRequestAudit(request, url) {
  return {
    requestId: randomBytes(8).toString("hex"),
    startedAt: process.hrtime.bigint(),
    method: request.method,
    path: url.pathname,
    action: "api_request",
    actor: null,
    target: null,
    outcome: "",
    details: {},
  };
}

function setAuditActor(request, account) {
  if (!request.audit || !account) return;
  request.audit.actor = { id: account.id, role: account.role, username: account.username };
}

function shouldLogRequestAudit(audit, statusCode) {
  if (statusCode >= 400) return true;
  return !["health_check", "session_check", "state_read", "scoreboard_read", "rankings_read"].includes(audit.action);
}

function finishRequestAudit(request, response) {
  const audit = request.audit;
  if (!audit || !shouldLogRequestAudit(audit, response.statusCode)) return;
  const durationMs = Number(process.hrtime.bigint() - audit.startedAt) / 1_000_000;
  logAudit(response.statusCode >= 500 ? "error" : response.statusCode >= 400 ? "warn" : "info", "api_request", {
    requestId: audit.requestId,
    method: audit.method,
    path: audit.path,
    statusCode: response.statusCode,
    durationMs: Number(durationMs.toFixed(2)),
    action: audit.action,
    actor: audit.actor,
    target: audit.target,
    outcome: audit.outcome || (response.statusCode < 400 ? "ok" : "failed"),
    details: audit.details,
  });
}

const storage = createContestStorage({
  mode: storageMode,
  file: { dataDir, stateFile },
  mysql: { driver: mysql, tablePrefix: mysqlTablePrefix, config: mysqlConnectionConfig },
  stateCodec: {
    createInitialState,
    migrateLegacyState,
    ensureAccountHashes,
    sanitizeState: sanitizeV4State,
    createEmptyState,
    normalizeJudgeId,
    applyLegacyTeamOverrides,
    applyLegacyTeamOrder,
    sanitizeGroupId,
    clampInteger,
    getTeamOrderControlKey,
    legacyJudgeIdMap,
  },
  entityLookup: { getTeamById, getAccountById, getEntry },
  groups: contestGroups,
});
const {
  assertSupportedStorageMode,
  initialize: initializeStorage,
  readState,
  writeState,
  checkHealth: checkStorageHealth,
  close: closeStorage,
  getMysqlPool,
  mysqlId,
  tables: mysqlTables,
} = storage;

const sessionService = createSessionService({
  storageMode,
  getMysqlPool,
  mysqlId,
  mysqlSessionsTable: mysqlTables.sessions,
  readState,
  getAccountById,
  HttpError,
  sessionTtlMs,
  setAuditActor,
  clampInteger,
});
const {
  assertLoginNotLimited,
  assertQueuedSession,
  clearFailedLogins,
  createSession,
  getActiveSessionCount,
  getSession,
  recordFailedLogin,
  requireSession,
  revokeSession,
} = sessionService;

const { applyContestControl, queueSessionRevocation, updateState } = createStateStore({
  readState,
  writeState,
  sanitizeState: sanitizeV4State,
  assertQueuedSession,
  revokeSession,
});

function getOrderedTeams(state, groupId, includeArchived = true) {
  return state.teams
    .filter((team) => team.groupId === groupId && (includeArchived || team.status !== "archived"))
    .sort((left, right) => left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id));
}

function validateTeamOrder(state, groupId, orderedTeamIds) {
  if (!isKnownGroupId(groupId)) throw new HttpError(404, "未知组别");
  if (!Array.isArray(orderedTeamIds)) throw new HttpError(400, "队伍顺序数据异常");
  const expected = getOrderedTeams(state, groupId).map((team) => team.id);
  if (orderedTeamIds.length !== expected.length || new Set(orderedTeamIds).size !== expected.length || !orderedTeamIds.every((id) => expected.includes(id))) {
    throw new HttpError(400, "队伍顺序必须包含本组全部队伍且不重复");
  }
  return [...orderedTeamIds];
}

function updateTeamOrder(state, groupId, orderedTeamIds) {
  const nextRevision = Math.max(
    state.teamOrderRevisionByGroup[groupId] ?? 0,
    ...getOrderedTeams(state, groupId).map((team) => team.revision),
  ) + 1;
  const positionById = new Map(orderedTeamIds.map((id, index) => [id, index + 1]));
  state.teams = state.teams.map((team) =>
    team.groupId === groupId
      ? { ...team, appearanceOrder: positionById.get(team.id), revision: nextRevision, updatedAt: new Date().toISOString() }
      : team,
  );
  state.teamOrderRevisionByGroup[groupId] = nextRevision;
}

function isSameIdOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function createTeamId(state) {
  let teamId = "";
  do {
    teamId = `t-${randomBytes(6).toString("base64url")}`;
  } while (getTeamById(state, teamId));
  return teamId;
}

function createAccountId(state) {
  let accountId = "";
  do {
    accountId = `j-${randomBytes(6).toString("base64url")}`;
  } while (getAccountById(state, accountId));
  return accountId;
}

function getScoreboardPayload(state, requestedTeamId = "", { controller = false } = {}) {
  const selection = publicDisplaySelection(state.displaySelection);
  const teamOptions = contestGroups.flatMap((group) => {
    const groupTeams = getOrderedTeams(state, group.id, false);
    return groupTeams.map((team, index) => {
      const summary = getCompositeSummary(state, team.id);
      const visibleAppearanceOrder = index + 1;
      return {
        id: team.id,
        groupId: team.groupId,
        groupLabel: group.label,
        registrationNumber: team.registrationNumber,
        teamName: team.teamName,
        projectName: team.projectName,
        appearanceOrder: visibleAppearanceOrder,
        orderLabel: `${visibleAppearanceOrder}/${groupTeams.length}`,
        submittedCount: summary.submittedCount,
        rosterCount: summary.rosterCount,
        displayable: summary.isFinal || summary.submittedCount >= 1,
        statusLabel: summary.isFinal ? "已完成" : summary.submittedCount >= 3 ? "暂算" : summary.submittedCount >= 1 ? `已提交 ${summary.submittedCount} 位` : "待评分",
      };
    });
  });
  const requestedTeam = normalizeId(requestedTeamId, 16);
  const requested = requestedTeam ? getTeamById(state, requestedTeam) : null;
  const team = requested?.status === "active" ? requested : selection.teamId ? getTeamById(state, selection.teamId) : null;
  const summary = team ? getCompositeSummary(state, team.id) : null;
  const selectedOption = teamOptions.find((option) => option.id === team?.id) ?? null;
  const isUrlSelected = Boolean(controller && requested?.status === "active");
  const canDisplay = Boolean(
    team?.status === "active" &&
      (isUrlSelected
        ? summary.isFinal || summary.submittedCount >= 1
        : ((selection.publicationStatus === "final" && summary.isFinal) ||
          (selection.publicationStatus === "temporary" && summary.submittedCount >= 1))),
  );
  const visibleSelectedOption = controller || canDisplay ? selectedOption : null;
  const canPreviewTeamIdentity = Boolean(controller && isUrlSelected && team?.status === "active");
  const visibleSelection = controller || canDisplay
    ? selection
    : { teamId: null, publicationStatus: "idle", displayRevision: 0, publishedAt: "", updatedAt: "" };
  return {
    displaySelection: visibleSelection,
    controller,
    selectedTeam: visibleSelectedOption,
    selectedTeamId: visibleSelectedOption?.id ?? null,
    teamOptions,
    displayTeam: canDisplay || canPreviewTeamIdentity ? publicTeam(team) : null,
    displaySummary: canDisplay || canPreviewTeamIdentity ? summary : null,
  };
}

function getRankingsPayload(state, requestedGroupId = "") {
  const selectedGroupId = isKnownGroupId(requestedGroupId) ? requestedGroupId : state.activeAssignment.groupId || defaultGroupId;
  const groups = contestGroups.map((group) => ({
    id: group.id,
    label: group.label,
    active: group.id === selectedGroupId,
  }));
  const groupTeams = getOrderedTeams(state, selectedGroupId, false);
  const sortedTeams = groupTeams
    .map((team) => {
      const summary = getCompositeSummary(state, team.id);
      const numericScore = summary.display === "--" ? null : Number(summary.display);
      return {
        ...publicTeam(team),
        groupLabel: getGroupLabel(team.groupId),
        submittedCount: summary.submittedCount,
        rosterCount: summary.rosterCount,
        score: summary.display,
        scoreValue: numericScore,
        status: summary.status,
        isFinal: summary.isFinal,
      };
    })
    .sort((left, right) => {
      const leftScore = left.scoreValue ?? -1;
      const rightScore = right.scoreValue ?? -1;
      return rightScore - leftScore || left.appearanceOrder - right.appearanceOrder || left.id.localeCompare(right.id);
    });
  let previousScore = null;
  let previousRank = 0;
  const rankedTeams = sortedTeams.map((team, index) => {
    const rank = team.scoreValue !== null && previousScore !== null && team.scoreValue === previousScore ? previousRank : index + 1;
    previousScore = team.scoreValue;
    previousRank = rank;
    return { ...team, rank };
  });

  return {
    selectedGroupId,
    selectedGroupLabel: getGroupLabel(selectedGroupId),
    groups,
    rankings: rankedTeams,
  };
}

async function handleApi(request, response, url) {
  if (await handleSessionApi(request, response, url)) return true;
  return handleContestApi(request, response, url);
}

function getLanUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}/`);
}

const { readJsonBody, sendApiError, sendJson, serveStatic } = createHttpRoutes({
  distDir,
  maxRequestBodyBytes,
  HttpError,
  ContestControlError,
  logAudit,
});

const handleSessionApi = createSessionApiRoutes({
  runtime: { storageMode, isShuttingDown: () => isShuttingDown, getLanUrls },
  storage: { checkStorageHealth },
  http: { readJsonBody, sendJson, HttpError },
  auth: {
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
  },
  state: { readState, getAccountById, queueSessionRevocation },
  presentation: { getScoreboardPayload, getRankingsPayload, getAdminStatePayload, getJudgeStatePayload },
});

const handleContestApi = createContestApiRoutes({
  http: { readJsonBody, sendJson, HttpError },
  auth: { requireSession, hashPassword, verifyPassword },
  writes: { updateState, applyContestControl },
  input: { normalizeId, normalizeUsername, cleanText, clampInteger, sanitizeGroupId, isKnownGroupId },
  ids: { createTeamId, createAccountId },
  teams: { getOrderedTeams, validateTeamOrder, updateTeamOrder, isSameIdOrder },
  presentation: { publicAccount, publicTeam, publicAssignment, publicJudgeAssignment, publicDisplaySelection, publicJudgeRoster, getScoreboardPayload },
  security: { requireAdminPasswordRotation },
});

const server = createServer({ headersTimeout: httpHeadersTimeoutMs, requestTimeout: httpRequestTimeoutMs, keepAliveTimeout: httpKeepAliveTimeoutMs }, async (request, response) => {
  try {
    const url = parseRequestUrl(request.url);
    if (url.pathname.startsWith("/api/")) {
      request.audit = createRequestAudit(request, url);
      response.once("finish", () => finishRequestAudit(request, response));
    }
    if (url.pathname.startsWith("/api/")) {
      if (await handleApi(request, response, url)) return;
      request.audit.action = "api_not_found";
      request.audit.outcome = "not_found";
      sendJson(response, 404, { ok: false, error: "接口不存在" });
      return;
    }
    await serveStatic(request, response, url);
  } catch (error) {
    if (request.audit) {
      request.audit.outcome = request.audit.outcome || "error";
      request.audit.details = { ...request.audit.details, error: { name: error.name, message: error.message, status: error.status ?? 500 } };
    }
    sendApiError(response, error, request.audit);
  }
});

function assertProductionStorageConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  if (storageMode !== "mysql") {
    throw new Error("Production scoring service must use CONTEST_STORAGE=mysql");
  }
  if (!process.env.CONTEST_DATABASE_URL && !process.env.CONTEST_MYSQL_USER) {
    throw new Error("Production MySQL service requires CONTEST_MYSQL_USER or CONTEST_DATABASE_URL");
  }
}

async function validateStartupState() {
  assertProductionStorageConfiguration();
  assertSupportedStorageMode();
  await initializeStorage();
  const state = await readState();
  const summary = getStateSummary(state);
  const formalRoundResidue = getFormalRoundResidue(state, summary);
  if (formalRoundResidue.length) {
    const message = `Existing contest state detected: submitted=${summary.submittedCount}, revised=${summary.revisedCount}`;
    if (process.env.REQUIRE_EMPTY_STATE === "1") {
      logAudit("error", "startup_state_rejected", { storageMode, summary, residue: formalRoundResidue, reason: "REQUIRE_EMPTY_STATE" });
      throw new Error(`${message}. Formal-round residue remains: ${formalRoundResidue.join(", ")}. Use the documented rehearsal reset before official scoring.`);
    }
    logAudit("warn", "startup_existing_state", { storageMode, summary, residue: formalRoundResidue });
    console.warn(`${message}. Confirm this is intended before official scoring.`);
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logAudit("warn", "server_shutdown_requested", { signal, activeSessions: getActiveSessionCount() });
  server.close(async () => {
    logAudit("info", "server_shutdown_complete", { signal });
    await closeStorage();
    await flushAuditLog();
    process.exit(0);
  });
  setTimeout(() => {
    logAudit("error", "server_shutdown_forced", { signal, timeoutMs: 10000 });
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await validateStartupState();
} catch (error) {
  logAudit("error", "server_start_failed", { storageMode, stateFile: storageMode === "file" ? stateFile : undefined, error });
  await closeStorage();
  await flushAuditLog();
  throw error;
}

server.listen(port, host, () => {
  const lanUrls = getLanUrls();
  logAudit("info", "server_started", {
    localUrl: `http://127.0.0.1:${port}/`,
    lanUrls,
    storageMode,
    dataDir,
    stateFile: storageMode === "file" ? stateFile : undefined,
    mysqlTables:
      storageMode === "mysql"
        ? [mysqlTables.teams, mysqlTables.accounts, mysqlTables.sessions, mysqlTables.roster, mysqlTables.entries, mysqlTables.controlState]
        : undefined,
    logDir,
    maxRequestBodyBytes,
    sessionTtlMs,
    httpHeadersTimeoutMs,
    httpRequestTimeoutMs,
    httpKeepAliveTimeoutMs,
  });
  console.log(`Contest scoring server listening on http://127.0.0.1:${port}/`);
  lanUrls.forEach((lanUrl) => console.log(`LAN access: ${lanUrl}`));
  console.log(`Audit log file: ${getLogFilePath()}`);
});
