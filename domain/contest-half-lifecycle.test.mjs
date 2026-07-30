import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceDisplayToNextTeam,
  advanceDisplayToPreviousTeam,
  closeCompetitionGroup,
  dispatchAssignment,
  finishCompetitionFirstHalf,
  openCompetitionGroup,
  openCompetitionSecondHalf,
  publishDisplaySelection,
  saveCompetitionGroupSetup,
  saveCompetitionSecondHalf,
  showDisplayRankings,
  updateAssignmentSubmissionStatus,
} from "./contestControl.js";
import { deriveAdminWorkflowStatus } from "../shared/adminWorkflow.js";
import { normalizeCompetitionSetup } from "../shared/competitionSetup.js";
import { itemIds, itemMax } from "../shared/scoringRules.js";
import { getFinalResultExportData } from "../server/result-export-data.mjs";

const judgeIds = ["001", "002", "003"];

function scoresForTotal(total) {
  return Object.fromEntries(itemIds.map((itemId) => [itemId, itemMax[itemId] * total / 100]));
}

function createState() {
  const teams = Array.from({ length: 4 }, (_, index) => ({
    id: `GZ${String(index + 1).padStart(2, "0")}`,
    groupId: "gaozhi",
    registrationNumber: `REG-${index + 1}`,
    teamName: `队伍${index + 1}`,
    projectName: "",
    appearanceOrder: index + 1,
    status: "active",
    revision: 1,
    judgeRosterSnapshot: [],
    createdAt: "",
    updatedAt: "",
  }));
  const accounts = judgeIds.map((id) => ({
    id,
    username: id,
    displayName: `评委${id}`,
    role: "judge",
    status: "active",
  }));
  const state = {
    teams,
    accounts,
    entriesByJudge: Object.fromEntries(judgeIds.map((id) => [id, {}])),
    judgeRoster: {
      judgeIds: [...judgeIds],
      revision: 0,
      lockedAt: "",
      effectiveMode: "next_assignment",
      reason: "",
      updatedBy: "",
      updatedAt: "",
    },
    activeAssignment: {
      groupId: "gaozhi",
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
      rankingAnimationEnabled: true,
      revealedTeamIdsByGroup: { gaozhi: [] },
      rankingTransition: null,
    },
  };
  state.competitionSetup = normalizeCompetitionSetup(
    {
      activeGroupId: null,
      revision: 0,
      groups: {
        gaozhi: {
          groupId: "gaozhi",
          status: "draft",
          teamIds: [],
          judgeIds,
          revision: 0,
        },
      },
    },
    state,
  );
  return state;
}

function submitFinalScores(state, teamId, baseTotal) {
  judgeIds.forEach((judgeId, index) => {
    state.entriesByJudge[judgeId][teamId] = {
      scores: scoresForTotal(baseTotal + index),
      submitted: true,
      updatedAt: "",
      clientUpdatedAt: 0,
      serverRevision: 1,
      serverUpdatedAt: "",
    };
  });
}

function withSummaries(state) {
  const summariesByTeam = Object.fromEntries(
    state.teams.map((team) => [
      team.id,
      {
        isFinal: judgeIds.every((judgeId) => state.entriesByJudge[judgeId]?.[team.id]?.submitted),
        submittedCount: judgeIds.filter((judgeId) => state.entriesByJudge[judgeId]?.[team.id]?.submitted).length,
        rosterCount: judgeIds.length,
      },
    ]),
  );
  return { ...state, summariesByTeam };
}

test("legacy open setup is normalized as an active first half without losing its teams", () => {
  const state = createState();
  const normalized = normalizeCompetitionSetup(
    {
      activeGroupId: "gaozhi",
      revision: 3,
      groups: {
        gaozhi: {
          groupId: "gaozhi",
          status: "open",
          teamIds: ["GZ01", "GZ02"],
          judgeIds,
          revision: 4,
        },
      },
    },
    state,
  );
  assert.equal(normalized.groups.gaozhi.activeHalf, "first");
  assert.equal(normalized.groups.gaozhi.halves.first.status, "open");
  assert.deepEqual(normalized.groups.gaozhi.halves.first.teamIds, ["GZ01", "GZ02"]);
  assert.deepEqual(normalized.groups.gaozhi.teamIds, ["GZ01", "GZ02"]);
});

