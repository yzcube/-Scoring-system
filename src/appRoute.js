export function normalizeAppPath(pathname) {
  const normalized = String(pathname || "/").replace(/\/+$/, "");
  return normalized || "/";
}

export const SCOREBOARD_RESULTS_PATH = "/scoreboard";
export const SCOREBOARD_SLOGAN_PATH = "/scoreboard/slogan";
export const SCOREBOARD_DEMO_PATH = "/scoreboard/demo";
export const SCOREBOARD_CLEAN_DEMO_PATH = "/scoreboard/demo-clean";
export const SCOREBOARD_TECH_DEMO_PATH = "/scoreboard/demo-tech";
export const SCOREBOARD_TECH_BACKUP_DEMO_PATH = "/scoreboard/demo-tech-backup";
export const SCOREBOARD_TECH_NINE_JUDGES_DEMO_PATH = "/scoreboard/demo-tech-nine-judges";
export const SCOREBOARD_TECH_TOTAL_EXTREMES_GROUPED_DEMO_PATH = "/scoreboard/demo-tech-total-extremes-grouped";
export const SCOREBOARD_PREMIUM_DEMO_PATH = "/scoreboard/demo-tech-premium";

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
