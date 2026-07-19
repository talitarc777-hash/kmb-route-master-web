export function buildKmbGeometryCacheKey(stopIds = [], routeIdentity = '') {
  const normalizedRouteIdentity = String(routeIdentity || '').trim();
  const stopSequence = (stopIds || [])
    .map((stopId) => String(stopId || '').trim())
    .filter(Boolean)
    .join('>');
  const stopSequenceKey = 'stops:' + stopSequence;
  return normalizedRouteIdentity
    ? normalizedRouteIdentity + '|' + stopSequenceKey
    : stopSequenceKey;
}
