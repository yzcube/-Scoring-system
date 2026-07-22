import test from "node:test";
import assert from "node:assert/strict";
import {
  getScoreboardRankingColumnCount,
  getScoreboardRankingMotionFrames,
  getScoreboardRankingMotionSteps,
  getScoreboardRankingSlot,
  getScoreboardRankingSlotOffset,
  getScoreboardRankingVisualRowCount,
} from "./scoreboardRankingLayout.js";

test("live rankings remain in one column for every supported team count", () => {
  assert.equal(getScoreboardRankingColumnCount(0), 1);
  assert.equal(getScoreboardRankingColumnCount(10), 1);
  assert.equal(getScoreboardRankingColumnCount(11), 1);
  assert.equal(getScoreboardRankingColumnCount(20), 1);
});

test("single-column rankings allocate one visual row per team", () => {
  assert.equal(getScoreboardRankingVisualRowCount(0), 1);
  assert.equal(getScoreboardRankingVisualRowCount(10), 10);
  assert.equal(getScoreboardRankingVisualRowCount(11), 11);
  assert.equal(getScoreboardRankingVisualRowCount(19), 19);
  assert.equal(getScoreboardRankingVisualRowCount(20), 20);
});

test("every rank occupies the same column and its own row", () => {
  assert.deepEqual(getScoreboardRankingSlot(0), { row: 0, column: 0 });
  assert.deepEqual(getScoreboardRankingSlot(9), { row: 9, column: 0 });
  assert.deepEqual(getScoreboardRankingSlot(10), { row: 10, column: 0 });
  assert.deepEqual(getScoreboardRankingSlot(19), { row: 19, column: 0 });
  assert.deepEqual(getScoreboardRankingSlotOffset(19, 3), { rowOffset: 16, columnOffset: 0 });
});

test("the current team climbs vertically through every crossed rank", () => {
  const steps = getScoreboardRankingMotionSteps(20, 3);
  assert.equal(steps.length, 17);
  assert.deepEqual(steps.map((step) => step.sourceIndex), [19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  assert.ok(steps.every((step) => step.columnOffset === 0));
  assert.deepEqual(steps.map((step) => step.rowOffset), [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test("single-column motion frames never contain a column handoff", () => {
  const frames = getScoreboardRankingMotionFrames(20, 3);
  assert.ok(frames.every((frame) => frame.columnOffset === 0));
  assert.ok(frames.every((frame) => frame.opacity === 1));
  assert.ok(frames.every((frame) => frame.phase === "slot"));
});

test("a team already in the final slot does not receive a motion animation", () => {
  assert.deepEqual(getScoreboardRankingMotionSteps(20, 19), []);
  assert.deepEqual(getScoreboardRankingMotionFrames(20, 19), []);
});
