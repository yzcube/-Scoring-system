export function getOverallRankingColumns(rankings) {
  const rows = Array.isArray(rankings) ? rankings : [];
  if (rows.length <= 10) return [rows];
  const columnBreak = Math.ceil(rows.length / 2);
  return [rows.slice(0, columnBreak), rows.slice(columnBreak)].filter((column) => column.length > 0);
}

export function getOverallRankingRowSlotCount(teamCount, useTwoColumns) {
  const total = Number(teamCount) || 0;
  return Math.max(1, (useTwoColumns ? Math.ceil(total / 2) : total) + 1);
}

export function getOverallRankingRowHeight(teamCount, useTwoColumns) {
  const count = getOverallRankingRowSlotCount(teamCount, useTwoColumns);
  const availableWidth = 43.5;
  const gapWidth = 0.12;
  const rowWidth = (availableWidth - (count - 1) * gapWidth) / count;
  return `min(${rowWidth.toFixed(4)}vw, ${(rowWidth * 1.7777778).toFixed(4)}svh, 4vw, 7.1111svh)`;
}
