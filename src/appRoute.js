export function normalizeAppPath(pathname) {
  const normalized = String(pathname || "/").replace(/\/+$/, "");
  return normalized || "/";
}

export const SCOREBOARD_RESULTS_PATH = "/scoreboard";
export const SCOREBOARD_SLOGAN_PATH = "/scoreboard/slogan";

export function getScoreboardRoute(publicationStatus) {
  return ["final", "temporary"].includes(publicationStatus)
    ? SCOREBOARD_RESULTS_PATH
    : SCOREBOARD_SLOGAN_PATH;
}

export function getLiveScoreboardEntryRoute(payload) {
  const submittedCount = Number(payload?.displaySummary?.submittedCount ?? 0);
  if (!payload?.displayTeam || !Number.isFinite(submittedCount) || submittedCount < 1) {
    return SCOREBOARD_SLOGAN_PATH;
  }
  return getScoreboardRoute(payload?.displaySelection?.publicationStatus);
}
