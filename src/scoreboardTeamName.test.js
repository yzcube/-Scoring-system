import test from "node:test";
import assert from "node:assert/strict";
import { getScoreboardTeamNamePresentation } from "./scoreboardTeamName.js";

test("short Chinese and mixed-script team names use the same display-size class", () => {
  const mixed = getScoreboardTeamNamePresentation("数航AI社");
  const chinese = getScoreboardTeamNamePresentation("启航跨境");

  assert.equal(mixed.className, "is-short-display-name is-compact-name");
  assert.equal(chinese.className, "is-short-display-name is-compact-name");
});

test("short Latin names keep their font trait without losing the short display size", () => {
  const latin = getScoreboardTeamNamePresentation("Trisilk");
  assert.equal(latin.className, "is-latin-name is-short-display-name is-compact-name");
});

test("punctuation does not make a visually short mixed name compact", () => {
  const mixed = getScoreboardTeamNamePresentation("“AI“上东南亚");
  assert.match(mixed.className, /is-short-display-name/);
});

test("long mixed-script names remain in the compact display size", () => {
  const longName = getScoreboardTeamNamePresentation("GCBT ASEAN Smart 智能跨境应用团队");
  assert.doesNotMatch(longName.className ?? "", /is-short-display-name/);
});
