import test from "node:test";
import assert from "node:assert/strict";
import { getOverallRankingColumns, getOverallRankingRowSlotCount } from "./rankingsLayout.js";

const teams = Array.from({ length: 20 }, (_, index) => ({ id: `team-${index + 1}`, rank: index + 1 }));

test("first-half rankings stay in one column", () => {
  const columns = getOverallRankingColumns(teams.slice(0, 10));
  assert.equal(columns.length, 1);
  assert.deepEqual(columns[0].map((team) => team.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("rankings over 10 teams split into continuous columns", () => {
  const columns = getOverallRankingColumns(teams);
  assert.equal(columns.length, 2);
  assert.deepEqual(columns[0].map((team) => team.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(columns[1].map((team) => team.rank), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
});

test("overall ranking row slots include one table header", () => {
  assert.equal(getOverallRankingRowSlotCount(0, false), 1);
  assert.equal(getOverallRankingRowSlotCount(10, false), 11);
  assert.equal(getOverallRankingRowSlotCount(11, true), 7);
  assert.equal(getOverallRankingRowSlotCount(20, true), 11);
});
