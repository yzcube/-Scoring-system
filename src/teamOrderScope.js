function uniqueIds(ids) {
  const seen = new Set();
  return (Array.isArray(ids) ? ids : []).filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function reconcileConfiguredTeamOrder(fullOrder, configuredTeamIds, previousDraft) {
  const normalizedFullOrder = uniqueIds(fullOrder);
  const configuredIdSet = new Set(uniqueIds(configuredTeamIds));
  const officialConfiguredOrder = normalizedFullOrder.filter((id) => configuredIdSet.has(id));
  const officialConfiguredIdSet = new Set(officialConfiguredOrder);
  const nextOrder = uniqueIds(previousDraft).filter((id) => officialConfiguredIdSet.has(id));
  const nextIdSet = new Set(nextOrder);

  for (const id of officialConfiguredOrder) {
    if (nextIdSet.has(id)) continue;
    nextOrder.push(id);
    nextIdSet.add(id);
  }

  return nextOrder;
}

export function mergeConfiguredTeamOrder(fullOrder, configuredTeamIds, configuredOrder) {
  const normalizedFullOrder = uniqueIds(fullOrder);
  const officialConfiguredOrder = reconcileConfiguredTeamOrder(normalizedFullOrder, configuredTeamIds);
  const normalizedConfiguredOrder = reconcileConfiguredTeamOrder(
    normalizedFullOrder,
    configuredTeamIds,
    configuredOrder,
  );
  const configuredIdSet = new Set(officialConfiguredOrder);
  let configuredIndex = 0;

  return normalizedFullOrder.map((id) => (
    configuredIdSet.has(id) ? normalizedConfiguredOrder[configuredIndex++] : id
  ));
}
