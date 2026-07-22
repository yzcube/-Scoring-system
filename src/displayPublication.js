export function getDisplayPublicationStatus(summary) {
  if (summary?.isFinal) return "final";
  return Number(summary?.submittedCount ?? 0) > 0 ? "temporary" : "waiting";
}
