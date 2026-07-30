export function getScoreboardRankingColumnCount() {
  return 1;
}

export function getScoreboardRankingVisualRowCount(teamCount) {
  const total = Math.max(0, Math.trunc(Number(teamCount) || 0));
  return Math.max(1, total);
}

export function getScoreboardRankingSlot(index) {
  const safeIndex = Math.max(0, Math.trunc(Number(index) || 0));
  return { row: safeIndex, column: 0 };
}

export function getScoreboardRankingSlotOffset(sourceIndex, targetIndex) {
  const source = getScoreboardRankingSlot(sourceIndex);
  const target = getScoreboardRankingSlot(targetIndex);
  return {
    rowOffset: source.row - target.row,
    columnOffset: source.column - target.column,
  };
}

export function getScoreboardRankingMotionSteps(teamCount, finalIndex) {
  const total = Math.max(0, Math.trunc(Number(teamCount) || 0));
  const targetIndex = Math.trunc(Number(finalIndex));
  if (total === 0 || !Number.isFinite(targetIndex) || targetIndex < 0 || targetIndex >= total) return [];
  const startIndex = total - 1;
  const movedPositions = startIndex - targetIndex;
  if (movedPositions === 0) return [];
  return Array.from({ length: movedPositions + 1 }, (_, step) => {
    const sourceIndex = startIndex - step;
    return {
      offset: step / movedPositions,
      sourceIndex,
      ...getScoreboardRankingSlotOffset(sourceIndex, targetIndex),
    };
  });
}

export function getScoreboardRankingMotionFrames(teamCount, finalIndex) {
  return getScoreboardRankingMotionSteps(teamCount, finalIndex).map((step) => ({
    ...step,
    opacity: 1,
    phase: "slot",
  }));
}

export function getScoreboardRankingRowHeight(teamCount) {
  const count = getScoreboardRankingVisualRowCount(teamCount);
  const availableWidth = 44.6;
  const gapWidth = 0.14;
  const rowWidth = (availableWidth - (count - 1) * gapWidth) / count;
  return `min(${rowWidth.toFixed(4)}vw, ${(rowWidth * 1.7777778).toFixed(4)}svh, 4.45vw, 7.9111svh)`;
}
