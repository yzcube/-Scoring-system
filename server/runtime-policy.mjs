const disabledValues = new Set(["0", "false", "no", "off"]);

export function readBoundedInteger(value, fallback, { name, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  const candidate = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

export function resolveAdminPasswordRotationPolicy({ explicit, storageMode, nodeEnv }) {
  if (storageMode === "mysql" || nodeEnv === "production") return true;
  if (explicit !== undefined) return !disabledValues.has(String(explicit).trim().toLowerCase());
  return false;
}

export function getFormalRoundResidue(state, summary = {}) {
  const reasons = [];
  if (Number(summary.submittedCount) > 0 || Number(summary.revisedCount) > 0) reasons.push("score_entries");
  if ((state.teams ?? []).some((team) => team.judgeRosterSnapshot?.length)) reasons.push("team_roster_snapshots");
  if (state.competitionSetup?.activeGroupId || Object.values(state.competitionSetup?.groups ?? {}).some((group) => group.status !== "draft")) {
    reasons.push("competition_setup");
  }
  const assignment = state.activeAssignment ?? {};
  if (assignment.teamId || assignment.status !== "idle" || assignment.rosterSnapshot?.length) reasons.push("active_assignment");
  const display = state.displaySelection ?? {};
  if (display.teamId || ![undefined, "idle"].includes(display.publicationStatus)) reasons.push("display_selection");
  if (state.judgeRoster?.lockedAt) reasons.push("locked_roster");
  return reasons;
}
