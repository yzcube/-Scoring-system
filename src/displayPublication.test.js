import assert from "node:assert/strict";
import test from "node:test";
import { getDisplayPublicationStatus } from "./displayPublication.js";

test("display publication status keeps an unscored team on the waiting scoreboard", () => {
  assert.equal(getDisplayPublicationStatus({ submittedCount: 0, isFinal: false }), "waiting");
  assert.equal(getDisplayPublicationStatus(undefined), "waiting");
});

test("display publication status follows partial and final judge submissions", () => {
  assert.equal(getDisplayPublicationStatus({ submittedCount: 1, isFinal: false }), "temporary");
  assert.equal(getDisplayPublicationStatus({ submittedCount: 7, isFinal: true }), "final");
});