test("two halves preserve first-half results while dispatch stays scoped to the active half", () => {
  const state = createState();
  saveCompetitionGroupSetup(state, {
    groupId: "gaozhi",
    teamIds: ["GZ01", "GZ02"],
    judgeIds,
    expectedRevision: 0,
    actorId: "admin",
  });
  openCompetitionGroup(state, {
    groupId: "gaozhi",
    expectedRevision: 1,
    actorId: "admin",
  });
  assert.equal(state.competitionSetup.groups.gaozhi.activeHalf, "first");

  submitFinalScores(state, "GZ01", 80);
  submitFinalScores(state, "GZ02", 82);
  state.activeAssignment = {
    ...state.activeAssignment,
    teamId: "GZ02",
    status: "final",
    rosterSnapshot: [...judgeIds],
  };
  state.displaySelection.revealedTeamIdsByGroup.gaozhi = ["GZ01", "GZ02"];
  const firstHalfEntries = JSON.stringify(state.entriesByJudge);
  const revealedBeforeIntermission = [...state.displaySelection.revealedTeamIdsByGroup.gaozhi];

  finishCompetitionFirstHalf(state, {
    groupId: "gaozhi",
    expectedRevision: 2,
    actorId: "admin",
  });
  assert.equal(state.competitionSetup.groups.gaozhi.status, "open");
  assert.equal(state.competitionSetup.groups.gaozhi.activeHalf, null);
  assert.equal(state.activeAssignment.teamId, null);
  assert.equal(state.activeAssignment.status, "idle");
  assert.equal(JSON.stringify(state.entriesByJudge), firstHalfEntries);
  assert.deepEqual(state.displaySelection.revealedTeamIdsByGroup.gaozhi, revealedBeforeIntermission);

  let workflow = deriveAdminWorkflowStatus(withSummaries(state), { groupId: "gaozhi" });
  assert.equal(workflow.phase, "intermission");
  assert.equal(workflow.primaryAction.id, "configure_second_half");

  saveCompetitionSecondHalf(state, {
    groupId: "gaozhi",
    teamIds: ["GZ03", "GZ04"],
    expectedRevision: 3,
    actorId: "admin",
  });
  assert.deepEqual(state.competitionSetup.groups.gaozhi.teamIds, ["GZ01", "GZ02", "GZ03", "GZ04"]);
  assert.deepEqual(state.competitionSetup.groups.gaozhi.halves.second.teamIds, ["GZ03", "GZ04"]);
  assert.equal(JSON.stringify(state.entriesByJudge), firstHalfEntries);

  openCompetitionSecondHalf(state, {
    groupId: "gaozhi",
    expectedRevision: 4,
    actorId: "admin",
  });
  assert.equal(state.competitionSetup.groups.gaozhi.activeHalf, "second");
  assert.throws(
    () => dispatchAssignment(state, {
      teamId: "GZ01",
      expectedRevision: state.activeAssignment.assignmentRevision,
    }),
    /current half|active half|当前半场/,
  );
  dispatchAssignment(state, {
    teamId: "GZ03",
    expectedRevision: state.activeAssignment.assignmentRevision,
  });
  assert.equal(state.activeAssignment.teamId, "GZ03");

  submitFinalScores(state, "GZ03", 90);
  submitFinalScores(state, "GZ04", 84);
  updateAssignmentSubmissionStatus(state);
  state.displaySelection.teamId = "GZ02";
  state.displaySelection.publicationStatus = "final";
  state.displaySelection.projectionView = "scoreboard";
  state.displaySelection.revealedTeamIdsByGroup.gaozhi = ["GZ01"];
  publishDisplaySelection(state, {
    teamId: "GZ03",
    publicationStatus: "final",
    expectedRevision: state.displaySelection.displayRevision,
    now: "2026-07-18T12:00:00.000Z",
  });
  assert.deepEqual(state.displaySelection.rankingTransition.teamIds, ["GZ01", "GZ02"]);
  assert.deepEqual(state.displaySelection.revealedTeamIdsByGroup.gaozhi, ["GZ01", "GZ02", "GZ03"]);
  state.activeAssignment = {
    ...state.activeAssignment,
    teamId: "GZ04",
    status: "final",
    rosterSnapshot: [...judgeIds],
  };
  workflow = deriveAdminWorkflowStatus(withSummaries(state), { groupId: "gaozhi" });
  assert.equal(workflow.phase, "result_ready");
  state.displaySelection.rankingTransition = null;
  state.displaySelection.teamId = "GZ04";
  state.displaySelection.publicationStatus = "final";
  workflow = deriveAdminWorkflowStatus(withSummaries(state), { groupId: "gaozhi" });
  assert.equal(workflow.phase, "ready_to_close");

  const exportData = getFinalResultExportData(state, "gaozhi");
  assert.equal(exportData.rows.length, 4);
  assert(exportData.rows.some((row) => row.registrationNumber === "REG-1"));
  assert(exportData.rows.some((row) => row.registrationNumber === "REG-3"));

  closeCompetitionGroup(state, {
    groupId: "gaozhi",
    expectedRevision: 5,
    actorId: "admin",
  });
  assert.equal(state.competitionSetup.groups.gaozhi.status, "closed");
  assert.equal(state.competitionSetup.groups.gaozhi.halves.second.status, "closed");
  workflow = deriveAdminWorkflowStatus(withSummaries(state), { groupId: "gaozhi" });
  assert.equal(workflow.phase, "competition_complete");
  assert.equal(workflow.progress.halfLabel, "上下半场已完成");
  assert.deepEqual(workflow.progress.currentHalf, {
    id: "second",
    completedTeams: 2,
    totalTeams: 2,
    percentage: 100,
  });
});

