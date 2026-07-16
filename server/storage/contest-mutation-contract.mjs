function requireValue(effect, key) {
  if (effect[key] === undefined || effect[key] === null || effect[key] === "") {
    throw new Error(`Contest effect ${effect.type} requires ${key}`);
  }
}

export function createContestPersistencePlan(effect) {
  if (!effect || typeof effect !== "object") throw new Error("Contest effect is required");
  switch (effect.type) {
    case "noop":
      return { type: "noop" };
    case "team":
      requireValue(effect, "teamId");
      if (effect.orderChanged === true) requireValue(effect, "groupId");
      return {
        type: "team",
        teamId: effect.teamId,
        persistDisplay: effect.displayInvalidated === true,
        persistTeamOrderGroup: effect.orderChanged === true ? effect.groupId : undefined,
      };
    case "team_order":
      requireValue(effect, "groupId");
      return { type: "team_order", groupId: effect.groupId, persistTeamOrderGroup: effect.groupId };
    case "team_delete":
      requireValue(effect, "teamId");
      requireValue(effect, "groupId");
      if (!Array.isArray(effect.teamIds)) throw new Error("Contest effect team_delete requires teamIds");
      return {
        type: "team_delete",
        teamId: effect.teamId,
        groupId: effect.groupId,
        teamIds: effect.teamIds,
        persistTeamOrderGroup: effect.groupId,
        persistCompetitionSetup: effect.setupChanged === true,
        persistDisplay: effect.displayInvalidated === true,
      };
    case "account":
      requireValue(effect, "accountId");
      return {
        type: "account",
        accountId: effect.accountId,
        ...(effect.rosterChanged === true ? { persistRoster: true } : {}),
      };
    case "judge_enrollment":
      requireValue(effect, "accountId");
      requireValue(effect, "auditEvent");
      return { type: "judge_enrollment", accountId: effect.accountId, auditEvent: effect.auditEvent, persistRoster: true };
    case "roster":
      return { type: "roster", persistRoster: true };
    case "entry":
      requireValue(effect, "judgeId");
      requireValue(effect, "teamId");
      return {
        type: "entry",
        judgeId: effect.judgeId,
        teamId: effect.teamId,
        persistAssignment:
          effect.assignmentChanged === true || effect.rescoreChanged === true,
        persistDisplay: effect.displayInvalidated === true,
      };
    case "assignment":
      if (!Array.isArray(effect.teamIds)) throw new Error("Contest effect assignment requires teamIds");
      return { type: "assignment", teamIds: effect.teamIds, persistAssignment: true, persistRoster: effect.rosterChanged === true };
    case "display":
      return { type: "display", persistDisplay: true };
    case "competition_setup":
      if (!["save", "open"].includes(effect.operation)) {
        throw new Error("Contest effect competition_setup requires operation");
      }
      return {
        type: "competition_setup",
        operation: effect.operation,
        persistCompetitionSetup: true,
        persistRoster: effect.operation === "open",
        persistAssignment: effect.operation === "open",
      };
    case "competition_close":
      return {
        type: "competition_close",
        persistCompetitionSetup: true,
        persistAssignment: true,
      };
    case "competition_restart":
      if (!Array.isArray(effect.teamIds) || !Array.isArray(effect.clearEntriesTeamIds)) {
        throw new Error("Contest effect competition_restart requires team and clear-entry scopes");
      }
      return {
        type: "competition_restart",
        teamIds: effect.teamIds,
        clearEntriesTeamIds: effect.clearEntriesTeamIds,
        persistCompetitionSetup: true,
        persistRoster: true,
        persistAssignment: effect.assignmentReset === true,
        persistDisplay: effect.displayInvalidated === true,
      };
    case "assignment_roster_replace":
      requireValue(effect, "clearEntryTeamId");
      if (!Array.isArray(effect.teamIds) || !Array.isArray(effect.clearEntryJudgeIds)) {
        throw new Error("Contest effect assignment_roster_replace requires team and judge scopes");
      }
      return {
        type: "assignment_roster_replace",
        teamIds: effect.teamIds,
        clearEntryTeamId: effect.clearEntryTeamId,
        clearEntryJudgeIds: effect.clearEntryJudgeIds,
        persistAssignment: true,
        persistDisplay: effect.displayInvalidated === true,
      };
    default:
      throw new Error(`Unsupported contest effect type: ${effect.type ?? "missing"}`);
  }
}

export function assertContestMutationContract(effect) {
  createContestPersistencePlan(effect);
  return effect;
}
