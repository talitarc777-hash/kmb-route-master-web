export function routeResultGroupKey(route) {
  const stopPattern = (route?.segments || [])
    .map((segment) => `${segment.fromStop}->${segment.toStop}`)
    .join('|');
  return `${route?.transfers ?? 0}|${stopPattern}`;
}

export function buildRouteResultCards(
  routes,
  { isFallbackRoute, estimatedTimeForRanking, buildSegmentDisplay },
) {
  const groups = new Map();
  const cardsByKey = new Map();
  const orderedKeys = [];

  for (const route of routes || []) {
    if (isFallbackRoute(route)) {
      const key = route.id || `fallback-${orderedKeys.length}`;
      cardsByKey.set(key, {
        key,
        type: 'fallback',
        representative: route,
        segmentDisplay: [],
      });
      orderedKeys.push(key);
      continue;
    }

    const groupKey = routeResultGroupKey(route);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
      orderedKeys.push(groupKey);
    }
    groups.get(groupKey).push(route);
  }

  for (const [groupKey, groupRoutes] of groups) {
    const sortedRoutes = [...groupRoutes].sort(
      (left, right) => estimatedTimeForRanking(left) - estimatedTimeForRanking(right),
    );
    cardsByKey.set(groupKey, {
      key: groupKey,
      representative: sortedRoutes[0],
      segmentDisplay: buildSegmentDisplay(sortedRoutes),
    });
  }

  return orderedKeys.map((key) => cardsByKey.get(key)).filter(Boolean);
}

export function findMatchingRouteResultCard(cards, selectedRoute, isFallbackRoute) {
  if (!selectedRoute) return null;
  if (isFallbackRoute(selectedRoute)) {
    return (cards || []).find((card) =>
      card.type === 'fallback' && card.representative?.id === selectedRoute.id,
    ) || null;
  }
  const selectedKey = routeResultGroupKey(selectedRoute);
  return (cards || []).find((card) => card.type !== 'fallback' && card.key === selectedKey) || null;
}