test("second-half setup rejects teams already used in the first half", () => {
  const state = createState();
  saveCompetitionGroupSetup(state, {
    groupId: "gaozhi",
    teamIds: ["GZ01"],
    judgeIds,
    expectedRevision: 0,
  });
  openCompetitionGroup(state, { groupId: "gaozhi", expectedRevision: 1 });
  submitFinalScores(state, "GZ01", 80);
  state.activeAssignment = { ...state.activeAssignment, teamId: "GZ01", status: "final", rosterSnapshot: [...judgeIds] };
  finishCompetitionFirstHalf(state, { groupId: "gaozhi", expectedRevision: 2 });
  assert.throws(
    () => saveCompetitionSecondHalf(state, {
      groupId: "gaozhi",
      teamIds: ["GZ01"],
      expectedRevision: 3,
    }),
    /不能与上半场重叠/,
  );
});

test("shared score projection moves through configured order without wrapping and preserves publication semantics", () => {
  const state = createState();
  saveCompetitionGroupSetup(state, {
    groupId: "gaozhi",
    teamIds: ["GZ01", "GZ02", "GZ03", "GZ04"],
    judgeIds,
    expectedRevision: 0,
  });
  state.displaySelection.projectionView = "scoreboard";
  state.displaySelection.rankingAnimationEnabled = false;
  submitFinalScores(state, "GZ01", 80);
  publishDisplaySelection(state, {
    teamId: "GZ01",
    publicationStatus: "final",
    expectedRevision: state.displaySelection.displayRevision,
  });
  const assignmentBefore = JSON.stringify(state.activeAssignment);
  const firstRevision = state.displaySelection.displayRevision;

  const waitingAdvance = advanceDisplayToNextTeam(state, {
    expectedRevision: firstRevision,
    now: "2026-07-19T10:00:00.000Z",
  });
  assert.equal(waitingAdvance.changed, true);
  assert.equal(waitingAdvance.fromTeamId, "GZ01");
  assert.equal(waitingAdvance.toTeamId, "GZ02");
  assert.equal(state.displaySelection.teamId, "GZ02");
  assert.equal(state.displaySelection.publicationStatus, "waiting");
  assert(!state.displaySelection.revealedTeamIdsByGroup.gaozhi.includes("GZ02"));
  assert.equal(JSON.stringify(state.activeAssignment), assignmentBefore);
  assert.throws(
    () => advanceDisplayToNextTeam(state, { expectedRevision: firstRevision }),
    /已更新|refresh|version/i,
  );

  state.entriesByJudge["001"].GZ02 = {
    scores: scoresForTotal(82),
    submitted: true,
    updatedAt: "",
    clientUpdatedAt: 0,
    serverRevision: 1,
    serverUpdatedAt: "",
  };
  state.entriesByJudge["001"].GZ03 = {
    scores: scoresForTotal(84),
    submitted: true,
    updatedAt: "",
    clientUpdatedAt: 0,
    serverRevision: 1,
    serverUpdatedAt: "",
  };
  const temporaryAdvance = advanceDisplayToNextTeam(state, {
    expectedRevision: state.displaySelection.displayRevision,
  });
  assert.equal(temporaryAdvance.toTeamId, "GZ03");
  assert.equal(state.displaySelection.publicationStatus, "temporary");
  assert(state.displaySelection.revealedTeamIdsByGroup.gaozhi.includes("GZ02"));

  submitFinalScores(state, "GZ04", 90);
  const finalAdvance = advanceDisplayToNextTeam(state, {
    expectedRevision: state.displaySelection.displayRevision,
  });
  assert.equal(finalAdvance.toTeamId, "GZ04");
  assert.equal(state.displaySelection.publicationStatus, "final");
  const finalRevision = state.displaySelection.displayRevision;
  const endAdvance = advanceDisplayToNextTeam(state, {
    expectedRevision: finalRevision,
  });
  assert.equal(endAdvance.changed, false);
  assert.equal(endAdvance.reason, "end_of_group");
  assert.equal(state.displaySelection.teamId, "GZ04");
  assert.equal(state.displaySelection.displayRevision, finalRevision);
  assert.equal(JSON.stringify(state.activeAssignment), assignmentBefore);

  const previousTemporary = advanceDisplayToPreviousTeam(state, {
    expectedRevision: finalRevision,
  });
  assert.equal(previousTemporary.changed, true);
  assert.equal(previousTemporary.reason, "rewound");
  assert.equal(previousTemporary.fromTeamId, "GZ04");
  assert.equal(previousTemporary.toTeamId, "GZ03");
  assert.equal(state.displaySelection.teamId, "GZ03");
  assert.equal(state.displaySelection.publicationStatus, "temporary");
  assert.throws(
    () => advanceDisplayToPreviousTeam(state, { expectedRevision: finalRevision }),
    /已更新|refresh|version/i,
  );

  advanceDisplayToPreviousTeam(state, {
    expectedRevision: state.displaySelection.displayRevision,
  });
  const previousFinal = advanceDisplayToPreviousTeam(state, {
    expectedRevision: state.displaySelection.displayRevision,
  });
  assert.equal(previousFinal.toTeamId, "GZ01");
  assert.equal(state.displaySelection.publicationStatus, "final");
  const firstTeamRevision = state.displaySelection.displayRevision;
  const startAdvance = advanceDisplayToPreviousTeam(state, {
    expectedRevision: firstTeamRevision,
  });
  assert.equal(startAdvance.changed, false);
  assert.equal(startAdvance.reason, "start_of_group");
  assert.equal(state.displaySelection.teamId, "GZ01");
  assert.equal(state.displaySelection.displayRevision, firstTeamRevision);
  assert.equal(JSON.stringify(state.activeAssignment), assignmentBefore);
});

