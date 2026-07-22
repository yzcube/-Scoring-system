import { getCompositeSummary } from "../domain/contestControl.js";
import { getOrderedSetupTeams } from "../shared/competitionSetup.js";
import { contestGroups } from "../shared/contestData.js";

const standardJudgeColumnCount = 7;

function getGroupLabel(groupId) {
  return contestGroups.find((group) => group.id === groupId)?.label ?? groupId;
}

function toScoreCents(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

export function getFinalResultExportData(state, groupId) {
  const rankedTeams = getOrderedSetupTeams(state, groupId)
    .map((team) => {
      const summary = getCompositeSummary(state, team.id);
      if (!summary.isFinal) return null;
      return {
        id: team.id,
        appearanceOrder: team.appearanceOrder,
        registrationNumber: team.registrationNumber ?? "",
        teamName: team.teamName,
        compositeScoreCents: toScoreCents(summary.display),
        judgeScores: summary.anonymousScores.map((score) => Number(score.score)),
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.compositeScoreCents - left.compositeScoreCents ||
      left.appearanceOrder - right.appearanceOrder ||
      left.id.localeCompare(right.id),
    );

  let previousScoreCents = null;
  let previousRank = 0;
  const rows = rankedTeams.map((team, index) => {
    const rank = previousScoreCents !== null && team.compositeScoreCents === previousScoreCents
      ? previousRank
      : index + 1;
    previousScoreCents = team.compositeScoreCents;
    previousRank = rank;
    return {
      rank,
      registrationNumber: team.registrationNumber,
      teamName: team.teamName,
      finalScore: team.compositeScoreCents / 100,
      judgeScores: team.judgeScores,
    };
  });

  return {
    groupId,
    groupLabel: getGroupLabel(groupId),
    judgeColumnCount: Math.max(standardJudgeColumnCount, ...rows.map((row) => row.judgeScores.length)),
    rows,
  };
}

export { standardJudgeColumnCount };
