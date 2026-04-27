const STATIC_CACHE_PREFIX = 'kmb_operator_static_cache_v1';
const STATIC_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const ETA_TTL_MS = 20 * 1000;

const memoryCache = new Map();

function getMemoryCache(key) {
  const row = memoryCache.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return row.value;
}

function setMemoryCache(key, value, ttlMs) {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  return value;
}

function readLocalCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const row = JSON.parse(raw);
    if (!row?.expiresAt || row.expiresAt <= Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return row.value;
  } catch {
    return null;
  }
}

function writeLocalCache(key, value, ttlMs) {
  try {
    localStorage.setItem(key, JSON.stringify({
      value,
      expiresAt: Date.now() + ttlMs,
    }));
  } catch {
    // Ignore storage pressure so the adapters stay usable.
  }
  return value;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.json();
}

export function createStaticDatasetLoader(operator, url) {
  const memoryKey = `${operator}:${url}`;
  const localKey = `${STATIC_CACHE_PREFIX}:${operator}`;

  return async function loadDataset() {
    const memoryHit = getMemoryCache(memoryKey);
    if (memoryHit) return memoryHit;

    const localHit = readLocalCache(localKey);
    if (localHit) {
      setMemoryCache(memoryKey, localHit, STATIC_CACHE_TTL_MS);
      return localHit;
    }

    const payload = await fetchJson(url);
    setMemoryCache(memoryKey, payload, STATIC_CACHE_TTL_MS);
    writeLocalCache(localKey, payload, STATIC_CACHE_TTL_MS);
    return payload;
  };
}

export function createEtaLoader(keyPrefix, buildUrl) {
  return async function loadEta(params) {
    const url = buildUrl(params);
    const memoryKey = `${keyPrefix}:${url}`;
    const hit = getMemoryCache(memoryKey);
    if (hit) return hit;
    const payload = await fetchJson(url);
    setMemoryCache(memoryKey, payload, ETA_TTL_MS);
    return payload;
  };
}

export function buildGeoResolver(operator) {
  return async function resolveGridStopLocation(stop) {
    if (!stop?.grid_easting || !stop?.grid_northing) return stop;
    if (stop.lat != null && stop.lng != null) return stop;

    const url = `/api/operators/geo/hk80-to-wgs84?e=${encodeURIComponent(stop.grid_easting)}&n=${encodeURIComponent(stop.grid_northing)}`;
    const payload = await fetchJson(url);
    return {
      ...stop,
      lat: payload.lat ?? stop.lat ?? null,
      lng: payload.lng ?? stop.lng ?? null,
    };
  };
}

export function buildOperatorSummary(dataset) {
  return {
    operator: dataset?.operator || null,
    routeCount: Array.isArray(dataset?.routes) ? dataset.routes.length : 0,
    routeStopCount: Array.isArray(dataset?.route_stops) ? dataset.route_stops.length : 0,
    stopCount: Array.isArray(dataset?.stops) ? dataset.stops.length : 0,
    fareCount: Array.isArray(dataset?.fares) ? dataset.fares.length : 0,
    limitations: dataset?.limitations || [],
    sources: dataset?.sources || {},
  };
}
