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

function payloadRows(payload, label) {
  if (!Array.isArray(payload?.data)) {
    throw new Error(`KMB ${label} payload format error (missing data array).`);
  }
  return payload.data;
}

export function buildKmbNetworkIndexes({ stopsData, routesData, routeStopsData }) {
  const stopRows = payloadRows(stopsData, 'stop');
  const routeRows = payloadRows(routesData, 'route');
  const routeStopRows = payloadRows(routeStopsData, 'route-stop');
  const stopMap = {};
  const routeMap = {};
  const routeStopGroups = new Map();
  const stopRoutes = {};

  for (const stop of stopRows) {
    const stopId = String(stop?.stop || '').trim();
    const lat = Number(stop?.lat);
    const lng = Number(stop?.long);
    if (!stopId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    stopMap[stopId] = {
      name_en: stop.name_en,
      name_tc: stop.name_tc,
      lat,
      lng,
    };
  }

  for (const route of routeRows) {
    const routeCode = String(route?.route || '').trim();
    const bound = String(route?.bound || '').trim();
    const serviceType = String(route?.service_type || '').trim();
    if (!routeCode || !bound || !serviceType) continue;
    routeMap[`${routeCode}|${bound}|${serviceType}`] = route;
  }

  routeStopRows.forEach((row, sourceIndex) => {
    const routeCode = String(row?.route || '').trim();
    const bound = String(row?.bound || '').trim();
    const serviceType = String(row?.service_type || '').trim();
    const stopId = String(row?.stop || '').trim();
    const sequence = Number(row?.seq);
    if (!routeCode || !bound || !serviceType || !stopId || !Number.isFinite(sequence)) return;

    const routeKey = `${routeCode}|${bound}|${serviceType}`;
    if (!routeStopGroups.has(routeKey)) routeStopGroups.set(routeKey, []);
    routeStopGroups.get(routeKey).push({ stopId, sequence, sourceIndex });

    if (!stopRoutes[stopId]) stopRoutes[stopId] = [];
    stopRoutes[stopId].push({
      route: routeCode,
      bound,
      service_type: serviceType,
      seq: sequence,
    });
  });

  const routeStops = {};
  for (const [routeKey, rows] of routeStopGroups) {
    routeStops[routeKey] = rows
      .sort((left, right) => left.sequence - right.sequence || left.sourceIndex - right.sourceIndex)
      .map((row) => row.stopId);
  }

  return { stopMap, routeMap, routeStops, stopRoutes };
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
