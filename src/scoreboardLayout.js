export function getScoreboardJudgeLayout(value) {
  const count = Math.max(0, Math.trunc(Number(value) || 0));
  if (count <= 7) return { count, columns: Math.max(1, count), rows: count ? 1 : 0, density: "regular" };
  if (count === 8) return { count, columns: 4, rows: 2, density: "two-row" };
  if (count <= 10) return { count, columns: 5, rows: 2, density: "two-row" };
  if (count <= 12) return { count, columns: 6, rows: 2, density: "dense" };
  return { count, columns: 7, rows: Math.ceil(count / 7), density: "compact" };
}
