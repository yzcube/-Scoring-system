import assert from "node:assert/strict";
import test from "node:test";
import {
  getControlledProjectionRoute,
  getLiveScoreboardEntryRoute,
  getScoreboardRoute,
  SCOREBOARD_RESULTS_PATH,
  SCOREBOARD_SLOGAN_PATH,
} from "./appRoute.js";

test("an unscored shared waiting team remains on the scoreboard route", () => {
  const payload = {
    displaySelection: {
      projectionView: "scoreboard",
      publicationStatus: "waiting",
    },
    displayTeam: { id: "GZ02" },
    displaySummary: { submittedCount: 0 },
  };

  assert.equal(getScoreboardRoute("waiting"), SCOREBOARD_RESULTS_PATH);
  assert.equal(getControlledProjectionRoute(payload.displaySelection), SCOREBOARD_RESULTS_PATH);
  assert.equal(getLiveScoreboardEntryRoute(payload), SCOREBOARD_RESULTS_PATH);
});

test("a stale score publication with no displayable team still returns to the slogan", () => {
  assert.equal(
    getLiveScoreboardEntryRoute({
      displaySelection: { projectionView: "scoreboard", publicationStatus: "final" },
      displayTeam: null,
      displaySummary: { submittedCount: 0 },
    }),
    SCOREBOARD_SLOGAN_PATH,
  );
});
