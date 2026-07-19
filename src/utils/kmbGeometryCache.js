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

export function filterKmbOverlayVariantsByDirection(variantKeys = [], direction = '') {
  const normalizedDirection = String(direction || '').trim().toUpperCase();
  const variants = Array.from(variantKeys || []);
  if (normalizedDirection !== 'I' && normalizedDirection !== 'O') return variants;
  return variants.filter(
    (key) => String(key || '').split('|')[1]?.trim().toUpperCase() === normalizedDirection,
  );
}