test("publishing an unscored team from rankings returns directly to the waiting scoreboard", () => {
  const state = createState();
  saveCompetitionGroupSetup(state, {
    groupId: "gaozhi",
    teamIds: ["GZ01", "GZ02"],
    judgeIds,
    expectedRevision: 0,
  });
  openCompetitionGroup(state, {
    groupId: "gaozhi",
    expectedRevision: 1,
  });
  submitFinalScores(state, "GZ01", 80);
  publishDisplaySelection(state, {
    teamId: "GZ01",
    publicationStatus: "final",
    expectedRevision: state.displaySelection.displayRevision,
  });
  showDisplayRankings(state, {
    groupId: "gaozhi",
    expectedRevision: state.displaySelection.displayRevision,
  });

  publishDisplaySelection(state, {
    teamId: "GZ02",
    publicationStatus: "waiting",
    expectedRevision: state.displaySelection.displayRevision,
  });

  assert.equal(state.displaySelection.projectionView, "scoreboard");
  assert.equal(state.displaySelection.teamId, "GZ02");
  assert.equal(state.displaySelection.publicationStatus, "waiting");
  assert.equal(state.displaySelection.rankingTransition, null);
  assert.equal(judgeIds.filter((judgeId) => state.entriesByJudge[judgeId]?.GZ02?.submitted).length, 0);
});

test("shared score projection cannot enter a drafted second half before it opens", () => {
  const state = createState();
  saveCompetitionGroupSetup(state, {
    groupId: "gaozhi",
    teamIds: ["GZ01", "GZ02"],
    judgeIds,
    expectedRevision: 0,
  });
  openCompetitionGroup(state, {
    groupId: "gaozhi",
    expectedRevision: 1,
  });
  submitFinalScores(state, "GZ01", 80);
  submitFinalScores(state, "GZ02", 82);
  state.activeAssignment = {
    ...state.activeAssignment,
    teamId: "GZ02",
    status: "final",
    rosterSnapshot: [...judgeIds],
  };
  publishDisplaySelection(state, {
    teamId: "GZ02",
    publicationStatus: "final",
    expectedRevision: state.displaySelection.displayRevision,
  });
  finishCompetitionFirstHalf(state, {
    groupId: "gaozhi",
    expectedRevision: 2,
  });
  saveCompetitionSecondHalf(state, {
    groupId: "gaozhi",
    teamIds: ["GZ03", "GZ04"],
    expectedRevision: 3,
  });

  const intermissionRevision = state.displaySelection.displayRevision;
  const intermissionAdvance = advanceDisplayToNextTeam(state, {
    expectedRevision: intermissionRevision,
  });
  assert.equal(intermissionAdvance.changed, false);
  assert.equal(intermissionAdvance.reason, "end_of_group");
  assert.equal(state.displaySelection.teamId, "GZ02");
  assert.equal(state.displaySelection.displayRevision, intermissionRevision);

  openCompetitionSecondHalf(state, {
    groupId: "gaozhi",
    expectedRevision: 4,
  });
  const secondHalfAdvance = advanceDisplayToNextTeam(state, {
    expectedRevision: state.displaySelection.displayRevision,
  });
  assert.equal(secondHalfAdvance.changed, true);
  assert.equal(secondHalfAdvance.toTeamId, "GZ03");
  assert.equal(state.displaySelection.teamId, "GZ03");
  assert.equal(state.displaySelection.publicationStatus, "waiting");
});
