const kmbStaticInflight = new Map();

async function fetchJsonEndpoint(url, label, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    const preview = text.slice(0, 40).replace(/\s+/g, ' ');
    throw new Error(`${label} returned non-JSON content: ${preview}`);
  }
}

export async function loadKmbPayloads(endpoints, sourceLabel, fetchImpl = fetch) {
  const key = endpoints.join('|');
  if (kmbStaticInflight.has(key)) return kmbStaticInflight.get(key);

  const request = (async () => {
    const [stopsData, routesData, routeStopsData] = await Promise.all([
      fetchJsonEndpoint(endpoints[0], `${sourceLabel} stop`, fetchImpl),
      fetchJsonEndpoint(endpoints[1], `${sourceLabel} route`, fetchImpl),
      fetchJsonEndpoint(endpoints[2], `${sourceLabel} route-stop`, fetchImpl),
    ]);

    if (!Array.isArray(stopsData?.data) || !Array.isArray(routesData?.data) || !Array.isArray(routeStopsData?.data)) {
      throw new Error(`${sourceLabel} KMB payload format error (missing data arrays).`);
    }
    return { stopsData, routesData, routeStopsData };
  })();

  kmbStaticInflight.set(key, request);
  try {
    return await request;
  } finally {
    kmbStaticInflight.delete(key);
  }
}

export function createLatestRequestTracker() {
  let latestId = 0;
  return {
    start() {
      latestId += 1;
      return latestId;
    },
    isCurrent(requestId) {
      return requestId === latestId;
    },
    invalidate() {
      latestId += 1;
    },
  };
}

export function isGoogleTransitRouteOption(route) {
  return route?.type === 'fallback_candidate' || route?.isFallback === true;
}

export function isKmbOnlyRouteOption(route) {
  if (!route || isGoogleTransitRouteOption(route)) return false;

  const declaredOperators = String(route.operator || '')
    .split('+')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (declaredOperators.some((operator) => operator !== 'KMB')) return false;

  const transitLegs = (route.legs || []).filter((leg) => {
    const operator = String(leg?.operator || '').trim().toUpperCase();
    return operator && operator !== 'WALK';
  });
  return transitLegs.every((leg) => String(leg.operator || '').trim().toUpperCase() === 'KMB');
}

export function filterRouteOptionsByGoogleTransitPermission(routes, googleTransitEnabled) {
  const options = Array.isArray(routes) ? routes : [];
  return googleTransitEnabled ? options : options.filter(isKmbOnlyRouteOption);
}

export function clearKmbStaticInflightForTests() {
  kmbStaticInflight.clear();
}
