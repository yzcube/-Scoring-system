import assert from "node:assert/strict";
import test from "node:test";
import { getCompetitionRankingScope } from "./competitionSetup.js";

const firstHalf = { status: "open", teamIds: ["A", "B"], openedAt: "2026-07-19T01:00:00.000Z" };
const secondHalfDraft = { status: "draft", teamIds: ["C", "D"], openedAt: "" };

test("ranking scope shows only first-half teams during the first half and intermission", () => {
  const duringFirst = getCompetitionRankingScope({
    activeHalf: "first",
    teamIds: ["A", "B", "C", "D"],
    halves: { first: firstHalf, second: secondHalfDraft },
  });
  assert.equal(duringFirst.id, "first_half");
  assert.equal(duringFirst.title, "上半场排名");
  assert.deepEqual(duringFirst.teamIds, ["A", "B"]);

  const duringIntermission = getCompetitionRankingScope({
    activeHalf: null,
    teamIds: ["A", "B", "C", "D"],
    halves: { first: { ...firstHalf, status: "closed" }, second: secondHalfDraft },
  });
  assert.equal(duringIntermission.id, "first_half");
  assert.deepEqual(duringIntermission.teamIds, ["A", "B"]);
});

test("ranking scope becomes cumulative as soon as the second half opens", () => {
  const duringSecond = getCompetitionRankingScope({
    activeHalf: "second",
    teamIds: ["A", "B", "C", "D"],
    halves: {
      first: { ...firstHalf, status: "closed" },
      second: { status: "open", teamIds: ["C", "D"], openedAt: "2026-07-19T06:00:00.000Z" },
    },
  });
  assert.equal(duringSecond.id, "overall");
  assert.equal(duringSecond.title, "总排名");
  assert.deepEqual(duringSecond.teamIds, ["A", "B", "C", "D"]);
});
