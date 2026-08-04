/**
 * KMB Route Engine - bidirectional search with a spatial grid
 *
 * Algorithm:
 *  1. Build a spatial grid of all stops (O(1) neighbor lookups)
 *  2. Build ORIGIN SET from routes departing within 600m of the origin
 *  3. Build DEST SET from routes arriving within 600m of the destination
 *  4. Find direct routes from the intersection of those sets
 *  5. For one transfer, scan forward stops on each origin route;
 *                        check the spatial grid for dest-set routes nearby
 *  6. For two transfers, search a genuine middle route between both sets
 *  7. Rank and deduplicate by time, transfers, and walking
 */

'use strict';

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// CONSTANTS
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
const WALK_RADIUS_KM = 0.6;   // walk from origin/dest to bus stop
const TRANSFER_WALK_KM = 0.6;   // walk between transfer stops
const MAX_FINAL = 30;
const MAX_NETWORK_CANDIDATES = 120;
const RIDE_MIN_PER_STOP = 1.5;  // minutes per bus stop
const BOARDING_BUFFER_MIN = 1; // small safety buffer before boarding each leg
const GRID_DEG = 0.005; // spatial grid cell, approximately 500m
const ETA_ACTIVE_WINDOW_MIN = 120; // ETA must be within this window to be considered active
const ETA_CACHE_TTL_MS = 30 * 1000;
const RIDE_TIME_CACHE_BUCKET_MS = 30 * 60 * 1000;
const GCP_CACHE = new Map(); // in-memory promise cache
const GCP_CACHE_STORAGE_KEY = 'kmb_gcp_route_cache_v1';
const GCP_CACHE_MAX_ENTRIES = 400;
const GCP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const KMB_RIDE_TIME_REFERENCE_STORAGE_KEY = 'kmb_ride_time_reference_v1';
const KMB_RIDE_TIME_REFERENCE_MAX_ENTRIES = 800;
const KMB_RIDE_TIME_REFERENCE_TTL_MS = 24 * 60 * 60 * 1000;
const GCP_DRIVING_ROUTE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KMB_OPERATION_SCHEDULE_URL = '/operator-data/kmb_operation_time_slots.runtime.json?v=3';
const KMB_ROUTE_STOP_SLOT_TOLERANCE_MIN = 20;
const KMB_ROUTE_SLOT_TOLERANCE_MIN = 75;
const KMB_HIGH_CONFIDENCE_MIN_SAMPLES = 30;
const KMB_HIGH_CONFIDENCE_MIN_SAMPLE_DAYS = 7;
const EARLY_HISTORICAL_BOUNDARY_GUARD_MIN = 30;
const MAX_TRANSFER_VARIANTS_PER_ROUTE_PAIR = 8;
const MAX_GOOGLE_RIDE_REFINEMENT_CANDIDATES = 8;
const GOOGLE_WALKING_CONCURRENCY = 8;
const MAX_ROUTE_ACCESS_STOPS = 6;
const MAX_TWO_TRANSFER_CANDIDATES = 40;
const SIMPLE_CANDIDATES_BEFORE_SKIPPING_TWO_TRANSFER = 12;
const PREFERRED_TRANSFER_WALK_KM = 0.25;
const STRICT_STOP_LEVEL_ROUTES = new Set(['110']);
const SPATIAL_GRID_CACHE = new WeakMap();
const REQUEST_STATS = {
    gcpNetworkRequests: 0,
    gcpCacheHits: 0,
    etaNetworkRequests: 0,
    etaCacheHits: 0,
    historicalNetworkRequests: 0,
    historicalCacheHits: 0,
    duplicateRequestsPrevented: 0,
    rideTimeReferenceHits: 0,
    rideTimeReferenceWrites: 0,
    payloadBytes: 0,
};
let GCP_PERSISTED_CACHE = null;
let KMB_RIDE_TIME_REFERENCE_CACHE = null;
let KMB_OPERATION_SCHEDULE_PROMISE = null;
let LAST_PLANNING_DEBUG_SUMMARY = null;

function requestStatsSnapshot() {
    return { ...REQUEST_STATS };
}

function requestStatsDelta(before) {
    return Object.fromEntries(
        Object.entries(REQUEST_STATS).map(([key, value]) => [key, value - (before[key] || 0)])
    );
}

function recordPayloadBytes(response) {
    const bytes = Number(response?.headers?.get?.('content-length'));
    if (Number.isFinite(bytes) && bytes > 0) REQUEST_STATS.payloadBytes += bytes;
}

function getApiBaseUrl() {
    const base = (window.__KMB_API_BASE_URL__ || '').trim();
    return base.replace(/\/+$/, '');
}

function toApiUrl(path) {
    if (typeof path !== 'string') return path;
    if (!path.startsWith('/api/')) return path;
    const base = getApiBaseUrl();
    if (!base) return path;
    if (base.endsWith('/api')) {
        return `${base}${path.slice('/api'.length)}`;
    }
    return `${base}${path}`;
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// MATH
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// SPATIAL GRID - build once per stop-map object and reuse for all lookups
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
function buildSpatialGrid(stopMap) {
    if (stopMap && typeof stopMap === 'object' && SPATIAL_GRID_CACHE.has(stopMap)) {
        return SPATIAL_GRID_CACHE.get(stopMap);
    }
    const grid = new Map();
    for (const [id, s] of Object.entries(stopMap)) {
        const lat = Number(s?.lat);
        const lng = Number(s?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const gx = Math.floor(lat / GRID_DEG);
        const gy = Math.floor(lng / GRID_DEG);
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ id, ...s, lat, lng });
    }
    if (stopMap && typeof stopMap === 'object') SPATIAL_GRID_CACHE.set(stopMap, grid);
    return grid;
}

function nearbyFromGrid(grid, lat, lng, radiusKm) {
    if (!(grid instanceof Map) || ![lat, lng, radiusKm].every(Number.isFinite)) return [];
    const cells = Math.ceil(radiusKm / (GRID_DEG * 111)) + 1;
    const gx = Math.floor(lat / GRID_DEG);
    const gy = Math.floor(lng / GRID_DEG);
    const out = [];
    for (let dx = -cells; dx <= cells; dx++) {
        for (let dy = -cells; dy <= cells; dy++) {
            for (const s of (grid.get(`${gx + dx},${gy + dy}`) || [])) {
                const d = haversine(lat, lng, s.lat, s.lng);
                if (d <= radiusKm) out.push({ ...s, distance: d });
            }
        }
    }
    return out.sort((a, b) => a.distance - b.distance);
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// GCP ROUTE FETCH (with caching)
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
function decodePolyline(encoded) {
    const points = [];
    let index = 0, lat = 0, lng = 0;
    while (index < encoded.length) {
        let b, shift = 0, result = 0;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += (result & 1) ? ~(result >> 1) : (result >> 1);
        shift = 0; result = 0;
        do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += (result & 1) ? ~(result >> 1) : (result >> 1);
        points.push([lng / 1e5, lat / 1e5]);
    }
    return points;
}

function getFallbackRoute(lat1, lng1, lat2, lng2, mode) {
    const d = haversine(lat1, lng1, lat2, lng2);
    return {
        distance: d * 1000,
        duration: Math.ceil(d / (mode === 'walking' ? 4 : 30) * 60),
        geometry: [[lng1, lat1], [lng2, lat2]],
        source: 'straight_line_fallback',
    };
}

function getWaypointSignature(intermediateStops) {
    if (!intermediateStops || intermediateStops.length === 0) return 'none';
    const sampled = intermediateStops.length > 23
        ? Array.from({ length: 23 }, (_, i) => intermediateStops[Math.floor(i * intermediateStops.length / 23)])
        : intermediateStops;
    return sampled.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|');
}

function loadPersistedGcpCache() {
    if (GCP_PERSISTED_CACHE) return GCP_PERSISTED_CACHE;
    GCP_PERSISTED_CACHE = new Map();
    try {
        const raw = localStorage.getItem(GCP_CACHE_STORAGE_KEY);
        if (!raw) return GCP_PERSISTED_CACHE;
        const rows = JSON.parse(raw);
        const now = Date.now();
        for (const row of rows) {
            if (!row?.key || !row?.value || !row?.expiresAt) continue;
            if (row.expiresAt <= now) continue;
            GCP_PERSISTED_CACHE.set(row.key, row);
        }
    } catch {
        GCP_PERSISTED_CACHE = new Map();
    }
    return GCP_PERSISTED_CACHE;
}

function savePersistedGcpCache(cache) {
    try {
        const now = Date.now();
        const rows = Array.from(cache.entries())
            .map(([key, row]) => ({ key, ...row }))
            .filter((row) => row.expiresAt > now)
            .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
            .slice(0, GCP_CACHE_MAX_ENTRIES);
        localStorage.setItem(GCP_CACHE_STORAGE_KEY, JSON.stringify(rows));
    } catch {
        // Ignore storage/quota errors to keep routing functional.
    }
}

function getGcpCachedValue(cacheKey) {
    const memoryHit = GCP_CACHE.get(cacheKey);
    if (memoryHit) {
        if (memoryHit.expiresAt > Date.now()) {
            REQUEST_STATS.gcpCacheHits += 1;
            REQUEST_STATS.duplicateRequestsPrevented += 1;
            return memoryHit.promise;
        }
        GCP_CACHE.delete(cacheKey);
    }
    const cache = loadPersistedGcpCache();
    const hit = cache.get(cacheKey);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        cache.delete(cacheKey);
        savePersistedGcpCache(cache);
        return null;
    }
    const resolved = Promise.resolve(hit.value);
    GCP_CACHE.set(cacheKey, { promise: resolved, expiresAt: hit.expiresAt });
    REQUEST_STATS.gcpCacheHits += 1;
    REQUEST_STATS.duplicateRequestsPrevented += 1;
    return resolved;
}

function setGcpCachedValue(cacheKey, value, ttlMs = GCP_CACHE_TTL_MS) {
    const expiresAt = Date.now() + ttlMs;
    GCP_CACHE.set(cacheKey, { promise: Promise.resolve(value), expiresAt });
    const cache = loadPersistedGcpCache();
    cache.set(cacheKey, {
        value,
        savedAt: Date.now(),
        expiresAt,
    });
    savePersistedGcpCache(cache);
}

function getGcpRouteCacheTtl(mode) {
    return mode === 'driving' ? GCP_DRIVING_ROUTE_CACHE_TTL_MS : GCP_CACHE_TTL_MS;
}

function loadKmbRideTimeReferenceCache() {
    if (KMB_RIDE_TIME_REFERENCE_CACHE) return KMB_RIDE_TIME_REFERENCE_CACHE;
    KMB_RIDE_TIME_REFERENCE_CACHE = new Map();
    try {
        const raw = localStorage.getItem(KMB_RIDE_TIME_REFERENCE_STORAGE_KEY);
        if (!raw) return KMB_RIDE_TIME_REFERENCE_CACHE;
        const rows = JSON.parse(raw);
        const now = Date.now();
        for (const row of rows) {
            if (!row?.key || !Number.isFinite(Number(row.duration)) || !row.expiresAt) continue;
            if (Number(row.expiresAt) <= now) continue;
            KMB_RIDE_TIME_REFERENCE_CACHE.set(row.key, row);
        }
    } catch {
        KMB_RIDE_TIME_REFERENCE_CACHE = new Map();
    }
    return KMB_RIDE_TIME_REFERENCE_CACHE;
}

function saveKmbRideTimeReferenceCache(cache) {
    try {
        const now = Date.now();
        const rows = Array.from(cache.entries())
            .map(([key, row]) => ({ key, ...row }))
            .filter((row) => Number(row.expiresAt) > now)
            .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0))
            .slice(0, KMB_RIDE_TIME_REFERENCE_MAX_ENTRIES);
        localStorage.setItem(KMB_RIDE_TIME_REFERENCE_STORAGE_KEY, JSON.stringify(rows));
    } catch {
        // Local reference storage is an optimization; routing remains functional without it.
    }
}

function buildKmbRideTimeReferenceKey(segment, timeMode, referenceTime) {
    const routeCode = String(segment?.route || '').trim().toUpperCase();
    const bound = String(segment?.bound || '').trim().toUpperCase();
    const serviceType = String(segment?.service_type || '1').trim();
    const fromStop = String(segment?.fromStop || '').trim();
    const toStop = String(segment?.toStop || '').trim();
    if (!routeCode || !fromStop || !toStop) return null;
    const routeKey = String(segment?.routeKey || `${routeCode}|${bound}|${serviceType}`).trim();
    const selectedStopSequence = Array.isArray(segment?.stops) && segment.stops.length > 0
        ? segment.stops.map((stop) => String(stop).trim()).join(',')
        : `${fromStop},${toStop}`;
    return [
        'ride-time-v1',
        routeKey,
        selectedStopSequence,
        timeMode || 'now',
        bucketTimestamp(referenceTime),
    ].join('|');
}

function getKmbRideTimeReference(key) {
    if (!key) return null;
    const cache = loadKmbRideTimeReferenceCache();
    const row = cache.get(key);
    if (!row) return null;
    if (Number(row.expiresAt) <= Date.now()) {
        cache.delete(key);
        saveKmbRideTimeReferenceCache(cache);
        return null;
    }
    REQUEST_STATS.rideTimeReferenceHits += 1;
    REQUEST_STATS.duplicateRequestsPrevented += 1;
    return {
        duration: Math.max(1, Math.round(Number(row.duration))),
        source: 'google_transit_bus_duration',
        reference: true,
    };
}

function setKmbRideTimeReference(key, duration) {
    if (!key || !Number.isFinite(Number(duration)) || Number(duration) <= 0) return;
    const cache = loadKmbRideTimeReferenceCache();
    cache.set(key, {
        duration: Math.max(1, Math.round(Number(duration))),
        savedAt: Date.now(),
        expiresAt: Date.now() + KMB_RIDE_TIME_REFERENCE_TTL_MS,
    });
    saveKmbRideTimeReferenceCache(cache);
    REQUEST_STATS.rideTimeReferenceWrites += 1;
}

async function fetchGCPRoute(lat1, lng1, lat2, lng2, mode = 'walking', intermediateStops = []) {
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) {
        throw new Error('Cannot request route geometry with invalid coordinates.');
    }
    const wpSig = getWaypointSignature(intermediateStops);
    const cacheKey = `route-v2|${mode}|${lat1.toFixed(4)},${lng1.toFixed(4)}->${lat2.toFixed(4)},${lng2.toFixed(4)}|${wpSig}`;
    const cached = getGcpCachedValue(cacheKey);
    if (cached) return cached;

    const promise = (async () => {
        REQUEST_STATS.gcpNetworkRequests += 1;
        try {
            let wpStr = '';
            if (intermediateStops.length > 0) {
                let s = intermediateStops.length > 23
                    ? Array.from({ length: 23 }, (_, i) => intermediateStops[Math.floor(i * intermediateStops.length / 23)])
                    : intermediateStops;
                wpStr = '&waypoints=' + s.map(p => `${p.lat},${p.lng}`).join('%7C');
            }
            const url = toApiUrl(`/api/google/directions/json?origin=${lat1},${lng1}&destination=${lat2},${lng2}&mode=${mode}${wpStr}`);
            const response = await fetch(url);
            recordPayloadBytes(response);
            const data = await response.json();
            if (data.status === 'OK' && data.routes.length > 0) {
                const r = data.routes[0];
                const out = {
                    distance: r.legs.reduce((s, l) => s + l.distance.value, 0),
                    duration: Math.ceil(r.legs.reduce((s, l) => s + l.duration.value, 0) / 60),
                    geometry: decodePolyline(r.overview_polyline.points),
                    source: 'google_directions',
                };
                setGcpCachedValue(cacheKey, out, getGcpRouteCacheTtl(mode));
                return out;
            }
            console.warn(`GCP ${mode}:`, data.status);
        } catch (e) {
            console.warn(`GCP ${mode} error:`, e);
        }
        const fallback = getFallbackRoute(lat1, lng1, lat2, lng2, mode);
        setGcpCachedValue(cacheKey, fallback, 10 * 60 * 1000);
        return fallback;
    })();

    GCP_CACHE.set(cacheKey, {
        promise,
        expiresAt: Date.now() + getGcpRouteCacheTtl(mode),
    });
    return promise;
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// ETA FETCH (per-search cache)
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
const ETA_CACHE = new Map();

async function fetchETA(stopId, route, serviceType) {
    const key = `${stopId}|${route}|${serviceType}`;
    const cached = ETA_CACHE.get(key);
    if (cached) {
        if (cached.expiresAt > Date.now()) {
            REQUEST_STATS.etaCacheHits += 1;
            REQUEST_STATS.duplicateRequestsPrevented += 1;
            return cached.promise;
        }
        ETA_CACHE.delete(key);
    }
    const p = (async () => {
        const url = `https://data.etabus.gov.hk/v1/transport/kmb/eta/${stopId}/${route}/${serviceType}`;
        REQUEST_STATS.etaNetworkRequests += 1;
        try {
            const response = await fetch(url);
            recordPayloadBytes(response);
            const data = await response.json();
            const items = data?.data || [];
            return items;
        } catch {
            return [];
        }
    })();
    ETA_CACHE.set(key, { promise: p, expiresAt: Date.now() + ETA_CACHE_TTL_MS });
    return p;
}

function clearETACache() { ETA_CACHE.clear(); }
function getActiveEtas(etaList, now = new Date(), maxMinutes = ETA_ACTIVE_WINDOW_MIN) {
    const upper = new Date(now.getTime() + maxMinutes * 60000);
    return (etaList || []).filter(e => {
        if (!e?.eta) return false;
        const etaTime = new Date(e.eta);
        return etaTime > now && etaTime <= upper;
    });
}

function parseFrequencyMinutes(value, fallback = 15) {
    const freq = parseFloat(value);
    return Number.isFinite(freq) && freq > 0 ? freq : fallback;
}

function buildPlannedDateTime(dateValue, timeValue, fallback = new Date()) {
    if (!dateValue || !timeValue) return fallback;
    const planned = new Date(`${dateValue}T${timeValue}:00`);
    return Number.isNaN(planned.getTime()) ? fallback : planned;
}

function bucketTimestamp(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'none';
    return String(Math.floor(date.getTime() / RIDE_TIME_CACHE_BUCKET_MS));
}

async function loadKmbOperationSchedule() {
    if (KMB_OPERATION_SCHEDULE_PROMISE) {
        REQUEST_STATS.historicalCacheHits += 1;
        REQUEST_STATS.duplicateRequestsPrevented += 1;
        return KMB_OPERATION_SCHEDULE_PROMISE;
    }
    KMB_OPERATION_SCHEDULE_PROMISE = (async () => {
        try {
            REQUEST_STATS.historicalNetworkRequests += 1;
            const response = await fetch(KMB_OPERATION_SCHEDULE_URL);
            recordPayloadBytes(response);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        } catch (error) {
            console.warn('KMB historical operation schedule unavailable:', error);
            return null;
        }
    })();
    return KMB_OPERATION_SCHEDULE_PROMISE;
}

function timeStringToMinutes(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return hours * 60 + minutes;
}

function formatMinutesAsTime(minutes) {
    if (!Number.isFinite(minutes)) return null;
    const normalized = Math.max(0, Math.min(1439, Math.round(minutes)));
    return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function dateToMinutes(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.getHours() * 60 + date.getMinutes();
}

function getPlannedDayClass(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'weekday';
    const dateKey = [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
    ].join('-');
    const hkGeneralHolidays2026 = new Set([
        '2026-01-01',
        '2026-02-17',
        '2026-02-18',
        '2026-02-19',
        '2026-04-03',
        '2026-04-04',
        '2026-04-06',
        '2026-04-07',
        '2026-05-01',
        '2026-05-25',
        '2026-06-19',
        '2026-07-01',
        '2026-09-26',
        '2026-10-01',
        '2026-10-19',
        '2026-12-25',
        '2026-12-26',
    ]);
    if (hkGeneralHolidays2026.has(dateKey)) return 'sunday_public_holiday';
    if (date.getDay() === 6) return 'saturday';
    if (date.getDay() === 0) return 'sunday_public_holiday';
    return 'weekday';
}

function isMinuteWithinPeriod(minute, startMinute, endMinute) {
    if (minute == null || startMinute == null || endMinute == null) return false;
    if (startMinute <= endMinute) return minute >= startMinute && minute <= endMinute;
    return minute >= startMinute || minute <= endMinute;
}

function circularMinuteDelta(a, b) {
    const diff = Math.abs(a - b);
    return Math.min(diff, 1440 - diff);
}

function nearestSlotDistance(minute, slots = []) {
    let best = null;
    for (const slot of slots) {
        const slotMinute = timeStringToMinutes(slot);
        if (slotMinute == null) continue;
        const delta = circularMinuteDelta(minute, slotMinute);
        if (best == null || delta < best.deltaMin) best = { slot, deltaMin: delta };
    }
    return best;
}

function nearestEncodedSlotDistance(minute, maskHex, slotMinutes = 15) {
    if (!Number.isFinite(minute) || !maskHex) return null;
    let mask;
    try {
        mask = BigInt(`0x${maskHex}`);
    } catch {
        return null;
    }
    const slotCount = Math.ceil(1440 / slotMinutes);
    let best = null;
    for (let index = 0; index < slotCount; index++) {
        if ((mask & (1n << BigInt(index))) === 0n) continue;
        const slotMinute = index * slotMinutes;
        const delta = circularMinuteDelta(minute, slotMinute);
        if (best == null || delta < best.deltaMin) {
            best = { slot: formatMinutesAsTime(slotMinute), deltaMin: delta };
        }
    }
    return best;
}

function getObservedSlotMinutes(period) {
    if (!period) return [];
    const minutes = new Set();
    for (const slot of period.a || []) {
        const value = timeStringToMinutes(slot);
        if (Number.isFinite(value)) minutes.add(value);
    }
    if (period.m) {
        let mask;
        try {
            mask = BigInt(`0x${period.m}`);
        } catch {
            mask = null;
        }
        if (mask != null) {
            const slotMinutes = Number(period.sm) || 15;
            const slotCount = Math.ceil(1440 / slotMinutes);
            for (let index = 0; index < slotCount; index++) {
                if ((mask & (1n << BigInt(index))) !== 0n) {
                    minutes.add(index * slotMinutes);
                }
            }
        }
    }
    return [...minutes].sort((a, b) => a - b);
}

function findObservedBoardTime(
    period,
    referenceTime,
    direction = 'next',
    maxGapMinutes = KMB_ROUTE_STOP_SLOT_TOLERANCE_MIN
) {
    if (!(referenceTime instanceof Date) || Number.isNaN(referenceTime.getTime())) return null;
    const requestedMinute = dateToMinutes(referenceTime);
    const slots = getObservedSlotMinutes(period);
    if (!Number.isFinite(requestedMinute) || slots.length === 0) return null;
    const slotMinute = direction === 'previous'
        ? [...slots].reverse().find((minute) => minute <= requestedMinute)
        : slots.find((minute) => minute >= requestedMinute);
    if (!Number.isFinite(slotMinute)) return null;
    if (Math.abs(slotMinute - requestedMinute) > maxGapMinutes) return null;
    const selected = new Date(referenceTime);
    selected.setHours(Math.floor(slotMinute / 60), slotMinute % 60, 0, 0);
    return selected;
}

function validateSchedulePeriod(period, plannedDate, toleranceMin, requireObservedSlots = false) {
    if (!period) return { valid: false, reason: 'missing_period' };
    const minute = dateToMinutes(plannedDate);
    const startMinute = timeStringToMinutes(period.s);
    const endMinute = timeStringToMinutes(period.e);
    const startTime = formatMinutesAsTime(startMinute) || period.s;
    const endTime = formatMinutesAsTime(endMinute) || period.e;
    const nearest = nearestSlotDistance(minute, period.a || []) ||
        nearestEncodedSlotDistance(minute, period.m, period.sm || 15);
    const observedSlotMatched = Boolean(nearest && nearest.deltaMin <= toleranceMin);
    const withinPercentileWindow = isMinuteWithinPeriod(minute, startMinute, endMinute);
    // The compact window is based on the 5th/95th percentile, while its slot mask
    // retains every observed service slot. A matched slot just outside that
    // percentile window is positive evidence and must not be discarded.
    if (!withinPercentileWindow && !(requireObservedSlots && observedSlotMatched)) {
        return {
            valid: false,
            reason: 'outside_operation_window',
            startTime,
            endTime,
        };
    }
    if (!nearest && requireObservedSlots) {
        return {
            valid: false,
            reason: 'observed_slots_missing',
            startTime,
            endTime,
        };
    }
    if (nearest && nearest.deltaMin > toleranceMin && requireObservedSlots) {
        return {
            valid: false,
            reason: 'outside_observed_slots',
            startTime,
            endTime,
            nearestSlot: nearest.slot,
            nearestSlotDeltaMin: nearest.deltaMin,
        };
    }
    return {
        valid: true,
        reason: withinPercentileWindow
            ? 'matched_historical_operation'
            : 'matched_observed_slot_outside_percentile_window',
        startTime,
        endTime,
        nearestSlot: nearest?.slot || null,
        nearestSlotDeltaMin: nearest?.deltaMin ?? null,
        outsidePercentileWindow: !withinPercentileWindow,
        sampleCount: period.n,
        sampleDays: period.d,
    };
}

function getScheduleProfile(schedule, collectionName, key, dayClass) {
    if (!schedule || !key || !dayClass) return { profileExists: false, period: null };

    const legacyCollection = collectionName === 'route_stops' ? schedule.route_stops : schedule.routes;
    if (legacyCollection && Object.prototype.hasOwnProperty.call(legacyCollection, key)) {
        return {
            profileExists: true,
            period: legacyCollection[key]?.[dayClass] || null,
        };
    }

    const runtimeCollection = collectionName === 'route_stops' ? schedule.rs : schedule.r;
    if (!runtimeCollection || !Object.prototype.hasOwnProperty.call(runtimeCollection, key)) {
        return { profileExists: false, period: null };
    }
    const dayClasses = Array.isArray(schedule.d)
        ? schedule.d
        : (Array.isArray(schedule.summary?.day_classes) ? schedule.summary.day_classes : []);
    const dayIndex = dayClasses.indexOf(dayClass);
    const row = dayIndex >= 0 ? runtimeCollection?.[key]?.[dayIndex] : null;
    if (!Array.isArray(row)) return { profileExists: true, period: null };

    const includeDays = collectionName === 'route_stops';
    const maskIndex = includeDays ? 4 : 3;
    return {
        profileExists: true,
        period: {
            s: row[0],
            e: row[1],
            n: row[2],
            d: includeDays ? row[3] : null,
            m: typeof row[maskIndex] === 'string' ? row[maskIndex] : null,
            sm: Number(schedule.sm) || 15,
        },
    };
}

function getPlannedSegmentSchedulePeriod(segment, schedule, referenceTime, options = {}) {
    if (!schedule || !segment || !(referenceTime instanceof Date)) return null;
    const dayClass = getPlannedDayClass(referenceTime);
    const routeKey = [segment.route, segment.bound, segment.service_type]
        .map((part) => String(part || '').trim())
        .join('|');
    const station = getScheduleProfile(
        schedule,
        'route_stops',
        `${routeKey}|${String(segment.fromStop || '').trim()}`,
        dayClass
    );
    if (station.period) return { period: station.period, source: 'station_observed_slot' };

    const canUseRouteFallback = options.allowSparseDataFallback &&
        !station.profileExists &&
        segment.routeStopRecordExists === true &&
        !STRICT_STOP_LEVEL_ROUTES.has(String(segment.route || '').toUpperCase()) &&
        segment.isLoopOrAmbiguousRoute !== true;
    if (!canUseRouteFallback) return null;
    const route = getScheduleProfile(schedule, 'routes', routeKey, dayClass);
    return route.period ? { period: route.period, source: 'route_observed_slot' } : null;
}

function getHistoricalConfidence(period, nearestObservedSlot) {
    const sampleCount = Number(period?.n);
    const sampleDays = Number(period?.d);
    const sufficientSamples = Number.isFinite(sampleCount) && sampleCount >= KMB_HIGH_CONFIDENCE_MIN_SAMPLES;
    const sufficientDays = Number.isFinite(sampleDays) && sampleDays >= KMB_HIGH_CONFIDENCE_MIN_SAMPLE_DAYS;
    const observedNearRequestedTime = nearestObservedSlot &&
        nearestObservedSlot.deltaMin <= KMB_ROUTE_STOP_SLOT_TOLERANCE_MIN;
    return sufficientSamples && sufficientDays && observedNearRequestedTime ? 'high' : 'medium';
}

function buildHistoricalResult(base, overrides = {}) {
    const result = { ...base, ...overrides };
    result.debug = {
        route: result.route,
        bound: result.bound,
        serviceType: result.serviceType,
        boardingStopId: result.boardingStopId,
        boardingStopName: result.boardingStopName,
        stopSequence: result.stopSequence,
        requestedDateTime: result.requestedDateTime,
        validationDateTime: result.validationDateTime,
        dayClass: result.dayClass,
        requestedMinute: result.requestedMinute,
        stationLevelKey: result.stationLevelKey,
        routeLevelKey: result.routeLevelKey,
        routeStopRecordExists: result.routeStopRecordExists,
        stationProfileExists: result.stationProfileExists,
        stationWindow: result.stationWindow,
        stationSampleCount: result.stationSampleCount,
        stationSampleDays: result.stationSampleDays,
        routeProfileExists: result.routeProfileExists,
        routeWindow: result.routeWindow,
        fallbackUsed: result.fallbackUsed,
        fallbackBlocked: result.fallbackBlocked,
        validationStatus: result.status,
        confidence: result.confidence,
        rejectionReason: result.valid ? null : result.reason,
    };
    return result;
}

function validateSegmentHistoricalSchedule(segment, boardTime, schedule, options = {}) {
    if (!schedule || !segment || !boardTime) {
        return { valid: false, status: 'schedule_unavailable', reason: 'schedule_unavailable' };
    }
    const boardDate = boardTime instanceof Date ? boardTime : new Date(boardTime);
    if (Number.isNaN(boardDate.getTime())) {
        return { valid: false, status: 'invalid_board_time', reason: 'invalid_board_time' };
    }

    const {
        allowSparseDataFallback = false,
        requestedDateTime = boardDate,
        requireObservedSlotMatch = false,
        strictStopLevelRoutes = STRICT_STOP_LEVEL_ROUTES,
    } = options;
    const dayClass = getPlannedDayClass(boardDate);
    const routeKey = [
        segment.route,
        segment.bound,
        segment.service_type,
    ].map((part) => String(part || '').trim()).join('|');
    const routeStopKey = `${routeKey}|${String(segment.fromStop || '').trim()}`;
    const stationProfile = getScheduleProfile(schedule, 'route_stops', routeStopKey, dayClass);
    const routeProfile = getScheduleProfile(schedule, 'routes', routeKey, dayClass);
    const routeStopPeriod = stationProfile.period;
    const routePeriod = routeProfile.period;
    const requestedDate = requestedDateTime instanceof Date
        ? requestedDateTime
        : new Date(requestedDateTime);
    const stationStart = formatMinutesAsTime(timeStringToMinutes(routeStopPeriod?.s)) || routeStopPeriod?.s || null;
    const stationEnd = formatMinutesAsTime(timeStringToMinutes(routeStopPeriod?.e)) || routeStopPeriod?.e || null;
    const routeStart = formatMinutesAsTime(timeStringToMinutes(routePeriod?.s)) || routePeriod?.s || null;
    const routeEnd = formatMinutesAsTime(timeStringToMinutes(routePeriod?.e)) || routePeriod?.e || null;
    const base = {
        valid: false,
        route: String(segment.route || '').trim(),
        bound: String(segment.bound || '').trim(),
        serviceType: String(segment.service_type || '').trim(),
        boardingStopId: String(segment.fromStop || '').trim(),
        boardingStopName: segment.boardingStopName || null,
        stopSequence: Number.isFinite(segment.boardingStopSequence) ? segment.boardingStopSequence : null,
        requestedDateTime: Number.isNaN(requestedDate.getTime()) ? null : requestedDate.toISOString(),
        validationDateTime: boardDate.toISOString(),
        dayClass,
        requestedMinute: dateToMinutes(boardDate),
        stationLevelKey: routeStopKey,
        routeLevelKey: routeKey,
        routeStopRecordExists: segment.routeStopRecordExists === true,
        stationProfileExists: stationProfile.profileExists,
        stationWindow: stationStart && stationEnd ? `${stationStart}-${stationEnd}` : null,
        stationSampleCount: Number.isFinite(Number(routeStopPeriod?.n)) ? Number(routeStopPeriod.n) : null,
        stationSampleDays: Number.isFinite(Number(routeStopPeriod?.d)) ? Number(routeStopPeriod.d) : null,
        routeProfileExists: routeProfile.profileExists,
        routeWindow: routeStart && routeEnd ? `${routeStart}-${routeEnd}` : null,
        fallbackUsed: false,
        fallbackBlocked: false,
        confidence: 'unsupported',
    };

    if (stationProfile.profileExists) {
        if (!routeStopPeriod) {
            return buildHistoricalResult(base, {
                status: 'not_supported_by_historical_data',
                reason: 'station_profile_missing_for_day_class',
                fallbackBlocked: true,
            });
        }
        const stationAssessment = validateSchedulePeriod(
            routeStopPeriod,
            boardDate,
            KMB_ROUTE_STOP_SLOT_TOLERANCE_MIN,
            requireObservedSlotMatch
        );
        if (!stationAssessment.valid) {
            return buildHistoricalResult(base, {
                ...stationAssessment,
                status: 'not_operating_station_level',
                confidence: 'unsupported',
                fallbackBlocked: true,
            });
        }
        const nearestObservedSlot = nearestSlotDistance(dateToMinutes(boardDate), routeStopPeriod.a || []) ||
            nearestEncodedSlotDistance(dateToMinutes(boardDate), routeStopPeriod.m, routeStopPeriod.sm || 15);
        return buildHistoricalResult(base, {
            ...stationAssessment,
            valid: true,
            status: 'operating_station_level',
            reason: stationAssessment.outsidePercentileWindow
                ? 'matched_observed_slot_outside_percentile_window'
                : 'operating at boarding stop in historical window',
            confidence: getHistoricalConfidence(routeStopPeriod, nearestObservedSlot),
            observedEtaNearRequestedTime: Boolean(
                nearestObservedSlot && nearestObservedSlot.deltaMin <= KMB_ROUTE_STOP_SLOT_TOLERANCE_MIN
            ),
        });
    }

    if (!base.routeStopRecordExists) {
        return buildHistoricalResult(base, {
            status: 'route_stop_not_found',
            reason: 'exact route-stop record was not found',
            fallbackBlocked: true,
        });
    }

    const routeCode = base.route.toUpperCase();
    if (strictStopLevelRoutes.has(routeCode)) {
        return buildHistoricalResult(base, {
            status: 'fallback_blocked_strict_route',
            reason: 'station-level historical data is required for this strict route',
            fallbackBlocked: true,
        });
    }
    if (segment.isLoopOrAmbiguousRoute === true) {
        return buildHistoricalResult(base, {
            status: 'fallback_blocked_loop_or_ambiguous_route',
            reason: 'route-level fallback is unsafe for a loop, duplicated-stop, or ambiguous route pattern',
            fallbackBlocked: true,
        });
    }
    if (!allowSparseDataFallback) {
        return buildHistoricalResult(base, {
            status: 'station_profile_missing',
            reason: 'station-level historical data is missing and sparse-data fallback was not enabled',
            fallbackBlocked: true,
        });
    }
    if (!routeProfile.profileExists || !routePeriod) {
        return buildHistoricalResult(base, {
            status: 'route_profile_missing',
            reason: 'route-level historical data is missing for the requested day class',
        });
    }

    const routeAssessment = validateSchedulePeriod(
        routePeriod,
        boardDate,
        KMB_ROUTE_SLOT_TOLERANCE_MIN
    );
    if (!routeAssessment.valid) {
        return buildHistoricalResult(base, {
            ...routeAssessment,
            status: 'not_supported_by_historical_data',
            confidence: 'unsupported',
        });
    }
    return buildHistoricalResult(base, {
        ...routeAssessment,
        valid: true,
        status: 'likely_operating_route_level_fallback',
        reason: 'likely operating, but station-level historical data is missing',
        fallbackUsed: true,
        confidence: 'low',
    });
}

function historicalConfidenceRank(confidence) {
    if (confidence === 'high') return 3;
    if (confidence === 'medium') return 2;
    if (confidence === 'low') return 1;
    return 0;
}

function shouldLogHistoricalValidation() {
    try {
        const hostname = String(window?.location?.hostname || '').toLowerCase();
        return hostname === 'localhost' || hostname === '127.0.0.1' ||
            window?.localStorage?.getItem('kmbHistoricalDebug') === '1';
    } catch {
        return false;
    }
}

async function validateRouteHistoricalSchedule(route, options = {}) {
    const schedule = options.schedule || await loadKmbOperationSchedule();
    if (!schedule) {
        route.historicalScheduleStatus = 'schedule_unavailable';
        route.historicalScheduleRejectReason = 'schedule_unavailable';
        route.historicalConfidence = 'unsupported';
        route.historicalConfidenceScore = 0;
        return false;
    }

    let routeConfidenceRank = 3;
    for (const segment of route.segments || []) {
        const result = validateSegmentHistoricalSchedule(segment, segment.boardTime, schedule, {
            ...options,
            requireObservedSlotMatch: options.requireObservedSlotMatch ||
                String(segment.plannedTimingSource || '').includes('observed_slot'),
        });
        segment.historicalSchedule = result;
        if (options.logValidation !== false && shouldLogHistoricalValidation()) {
            console.debug('[KMB historical operation]', result.debug || result);
        }
        if (!result.valid) {
            route.historicalScheduleStatus = 'rejected';
            route.historicalScheduleRejectReason = result.reason;
            route.historicalConfidence = 'unsupported';
            route.historicalConfidenceScore = 0;
            return false;
        }
        routeConfidenceRank = Math.min(routeConfidenceRank, historicalConfidenceRank(result.confidence));
    }
    route.historicalScheduleStatus = 'matched';
    route.historicalConfidence = routeConfidenceRank >= 3
        ? 'high'
        : (routeConfidenceRank === 2 ? 'medium' : 'low');
    route.historicalConfidenceScore = routeConfidenceRank;
    return true;
}

function getSegmentOperator(segment) {
    return String(segment?.routeInfo?.co || 'KMB').toUpperCase();
}

async function fetchSegmentETA(segment) {
    const operator = getSegmentOperator(segment);
    if (!operator.includes('KMB')) return [];
    return fetchETA(segment.fromStop, segment.route, segment.service_type);
}

function getLegApproachMinutes(route, segmentIndex) {
    if (segmentIndex === 0) return route.walkTimeOrigin || 0;
    if (segmentIndex === 1) return route.walkTimeTransfer || 0;
    return route.walkTimeTransfer2 || 0;
}

function getFallbackRideDurationMinutes(segment) {
    const stopCount = segment?.stops?.length || 0;
    const intervalCount = Math.max(1, stopCount - 1);
    const routeDistanceKm = Number(segment?.routeDistanceKm);
    if (Number.isFinite(routeDistanceKm) && routeDistanceKm > 0) {
        // Stop spacing distinguishes express/highway sections from dense urban
        // sections. Distance prevents sparse routes such as 968X from being
        // reduced to only a few minutes merely because they have few stops.
        return Math.max(
            1,
            Math.round(routeDistanceKm * 0.8 + intervalCount * RIDE_MIN_PER_STOP),
        );
    }
    return stopCount * RIDE_MIN_PER_STOP;
}

function getRideDurationMinutes(segment) {
    return segment?.rideDurationMinutes || getFallbackRideDurationMinutes(segment);
}

async function fetchGCPTransitRideDuration(segment, stopMap, options = {}) {
    const fromStop = stopMap?.[segment?.fromStop];
    const toStop = stopMap?.[segment?.toStop];
    const fallbackDuration = getFallbackRideDurationMinutes(segment);

    if (!fromStop?.lat || !fromStop?.lng || !toStop?.lat || !toStop?.lng) {
        return { duration: fallbackDuration, source: 'heuristic_per_stop' };
    }

    const routeCode = String(segment?.route || '').trim().toUpperCase();
    const serviceType = String(segment?.service_type || '1').trim();
    const timeMode = options.timeMode || 'now';
    // Prefer the leg's actual planned boarding/arrival time.  This keeps the
    // reference tied to the traffic period for that particular leg instead of
    // using the journey anchor for every segment.
    const segmentTime = timeMode === 'arrive' ? segment?.arrivalTime : segment?.boardTime;
    const parsedSegmentTime = segmentTime ? new Date(segmentTime) : null;
    const referenceTime = parsedSegmentTime instanceof Date && !Number.isNaN(parsedSegmentTime.getTime())
        ? parsedSegmentTime
        : (timeMode === 'arrive' ? options.arrivalTime : options.departureTime);
    const referenceKey = buildKmbRideTimeReferenceKey(segment, timeMode, referenceTime);
    const storedReference = getKmbRideTimeReference(referenceKey);
    if (storedReference) return storedReference;
    const cacheKey = [
        'transit-ride',
        routeCode || 'unknown',
        serviceType,
        segment?.fromStop || 'unknown',
        segment?.toStop || 'unknown',
        timeMode,
        bucketTimestamp(referenceTime),
    ].join('|');
    const cached = getGcpCachedValue(cacheKey);
    if (cached) {
        return cached.then((payload) => {
            if (payload?.source === 'google_transit_bus_duration') {
                setKmbRideTimeReference(referenceKey, payload.duration);
            }
            return payload;
        });
    }

    const promise = (async () => {
        REQUEST_STATS.gcpNetworkRequests += 1;
        try {
            const query = new URLSearchParams({
                origin: `${fromStop.lat},${fromStop.lng}`,
                destination: `${toStop.lat},${toStop.lng}`,
                mode: 'transit',
                transit_mode: 'bus',
            });
            if (timeMode === 'arrive' && referenceTime instanceof Date && !Number.isNaN(referenceTime.getTime())) {
                query.set('arrival_time', String(Math.floor(referenceTime.getTime() / 1000)));
            } else if (referenceTime instanceof Date && !Number.isNaN(referenceTime.getTime())) {
                query.set('departure_time', String(Math.floor(referenceTime.getTime() / 1000)));
            }

            const response = await fetch(toApiUrl(`/api/google/directions/json?${query.toString()}`));
            recordPayloadBytes(response);
            const data = await response.json();
            if (data?.status === 'OK' && Array.isArray(data.routes) && data.routes.length > 0) {
                const legs = data.routes[0]?.legs || [];
                const transitSteps = legs.flatMap((leg) => leg.steps || []).filter((step) => step?.travel_mode === 'TRANSIT');
                const matchingBusSteps = transitSteps.filter((step) => {
                    const vehicleType = String(step?.transit_details?.line?.vehicle?.type || '').toUpperCase();
                    const shortName = String(step?.transit_details?.line?.short_name || '').trim().toUpperCase();
                    return vehicleType === 'BUS' && (!routeCode || shortName === routeCode);
                });
                if (matchingBusSteps.length > 0) {
                    const duration = Math.max(
                        1,
                        Math.round(
                            matchingBusSteps.reduce((sum, step) => sum + (step?.duration?.value || 0), 0) / 60
                        )
                    );
                    const payload = { duration, source: 'google_transit_bus_duration' };
                    setKmbRideTimeReference(referenceKey, duration);
                    setGcpCachedValue(cacheKey, payload);
                    return payload;
                }
            }
        } catch (error) {
            console.warn('GCP transit ride duration error:', error);
        }

        const payload = { duration: fallbackDuration, source: 'heuristic_per_stop' };
        setGcpCachedValue(cacheKey, payload, 10 * 60 * 1000);
        return payload;
    })();

    GCP_CACHE.set(cacheKey, { promise, expiresAt: Date.now() + GCP_CACHE_TTL_MS });
    return promise;
}

async function enrichGoogleRideDurations(routes, stopMap, options = {}) {
    const tasks = [];
    for (const route of routes || []) {
        for (const segment of route.segments || []) {
            tasks.push(
                fetchGCPTransitRideDuration(segment, stopMap, options).then((result) => {
                    segment.rideDurationMinutes = result.duration;
                    segment.rideDurationSource = result.source;
                })
            );
        }
    }
    await Promise.all(tasks);
}

function getNextValidBusETA(etaList, afterTime, now = new Date()) {
    const lowerBound = afterTime instanceof Date ? afterTime : new Date(afterTime);
    const activeEtas = getActiveEtas(etaList, now);
    return activeEtas.find((eta) => new Date(eta.eta) >= lowerBound) || null;
}

function resetSegmentTiming(segment, defaultFrequency) {
    segment.operator = getSegmentOperator(segment);
    segment.nextEta = null;
    segment.hasActiveEta = false;
    segment.activeEtaCount = 0;
    segment.activeEtas = [];
    segment.catchableEtas = [];
    segment.displayEtas = [];
    segment.busInterval = defaultFrequency;
    segment.readyTime = null;
    segment.boardTime = null;
    segment.arrivalTime = null;
    segment.waitMinutes = null;
    segment.missedEtaCount = 0;
    segment.catchableByEta = false;
    segment.timingFallbackReason = null;
    segment.historicalSchedule = null;
    segment.plannedTimingSource = null;
}

async function applyCurrentLocationApproach(route, currentLocation) {
    const lat = Number(currentLocation?.lat);
    const lng = Number(currentLocation?.lng);
    const stopLat = Number(route?.oLat);
    const stopLng = Number(route?.oLng);
    if (![lat, lng, stopLat, stopLng].every(Number.isFinite)) return false;

    const walkInfo = await fetchGCPRoute(lat, lng, stopLat, stopLng, 'walking');
    route.originLoc = { lat, lng };
    route.walkInfoOrigin = walkInfo;
    route.walkTimeOrigin = walkInfo.duration;
    route.gpsTimingApplied = true;
    route.gpsLocation = { lat, lng };
    route.gpsEvaluatedAt = new Date().toISOString();
    return true;
}

async function applyNowTiming(route, now, options = {}) {
    const { allowNoEta = false, allowTransferScheduleFallback = true } = options;
    let cursor = new Date(now);
    let schedule = null;

    for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        const defaultFrequency = parseFrequencyMinutes(segment.routeInfo?.freq, i === 0 ? 15 : 12);
        const etaList = await fetchSegmentETA(segment);
        const displayEtas = (etaList || [])
            .filter((eta) => eta?.eta && Number.isFinite(new Date(eta.eta).getTime()))
            .sort((a, b) => new Date(a.eta) - new Date(b.eta));
        const readyTime = new Date(
            cursor.getTime() + (getLegApproachMinutes(route, i) + BOARDING_BUFFER_MIN) * 60000
        );
        const activeEtas = getActiveEtas(etaList, now);
        const nextValidEta = activeEtas.find((eta) => new Date(eta.eta) >= readyTime) || null;
        const missedEtaCount = activeEtas.filter(
            (eta) => new Date(eta.eta) < readyTime
        ).length;

        resetSegmentTiming(segment, defaultFrequency);
        segment.readyTime = readyTime.toISOString();
        segment.missedEtaCount = missedEtaCount;
        segment.activeEtas = activeEtas.map((eta) => ({
            ...eta,
            catchable: new Date(eta.eta) >= readyTime,
        }));
        segment.catchableEtas = segment.activeEtas.filter((eta) => eta.catchable);
        segment.displayEtas = displayEtas.map((eta) => ({
            ...eta,
            catchable: new Date(eta.eta) >= readyTime && new Date(eta.eta) > now,
        }));

        if (!nextValidEta) {
            const canUseScheduledTransferFallback = (
                !allowNoEta &&
                allowTransferScheduleFallback &&
                i > 0
            );
            if (!allowNoEta && !canUseScheduledTransferFallback) return false;
            const boardTime = new Date(readyTime.getTime() + defaultFrequency * 60000);
            const arrivalTime = new Date(
                boardTime.getTime() + getRideDurationMinutes(segment) * 60000
            );
            if (canUseScheduledTransferFallback) {
                schedule = schedule || await loadKmbOperationSchedule();
                const historicalResult = validateSegmentHistoricalSchedule(segment, boardTime, schedule);
                segment.historicalSchedule = historicalResult;
                if (!historicalResult.valid) return false;
                segment.timingFallbackReason = 'transfer_eta_unavailable_historical_schedule';
            }
            segment.activeEtaCount = segment.catchableEtas.length;
            segment.boardTime = boardTime.toISOString();
            segment.arrivalTime = arrivalTime.toISOString();
            segment.waitMinutes = defaultFrequency;
            if (i === 0) route.originWaitTime = segment.waitMinutes;
            cursor = arrivalTime;
            continue;
        }

        const boardTime = new Date(nextValidEta.eta);
        const arrivalTime = new Date(
            boardTime.getTime() + getRideDurationMinutes(segment) * 60000
        );
        const validEtaCount = getActiveEtas(etaList, now).filter(
            (eta) => new Date(eta.eta) >= readyTime
        ).length;

        segment.nextEta = nextValidEta.eta;
        segment.hasActiveEta = true;
        segment.catchableByEta = true;
        segment.activeEtaCount = validEtaCount;
        segment.boardTime = boardTime.toISOString();
        segment.arrivalTime = arrivalTime.toISOString();
        segment.waitMinutes = Math.max(
            0,
            Math.round((boardTime.getTime() - readyTime.getTime()) / 60000)
        );

        if (i === 0) route.originWaitTime = segment.waitMinutes;
        cursor = arrivalTime;
    }

    const finalArrival = new Date(cursor.getTime() + (route.walkTimeDest || 0) * 60000);
    route.estimatedTime = Math.round((finalArrival.getTime() - now.getTime()) / 60000);
    route.plannedDepartureTime = now.toISOString();
    route.plannedArrivalTime = finalArrival.toISOString();
    return true;
}

function applyLeaveTiming(route, departureTime, schedule = null, options = {}) {
    let cursor = new Date(departureTime);

    for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        const fallbackWaitMinutes = parseFrequencyMinutes(segment.routeInfo?.freq, i === 0 ? 15 : 12);
        const readyTime = new Date(
            cursor.getTime() + (getLegApproachMinutes(route, i) + BOARDING_BUFFER_MIN) * 60000
        );
        const scheduleProfile = getPlannedSegmentSchedulePeriod(
            segment,
            schedule,
            readyTime,
            options
        );
        const observedBoardTime = scheduleProfile
            ? findObservedBoardTime(scheduleProfile.period, readyTime, 'next')
            : null;
        const boardTime = observedBoardTime ||
            new Date(readyTime.getTime() + fallbackWaitMinutes * 60000);
        const waitMinutes = Math.max(
            0,
            Math.round((boardTime.getTime() - readyTime.getTime()) / 60000)
        );
        const arrivalTime = new Date(
            boardTime.getTime() + getRideDurationMinutes(segment) * 60000
        );

        resetSegmentTiming(segment, fallbackWaitMinutes);
        segment.readyTime = readyTime.toISOString();
        segment.boardTime = boardTime.toISOString();
        segment.arrivalTime = arrivalTime.toISOString();
        segment.waitMinutes = waitMinutes;
        segment.plannedTimingSource = observedBoardTime
            ? scheduleProfile.source
            : 'frequency_fallback';

        if (i === 0) route.originWaitTime = waitMinutes;
        cursor = arrivalTime;
    }

    const finalArrival = new Date(cursor.getTime() + (route.walkTimeDest || 0) * 60000);
    route.estimatedTime = Math.round(
        (finalArrival.getTime() - departureTime.getTime()) / 60000
    );
    route.plannedDepartureTime = departureTime.toISOString();
    route.plannedArrivalTime = finalArrival.toISOString();
    return true;
}

function applyArriveTiming(route, arrivalDeadline, now, schedule = null, options = {}) {
    let cursor = new Date(arrivalDeadline.getTime() - (route.walkTimeDest || 0) * 60000);
    let firstLegWait = 0;
    let plannedFinalArrival = new Date(arrivalDeadline);

    for (let i = route.segments.length - 1; i >= 0; i--) {
        const segment = route.segments[i];
        const fallbackWaitMinutes = parseFrequencyMinutes(segment.routeInfo?.freq, i === 0 ? 15 : 12);
        const latestBoardTime = new Date(
            cursor.getTime() - getRideDurationMinutes(segment) * 60000
        );
        const scheduleProfile = getPlannedSegmentSchedulePeriod(
            segment,
            schedule,
            latestBoardTime,
            options
        );
        const observedBoardTime = scheduleProfile
            ? findObservedBoardTime(scheduleProfile.period, latestBoardTime, 'previous')
            : null;
        const boardTime = observedBoardTime || latestBoardTime;
        const arrivalTime = observedBoardTime
            ? new Date(boardTime.getTime() + getRideDurationMinutes(segment) * 60000)
            : new Date(cursor);
        const waitMinutes = observedBoardTime ? 0 : fallbackWaitMinutes;
        const readyTime = new Date(boardTime.getTime() - waitMinutes * 60000);
        const previousCursor = new Date(
            readyTime.getTime() - (getLegApproachMinutes(route, i) + BOARDING_BUFFER_MIN) * 60000
        );

        resetSegmentTiming(segment, fallbackWaitMinutes);
        segment.readyTime = readyTime.toISOString();
        segment.boardTime = boardTime.toISOString();
        segment.arrivalTime = arrivalTime.toISOString();
        segment.waitMinutes = waitMinutes;
        segment.plannedTimingSource = observedBoardTime
            ? scheduleProfile.source
            : 'frequency_fallback';

        if (i === 0) firstLegWait = waitMinutes;
        if (i === route.segments.length - 1 && observedBoardTime) {
            plannedFinalArrival = new Date(
                arrivalTime.getTime() + (route.walkTimeDest || 0) * 60000
            );
        }
        cursor = previousCursor;
    }

    route.originWaitTime = firstLegWait;
    route.estimatedTime = Math.round(
        (plannedFinalArrival.getTime() - cursor.getTime()) / 60000
    );
    route.plannedDepartureTime = cursor.toISOString();
    route.plannedArrivalTime = plannedFinalArrival.toISOString();
    route.requestedArrivalTime = arrivalDeadline.toISOString();
    return cursor.getTime() >= now.getTime();
}

async function applyRouteTiming(route, options = {}) {
    const {
        timeMode = 'now',
        dateValue,
        timeValue,
        now = new Date(),
        allowNoEtaNow = false,
        allowSparseHistoricalFallback = false,
        currentLocation = null,
    } = options;
    route.originWaitTime = 0;

    if (timeMode === 'now') {
        if (currentLocation) {
            await applyCurrentLocationApproach(route, currentLocation);
        } else {
            route.gpsTimingApplied = false;
            route.gpsLocation = null;
        }
        return applyNowTiming(route, now, { allowNoEta: allowNoEtaNow });
    }

    const plannedAnchorTime = buildPlannedDateTime(dateValue, timeValue, now);
    const schedule = await loadKmbOperationSchedule();
    let isValid = false;
    if (timeMode === 'leave') {
        isValid = applyLeaveTiming(route, plannedAnchorTime, schedule, {
            allowSparseDataFallback: allowSparseHistoricalFallback,
        });
    } else {
        isValid = applyArriveTiming(route, plannedAnchorTime, now, schedule, {
            allowSparseDataFallback: allowSparseHistoricalFallback,
        });
    }

    if (!isValid) return false;
    return validateRouteHistoricalSchedule(route, {
        allowSparseDataFallback: allowSparseHistoricalFallback,
        requestedDateTime: plannedAnchorTime,
        schedule,
    });
}

function findSubsequenceStarts(fullStops, segmentStops) {
    if (!Array.isArray(fullStops) || !Array.isArray(segmentStops) || segmentStops.length === 0) return [];
    const starts = [];
    for (let start = 0; start <= fullStops.length - segmentStops.length; start++) {
        let matches = true;
        for (let offset = 0; offset < segmentStops.length; offset++) {
            if (fullStops[start + offset] !== segmentStops[offset]) {
                matches = false;
                break;
            }
        }
        if (matches) starts.push(start);
    }
    return starts;
}

function annotateHistoricalSegmentContext(segment, routeStops, stopMap) {
    const fullStops = routeStops?.[segment.routeKey] || [];
    const matchingStarts = findSubsequenceStarts(fullStops, segment.stops || []);
    const uniqueStopCount = new Set(fullStops).size;
    const boardingStop = stopMap?.[segment.fromStop];
    segment.routeStopRecordExists = matchingStarts.length > 0;
    segment.boardingStopSequence = matchingStarts.length > 0 ? matchingStarts[0] + 1 : null;
    segment.boardingStopName = boardingStop?.name_tc || boardingStop?.name_en || segment.fromStop || null;
    segment.isLoopOrAmbiguousRoute = (
        matchingStarts.length !== 1 ||
        uniqueStopCount !== fullStops.length ||
        (fullStops.length > 1 && fullStops[0] === fullStops[fullStops.length - 1])
    );
    let routeDistanceKm = 0;
    for (let index = 1; index < (segment.stops || []).length; index++) {
        const previousStop = stopMap?.[segment.stops[index - 1]];
        const currentStop = stopMap?.[segment.stops[index]];
        if (!previousStop || !currentStop) continue;
        routeDistanceKm += haversine(
            Number(previousStop.lat),
            Number(previousStop.lng),
            Number(currentStop.lat),
            Number(currentStop.lng),
        );
    }
    segment.routeDistanceKm = routeDistanceKm > 0 ? routeDistanceKm : null;
    segment.rideDurationMinutes = getFallbackRideDurationMinutes(segment);
    segment.rideDurationSource = 'distance_stop_estimate';
}

function applyStraightLineWalkingEstimate(route) {
    const originWalk = getFallbackRoute(
        route.originLoc.lat, route.originLoc.lng, route.oLat, route.oLng, 'walking'
    );
    const destinationWalk = getFallbackRoute(
        route.dLat, route.dLng, route.destLoc.lat, route.destLoc.lng, 'walking'
    );
    route.walkInfoOrigin = originWalk;
    route.walkTimeOrigin = originWalk.duration;
    route.walkInfoDest = destinationWalk;
    route.walkTimeDest = destinationWalk.duration;
    route.walkTimeTransfer = 0;
    route.walkTimeTransfer2 = 0;
    if (route.transfers >= 1) {
        const transferWalk = getFallbackRoute(route.t1Lat, route.t1Lng, route.t2Lat, route.t2Lng, 'walking');
        route.walkInfoTransfer = transferWalk;
        route.walkTimeTransfer = transferWalk.duration;
    }
    if (route.transfers >= 2) {
        const transferWalk = getFallbackRoute(route.t3Lat, route.t3Lng, route.t4Lat, route.t4Lng, 'walking');
        route.walkInfoTransfer2 = transferWalk;
        route.walkTimeTransfer2 = transferWalk.duration;
    }
}

async function enrichGoogleWalkingEstimates(routes) {
    const jobs = new Map();
    const addLeg = (route, infoProperty, timeProperty, lat1, lng1, lat2, lng2) => {
        const coordinates = [lat1, lng1, lat2, lng2].map(Number);
        if (!coordinates.every(Number.isFinite)) return;
        if (haversine(...coordinates) <= 0.001) {
            route[infoProperty] = {
                distance: 0,
                duration: 0,
                geometry: [[coordinates[1], coordinates[0]], [coordinates[3], coordinates[2]]],
                source: 'same_location',
            };
            route[timeProperty] = 0;
            return;
        }
        const key = coordinates.map(value => value.toFixed(4)).join('|');
        if (!jobs.has(key)) jobs.set(key, { coordinates, assignments: [] });
        jobs.get(key).assignments.push({ route, infoProperty, timeProperty });
    };

    for (const route of routes || []) {
        route.walkTimeTransfer = 0;
        route.walkTimeTransfer2 = 0;
        route.walkInfoTransfer = null;
        route.walkInfoTransfer2 = null;
        addLeg(
            route, 'walkInfoOrigin', 'walkTimeOrigin',
            route.originLoc?.lat, route.originLoc?.lng, route.oLat, route.oLng
        );
        addLeg(
            route, 'walkInfoDest', 'walkTimeDest',
            route.dLat, route.dLng, route.destLoc?.lat, route.destLoc?.lng
        );
        if (route.transfers >= 1) {
            addLeg(
                route, 'walkInfoTransfer', 'walkTimeTransfer',
                route.t1Lat, route.t1Lng, route.t2Lat, route.t2Lng
            );
        }
        if (route.transfers >= 2) {
            addLeg(
                route, 'walkInfoTransfer2', 'walkTimeTransfer2',
                route.t3Lat, route.t3Lng, route.t4Lat, route.t4Lng
            );
        }
    }

    const pending = Array.from(jobs.values());
    let nextIndex = 0;
    let fallbackCount = 0;
    const worker = async () => {
        while (nextIndex < pending.length) {
            const job = pending[nextIndex++];
            const walkInfo = await fetchGCPRoute(...job.coordinates, 'walking');
            if (walkInfo.source !== 'google_directions') fallbackCount += 1;
            for (const assignment of job.assignments) {
                assignment.route[assignment.infoProperty] = walkInfo;
                assignment.route[assignment.timeProperty] = walkInfo.duration;
            }
        }
    };
    const workerCount = Math.min(GOOGLE_WALKING_CONCURRENCY, pending.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return { uniqueLegCount: pending.length, fallbackCount };
}

function isDefinitiveEarlyHistoricalRejection(route) {
    const definitiveStatuses = new Set([
        'route_stop_not_found',
        'fallback_blocked_strict_route',
        'fallback_blocked_loop_or_ambiguous_route',
        'station_profile_missing',
        'route_profile_missing',
    ]);
    return (route.segments || []).some((segment) => {
        const result = segment.historicalSchedule;
        if (!result || result.valid) return false;
        if (definitiveStatuses.has(result.status)) return true;
        if (result.reason === 'station_profile_missing_for_day_class') return true;
        if (result.reason === 'outside_observed_slots') {
            return Number(result.nearestSlotDeltaMin) > EARLY_HISTORICAL_BOUNDARY_GUARD_MIN;
        }
        if (result.reason !== 'outside_operation_window') return false;
        const requested = Number(result.requestedMinute);
        const start = timeStringToMinutes(result.startTime);
        const end = timeStringToMinutes(result.endTime);
        if (![requested, start, end].every(Number.isFinite)) return false;
        return Math.min(
            circularMinuteDelta(requested, start),
            circularMinuteDelta(requested, end)
        ) > EARLY_HISTORICAL_BOUNDARY_GUARD_MIN;
    });
}

async function earlyFilterPlannedCandidates(candidates, options = {}) {
    if (options.timeMode === 'now' || candidates.length === 0) {
        return { candidates, rejectedCount: 0 };
    }
    const schedule = options.schedule || await loadKmbOperationSchedule();
    if (!schedule) return { candidates, rejectedCount: 0 };

    const plannedAnchorTime = buildPlannedDateTime(options.dateValue, options.timeValue, options.now);
    const retained = [];
    for (const route of candidates) {
        applyStraightLineWalkingEstimate(route);
        const timingValid = options.timeMode === 'leave'
            ? applyLeaveTiming(route, plannedAnchorTime, schedule, {
                allowSparseDataFallback: options.allowSparseHistoricalFallback,
            })
            : applyArriveTiming(route, plannedAnchorTime, options.now, schedule, {
                allowSparseDataFallback: options.allowSparseHistoricalFallback,
            });
        if (!timingValid) continue;
        const historicalValid = await validateRouteHistoricalSchedule(route, {
            allowSparseDataFallback: options.allowSparseHistoricalFallback,
            requestedDateTime: plannedAnchorTime,
            logValidation: false,
            schedule,
        });
        if (historicalValid || !isDefinitiveEarlyHistoricalRejection(route)) retained.push(route);
    }
    return { candidates: retained, rejectedCount: candidates.length - retained.length };
}

function buildDiverseValidationShortlist(candidates, limit = MAX_NETWORK_CANDIDATES) {
    const seenForValidation = new Set();
    const originRoutePairs = new Map();
    const routePairVariantCount = new Map();
    const shortlisted = [];
    for (const candidate of candidates || []) {
        if (seenForValidation.has(candidate.dedupKey)) continue;
        const originRoute = candidate.segments[0].routeKey || candidate.segments[0].route;
        const pairKey = candidate.routePairKey || candidate.dedupKey;
        const pairs = originRoutePairs.get(originRoute) || new Set();
        const variantCount = routePairVariantCount.get(pairKey) || 0;

        if ((pairs.has(pairKey) || pairs.size < 6) && variantCount < MAX_TRANSFER_VARIANTS_PER_ROUTE_PAIR) {
            seenForValidation.add(candidate.dedupKey);
            pairs.add(pairKey);
            originRoutePairs.set(originRoute, pairs);
            routePairVariantCount.set(pairKey, variantCount + 1);
            shortlisted.push(candidate);
            if (shortlisted.length >= limit) break;
        }
    }
    return shortlisted;
}

async function preparePlannedValidationShortlist(candidates, options = {}) {
    const serviceFilter = await earlyFilterPlannedCandidates(candidates, options);
    return {
        candidates: buildDiverseValidationShortlist(serviceFilter.candidates),
        rejectedCount: serviceFilter.rejectedCount,
    };
}

async function earlyFilterNowCandidates(candidates, now, strictEtaOnly) {
    if (!strictEtaOnly || candidates.length === 0) {
        return { candidates, rejectedCount: 0 };
    }
    const decisions = await Promise.all(candidates.map(async (route) => {
        const firstSegment = route.segments?.[0];
        if (!firstSegment) return false;
        const etaRows = await fetchSegmentETA(firstSegment);
        return getActiveEtas(etaRows, now).length > 0;
    }));
    const retained = candidates.filter((_, index) => decisions[index]);
    return { candidates: retained, rejectedCount: candidates.length - retained.length };
}

async function rankNowCandidatesByTransferService(candidates, now, strictEtaOnly, allowSparseDataFallback) {
    if (!strictEtaOnly || candidates.length === 0) return;
    const transferCandidates = candidates.filter((route) => (route.segments || []).length > 1);
    if (transferCandidates.length === 0) return;
    const schedule = await loadKmbOperationSchedule();
    if (!schedule) return;

    for (const route of transferCandidates) {
        applyLeaveTiming(route, now, schedule, { allowSparseDataFallback });
        route._nowTransferScheduleRank = 0;
        for (let i = 1; i < (route.segments || []).length; i++) {
            const segment = route.segments[i];
            const result = validateSegmentHistoricalSchedule(
                segment,
                segment.boardTime,
                schedule,
                { allowSparseDataFallback }
            );
            if (!result.valid) {
                route._nowTransferScheduleRank = 1;
                break;
            }
        }
    }
}

function shouldLogPlanningDebug() {
    try {
        const hostname = String(window?.location?.hostname || '').toLowerCase();
        return hostname === 'localhost' || hostname === '127.0.0.1' ||
            window?.localStorage?.getItem('kmbPlanningDebug') === '1';
    } catch {
        return false;
    }
}

function retainTransferVariants(candidates, limit = MAX_TRANSFER_VARIANTS_PER_ROUTE_PAIR) {
    const groups = new Map();
    for (const candidate of candidates || []) {
        const key = candidate.routePairKey || candidate.dedupKey;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(candidate);
    }

    const retained = [];
    for (const group of groups.values()) {
        const byHeuristic = [...group].sort((a, b) => (a._hScore || 0) - (b._hScore || 0));
        const byProgress = [...group].sort(
            (a, b) => (a.transferOutIndex || 0) - (b.transferOutIndex || 0)
        );
        const progressSampleCount = Math.min(limit, byProgress.length);
        const progressSamples = Array.from(
            { length: progressSampleCount },
            (_, index) => byProgress[
                Math.round(
                    index * (byProgress.length - 1) /
                    Math.max(1, progressSampleCount - 1)
                )
            ]
        );
        const priority = [
            byHeuristic[0],
            byProgress[0],
            byProgress[byProgress.length - 1],
            ...progressSamples,
            ...byHeuristic,
        ].filter(Boolean);
        const seen = new Set();
        for (const candidate of priority) {
            if (seen.has(candidate.dedupKey)) continue;
            seen.add(candidate.dedupKey);
            retained.push(candidate);
            if (seen.size >= limit) break;
        }
    }
    return retained;
}

function normalizedRouteCode(value) {
    return String(value || '').trim().toUpperCase();
}

function routeStopIndex(stops, stopId, routeAtStop) {
    const sequenceIndex = Number(routeAtStop?.seq) - 1;
    if (Number.isInteger(sequenceIndex) && sequenceIndex >= 0 && stops[sequenceIndex] === stopId) {
        return sequenceIndex;
    }
    return stops.indexOf(stopId);
}

function addRouteAccessEntry(accessMap, routeKey, entry) {
    if (!accessMap.has(routeKey)) accessMap.set(routeKey, []);
    const entries = accessMap.get(routeKey);
    if (entries.some((current) => current.stop.id === entry.stop.id && current.index === entry.index)) return;
    entries.push(entry);
    entries.sort((left, right) => left.stop.distance - right.stop.distance || left.index - right.index);
    if (entries.length > MAX_ROUTE_ACCESS_STOPS) entries.length = MAX_ROUTE_ACCESS_STOPS;
}

function hasRepeatedRouteTransfer(route) {
    const seen = new Set();
    for (const segment of route?.segments || []) {
        const code = normalizedRouteCode(segment?.route);
        if (!code) continue;
        if (seen.has(code)) return true;
        seen.add(code);
    }
    return false;
}

function compareRouteCandidates(a, b) {
    const confidenceDelta = (b.historicalConfidenceScore || 0) - (a.historicalConfidenceScore || 0);
    if (confidenceDelta !== 0) return confidenceDelta;

    const arrivalA = new Date(a.plannedArrivalTime || '').getTime();
    const arrivalB = new Date(b.plannedArrivalTime || '').getTime();
    if (Number.isFinite(arrivalA) && Number.isFinite(arrivalB) && arrivalA !== arrivalB) {
        return arrivalA - arrivalB;
    }

    const estimatedTimeA = Number(a.estimatedTime);
    const estimatedTimeB = Number(b.estimatedTime);
    if (
        Number.isFinite(estimatedTimeA) &&
        Number.isFinite(estimatedTimeB) &&
        estimatedTimeA !== estimatedTimeB
    ) {
        return estimatedTimeA - estimatedTimeB;
    }

    if (a.transfers !== b.transfers) return a.transfers - b.transfers;
    const sameOneTransferPair = a.transfers === 1 &&
        a.routePairKey && a.routePairKey === b.routePairKey;
    const bothReasonableTransferWalks = Number(a.transferWalkDistanceKm) <= PREFERRED_TRANSFER_WALK_KM &&
        Number(b.transferWalkDistanceKm) <= PREFERRED_TRANSFER_WALK_KM;
    if (sameOneTransferPair && bothReasonableTransferWalks) {
        const transferWait = (route) => (route.segments || []).slice(1).reduce(
            (sum, segment) => sum + (Number(segment.waitMinutes) || 0),
            0
        );
        const transferWaitDelta = transferWait(a) - transferWait(b);
        if (transferWaitDelta !== 0) return transferWaitDelta;

        const transferWalkDelta = Number(a.transferWalkDistanceKm) -
            Number(b.transferWalkDistanceKm);
        if (Number.isFinite(transferWalkDelta) && transferWalkDelta !== 0) {
            return transferWalkDelta;
        }
    }
    const totalWalk = (route) => (route.walkTimeOrigin || 0) +
        (route.walkTimeDest || 0) +
        (route.walkTimeTransfer || 0) +
        (route.walkTimeTransfer2 || 0);
    const totalWalkDelta = totalWalk(a) - totalWalk(b);
    if (totalWalkDelta !== 0) return totalWalkDelta;

    if (sameOneTransferPair) {
        const progressDelta = Number(a.transferOutIndex) - Number(b.transferOutIndex);
        if (Number.isFinite(progressDelta) && progressDelta !== 0) return progressDelta;
    }
    return 0;
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// MAIN ROUTE FINDER - bidirectional network search
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
function visibleRouteSequenceKey(candidate) {
    const routeCodes = (candidate?.segments || [])
        .map((segment) => normalizedRouteCode(segment?.route))
        .filter(Boolean);
    if (routeCodes.length > 0) return routeCodes.join('->');
    return candidate?.routePairKey || candidate?.dedupKey || candidate?.id || '';
}

function candidateWalkingMinutes(candidate) {
    const walkValues = [
        candidate?.walkTimeOrigin,
        candidate?.walkTimeTransfer,
        candidate?.walkTimeTransfer2,
        candidate?.walkTimeDest,
    ]
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= 0);
    return walkValues.length > 0 ? walkValues.reduce((sum, value) => sum + value, 0) : Infinity;
}

function candidateEtaWaitMinutes(candidate) {
    const segments = candidate?.segments || [];
    // For a transfer, the connecting leg is the ETA that changes when the
    // overlapping drop-off station changes. Direct routes use their first leg.
    const etaSegments = segments.length > 1 ? segments.slice(1) : segments;
    const segmentWaits = etaSegments
        .map((segment) => Number(segment?.waitMinutes))
        .filter((value) => Number.isFinite(value) && value >= 0);
    if (segmentWaits.length > 0) return segmentWaits.reduce((sum, value) => sum + value, 0);
    const originWait = Number(candidate?.originWaitTime);
    return Number.isFinite(originWait) && originWait >= 0 ? originWait : Infinity;
}

function compareDisplayDuplicateCandidates(a, b) {
    const walkingA = candidateWalkingMinutes(a);
    const walkingB = candidateWalkingMinutes(b);
    if (Number.isFinite(walkingA) && Number.isFinite(walkingB)) {
        const walkingDelta = walkingA - walkingB;
        // Walking convenience is the primary choice. ETA only breaks a close
        // walking-time decision (three minutes or less apart).
        if (Math.abs(walkingDelta) > 3) return walkingDelta;

        const etaA = candidateEtaWaitMinutes(a);
        const etaB = candidateEtaWaitMinutes(b);
        const etaAWithinTarget = etaA <= 10;
        const etaBWithinTarget = etaB <= 10;
        if (etaAWithinTarget !== etaBWithinTarget) return etaAWithinTarget ? -1 : 1;
        if (Number.isFinite(etaA) && Number.isFinite(etaB) && etaA !== etaB) {
            return etaA - etaB;
        }
    } else if (Number.isFinite(walkingA) !== Number.isFinite(walkingB)) {
        return Number.isFinite(walkingA) ? -1 : 1;
    }

    return compareRouteCandidates(a, b);
}

function deduplicateRankedRouteSequences(rankedCandidates) {
    const bestBySequence = new Map();
    for (const candidate of rankedCandidates || []) {
        const sequenceKey = visibleRouteSequenceKey(candidate);
        const currentBest = bestBySequence.get(sequenceKey);
        if (!currentBest || compareDisplayDuplicateCandidates(candidate, currentBest) < 0) {
            bestBySequence.set(sequenceKey, candidate);
        }
    }
    return [...bestBySequence.values()].sort(compareRouteCandidates);
}

function findTwoTransferCandidates({
    originRouteSet,
    destStopIndex,
    stopMap,
    stopRoutes,
    routeStops,
    routeMap,
    originLoc,
    destLoc,
    grid,
    dedupSeen,
}) {
    const candidates = [];

    search:
    for (const [firstRouteKey, originEntries] of originRouteSet) {
        for (const originEntry of originEntries) {
            const firstRouteCode = normalizedRouteCode(originEntry.route?.route);
            for (let firstOutIndex = originEntry.index + 1;
                firstOutIndex < originEntry.stops.length;
                firstOutIndex++) {
                const firstOutId = originEntry.stops[firstOutIndex];
                const firstOutStop = stopMap[firstOutId];
                if (!firstOutStop) continue;

                const firstBoardingStops = nearbyFromGrid(
                    grid,
                    firstOutStop.lat,
                    firstOutStop.lng,
                    TRANSFER_WALK_KM
                ).slice(0, 4);

                for (const middleBoardStop of firstBoardingStops) {
                    const middleRows = stopRoutes[middleBoardStop.id] || [];
                    const seenMiddleRoutes = new Set();
                    for (const middleRoute of middleRows) {
                        const middleRouteKey = `${middleRoute.route}|${middleRoute.bound}|${middleRoute.service_type}`;
                        if (seenMiddleRoutes.has(middleRouteKey)) continue;
                        seenMiddleRoutes.add(middleRouteKey);
                        const middleRouteCode = normalizedRouteCode(middleRoute.route);
                        if (!middleRouteCode || middleRouteCode === firstRouteCode) continue;

                        const middleStops = routeStops[middleRouteKey] || [];
                        const middleInIndex = routeStopIndex(
                            middleStops,
                            middleBoardStop.id,
                            middleRoute
                        );
                        if (middleInIndex < 0) continue;

                        for (let middleOutIndex = middleInIndex + 1;
                            middleOutIndex < middleStops.length;
                            middleOutIndex++) {
                            const middleOutId = middleStops[middleOutIndex];
                            const middleOutStop = stopMap[middleOutId];
                            if (!middleOutStop) continue;

                            const finalBoardingStops = nearbyFromGrid(
                                grid,
                                middleOutStop.lat,
                                middleOutStop.lng,
                                TRANSFER_WALK_KM
                            ).slice(0, 4);

                            for (const finalBoardStop of finalBoardingStops) {
                                for (const destinationEntry of destStopIndex.get(finalBoardStop.id) || []) {
                                    const finalRouteCode = normalizedRouteCode(destinationEntry.route?.route);
                                    if (!finalRouteCode || finalRouteCode === firstRouteCode ||
                                        finalRouteCode === middleRouteCode) continue;

                                    const routeSequenceKey =
                                        `2t|${firstRouteKey}->${middleRouteKey}->${destinationEntry.routeKey}`;
                                    const dedupKey = `${routeSequenceKey}|` +
                                        `${firstOutId}->${middleBoardStop.id}|` +
                                        `${middleOutId}->${finalBoardStop.id}`;
                                    if (dedupSeen.has(dedupKey)) continue;
                                    dedupSeen.add(dedupKey);

                                    const firstStops = originEntry.stops.slice(
                                        originEntry.index,
                                        firstOutIndex + 1
                                    );
                                    const secondStops = middleStops.slice(
                                        middleInIndex,
                                        middleOutIndex + 1
                                    );
                                    const thirdStops = destinationEntry.stops.slice(
                                        destinationEntry.transferIdx,
                                        destinationEntry.dIdx + 1
                                    );
                                    const heuristicScore = (
                                        firstStops.length + secondStops.length + thirdStops.length
                                    ) * RIDE_MIN_PER_STOP +
                                        originEntry.stop.distance * 12 +
                                        destinationEntry.dStop.distance * 12 +
                                        (middleBoardStop.distance + finalBoardStop.distance) * 10;

                                    candidates.push({
                                        id: `t2-${candidates.length}`,
                                        transfers: 2,
                                        totalStops: firstStops.length + secondStops.length + thirdStops.length,
                                        dedupKey,
                                        routePairKey: routeSequenceKey,
                                        _hScore: heuristicScore,
                                        transferOutIndex: firstOutIndex,
                                        transferInIndex: middleInIndex,
                                        transferWalkDistanceKm: middleBoardStop.distance,
                                        segments: [
                                            { route: originEntry.route.route, bound: originEntry.route.bound, service_type: originEntry.route.service_type, routeKey: firstRouteKey, fromStop: originEntry.stop.id, toStop: firstOutId, stops: firstStops, routeInfo: routeMap[firstRouteKey] },
                                            { route: middleRoute.route, bound: middleRoute.bound, service_type: middleRoute.service_type, routeKey: middleRouteKey, fromStop: middleBoardStop.id, toStop: middleOutId, stops: secondStops, routeInfo: routeMap[middleRouteKey] },
                                            { route: destinationEntry.route.route, bound: destinationEntry.route.bound, service_type: destinationEntry.route.service_type, routeKey: destinationEntry.routeKey, fromStop: finalBoardStop.id, toStop: destinationEntry.dStop.id, stops: thirdStops, routeInfo: routeMap[destinationEntry.routeKey] },
                                        ],
                                        originLoc,
                                        destLoc,
                                        oLat: originEntry.stop.lat,
                                        oLng: originEntry.stop.lng,
                                        oDist: originEntry.stop.distance,
                                        dLat: destinationEntry.dStop.lat,
                                        dLng: destinationEntry.dStop.lng,
                                        dDist: destinationEntry.dStop.distance,
                                        t1Lat: firstOutStop.lat,
                                        t1Lng: firstOutStop.lng,
                                        t2Lat: middleBoardStop.lat,
                                        t2Lng: middleBoardStop.lng,
                                        t3Lat: middleOutStop.lat,
                                        t3Lng: middleOutStop.lng,
                                        t4Lat: finalBoardStop.lat,
                                        t4Lng: finalBoardStop.lng,
                                    });
                                    if (candidates.length >= MAX_TWO_TRANSFER_CANDIDATES) break search;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    return candidates;
}

async function findRoutes(params) {
    const { originLoc, destLoc, stopMap, routeMap, routeStops, stopRoutes, timeMode, dateValue, timeValue, excludedRoutesText, strictEtaOnly = true, allowSparseHistoricalFallback = false, currentLocation = null, useGoogleRefinement = false, useGoogleRideTimeReference = false, onProgress } = params;
    const planningStartedAt = Date.now();
    const now = new Date();
    const requestStatsBefore = requestStatsSnapshot();
    const stageTimings = {};
    let stageStartedAt = planningStartedAt;
    const finishStage = (name) => {
        const now = Date.now();
        stageTimings[name] = now - stageStartedAt;
        stageStartedAt = now;
    };

    if (![originLoc?.lat, originLoc?.lng, destLoc?.lat, destLoc?.lng].every(Number.isFinite)) {
        throw new Error('Route planning requires valid origin and destination coordinates.');
    }
    if (!stopMap || !routeMap || !routeStops || !stopRoutes) {
        throw new Error('KMB route data is not ready. Please reload the app and try again.');
    }

    // Build spatial grid once
    const grid = buildSpatialGrid(stopMap);

    // Parse excluded routes into a Set
    const excludedRoutes = new Set(
        (excludedRoutesText || '')
            .split(/[\s,]+/)
            .map(r => r.trim().toUpperCase())
            .filter(r => r.length > 0)
    );

    // Find nearby stops (within 600m)
    onProgress?.('Locating nearby bus stops...');
    const originStops = nearbyFromGrid(grid, originLoc.lat, originLoc.lng, WALK_RADIUS_KM);
    const destStops = nearbyFromGrid(grid, destLoc.lat, destLoc.lng, WALK_RADIUS_KM);

    if (originStops.length === 0) throw new Error(`No bus stops within ${WALK_RADIUS_KM * 1000}m of origin`);
    if (destStops.length === 0) throw new Error(`No bus stops within ${WALK_RADIUS_KM * 1000}m of destination`);

    onProgress?.('Building route index...');

    // Build origin-route access entries.
    // routeKey ??{ oStop, oIdx, stops, route }  (best = closest origin stop)
    const originRouteSet = new Map();
    for (const oStop of originStops) {
        for (const r of (stopRoutes[oStop.id] || [])) {
            if (excludedRoutes.has(normalizedRouteCode(r?.route))) continue;

            const key = `${r.route}|${r.bound}|${r.service_type}`;
            const stops = routeStops[key] || [];
            const idx = routeStopIndex(stops, oStop.id, r);
            if (idx === -1) continue;
            addRouteAccessEntry(originRouteSet, key, {
                stop: oStop,
                index: idx,
                stops,
                route: r,
                routeKey: key,
            });
        }
    }

    // Build destination-route access entries.
    // routeKey ??{ dStop, dIdx, stops, route }  (best = closest dest stop)
    const destRouteSet = new Map();
    for (const dStop of destStops) {
        for (const r of (stopRoutes[dStop.id] || [])) {
            if (excludedRoutes.has(normalizedRouteCode(r?.route))) continue;

            const key = `${r.route}|${r.bound}|${r.service_type}`;
            const stops = routeStops[key] || [];
            const idx = routeStopIndex(stops, dStop.id, r);
            if (idx === -1) continue;
            addRouteAccessEntry(destRouteSet, key, {
                stop: dStop,
                index: idx,
                stops,
                route: r,
                routeKey: key,
            });
        }
    }

    // Index stops that can board a destination-reaching route.
    // For every stop that appears BEFORE the dest stop on any dest-set route,
    // map stopId ??[{ routeKey, dIdx, dStop, route }]
    // This is what makes fast 1-transfer matching possible.
    const destStopIndex = new Map(); // stopId ??[destRouteEntry]
    for (const destinationEntries of destRouteSet.values()) {
        for (const destinationEntry of destinationEntries) {
            for (let i = 0; i < destinationEntry.index; i++) {
                const sid = destinationEntry.stops[i];
                if (!destStopIndex.has(sid)) destStopIndex.set(sid, []);
                destStopIndex.get(sid).push({
                    route: destinationEntry.route,
                    routeKey: destinationEntry.routeKey,
                    stops: destinationEntry.stops,
                    dStop: destinationEntry.stop,
                    dIdx: destinationEntry.index,
                    transferIdx: i,
                });
            }
        }
    }

    const found = [];
    const dedupSeen = new Set();
    const foundByDedupKey = new Map();

    // Direct routes: same variant, with the boarding stop before alighting.
    onProgress?.('Finding direct routes...');
    for (const [key, originEntries] of originRouteSet) {
        if (!destRouteSet.has(key)) continue;
        const validPairs = originEntries.flatMap((originEntry) =>
            destRouteSet.get(key)
                .filter((destinationEntry) => originEntry.index < destinationEntry.index)
                .map((destinationEntry) => ({ originEntry, destinationEntry }))
        );
        if (validPairs.length === 0) continue;
        validPairs.sort((left, right) => {
            const leftScore = left.originEntry.stop.distance + left.destinationEntry.stop.distance;
            const rightScore = right.originEntry.stop.distance + right.destinationEntry.stop.distance;
            return leftScore - rightScore ||
                (left.destinationEntry.index - left.originEntry.index) -
                (right.destinationEntry.index - right.originEntry.index);
        });
        const { originEntry, destinationEntry } = validPairs[0];

        const segStops = originEntry.stops.slice(originEntry.index, destinationEntry.index + 1);
        const dk = `direct|${key}`;
        if (dedupSeen.has(dk)) continue;
        dedupSeen.add(dk);

        found.push({
            id: `d-${found.length}`, transfers: 0,
            totalStops: segStops.length, dedupKey: dk,
            segments: [{ route: originEntry.route.route, bound: originEntry.route.bound, service_type: originEntry.route.service_type, routeKey: key, fromStop: originEntry.stop.id, toStop: destinationEntry.stop.id, stops: segStops, routeInfo: routeMap[key] }],
            originLoc, destLoc,
            oLat: originEntry.stop.lat, oLng: originEntry.stop.lng, oDist: originEntry.stop.distance,
            dLat: destinationEntry.stop.lat, dLng: destinationEntry.stop.lng, dDist: destinationEntry.stop.distance,
        });
        foundByDedupKey.set(dk, found[found.length - 1]);
    }

    // One-transfer routes.
    // For each origin route, walk its stops forward. For each stop, check its
    // neighbors in the spatial grid. If any neighbor's stopId is in destStopIndex,
    // we found a valid transfer.
    onProgress?.('Finding 1-transfer routes...');
    for (const [r1Key, originEntries] of originRouteSet) {
      for (const originEntry of originEntries) {
        const orig = {
            oStop: originEntry.stop,
            oIdx: originEntry.index,
            stops: originEntry.stops,
            route: originEntry.route,
            routeKey: originEntry.routeKey,
        };
        for (let i = orig.oIdx + 1; i < orig.stops.length; i++) {
            const transferStopId = orig.stops[i];
            const transferStop = stopMap[transferStopId];
            if (!transferStop) continue;

            // Find nearby stops ??use grid for speed
            const nearby = nearbyFromGrid(grid, transferStop.lat, transferStop.lng, TRANSFER_WALK_KM);

            for (const nb of nearby) {
                // Check if this nearby stop is a valid boarding point for any dest-set route
                const destMatches = destStopIndex.get(nb.id) || [];
                for (const dest of destMatches) {
                    if (dest.routeKey === r1Key) continue; // avoid same route transfer
                    if (normalizedRouteCode(dest.route?.route) === normalizedRouteCode(orig.route?.route)) continue;

                    const seg1Stops = orig.stops.slice(orig.oIdx, i + 1);
                    const seg2Stops = dest.stops.slice(dest.transferIdx, dest.dIdx + 1);
                    const routePairKey = `1t|${r1Key}->${dest.routeKey}`;
                    const dk = `${routePairKey}|${transferStopId}->${nb.id}`;

                    // Keep distinct physical transfer points; a bounded diverse subset is
                    // retained below so live ETA can choose between shared-corridor options.
                    const hScore = seg1Stops.length * RIDE_MIN_PER_STOP + seg2Stops.length * RIDE_MIN_PER_STOP
                        + orig.oStop.distance * 12 + dest.dStop.distance * 12 + nb.distance * 10;

                    if (dedupSeen.has(dk)) {
                        // Replace if better score
                        const existing = foundByDedupKey.get(dk);
                        if (existing && hScore < existing._hScore) {
                            existing._hScore = hScore;
                            existing.segments[0].stops = seg1Stops;
                            existing.segments[0].fromStop = orig.oStop.id;
                            existing.segments[0].toStop = transferStopId;
                            existing.segments[1].stops = seg2Stops;
                            existing.segments[1].fromStop = nb.id;
                            existing.segments[1].toStop = dest.dStop.id;
                            existing.totalStops = seg1Stops.length + seg2Stops.length;
                            existing.oLat = orig.oStop.lat; existing.oLng = orig.oStop.lng; existing.oDist = orig.oStop.distance;
                            existing.dLat = dest.dStop.lat; existing.dLng = dest.dStop.lng; existing.dDist = dest.dStop.distance;
                            existing.t1Lat = transferStop.lat; existing.t1Lng = transferStop.lng;
                            existing.t2Lat = nb.lat; existing.t2Lng = nb.lng;
                            existing.transferOutIndex = i;
                            existing.transferInIndex = dest.transferIdx;
                            existing.transferWalkDistanceKm = nb.distance;
                        }
                        continue;
                    }
                    dedupSeen.add(dk);

                    found.push({
                        id: `t1-${found.length}`, transfers: 1,
                        totalStops: seg1Stops.length + seg2Stops.length,
                        dedupKey: dk, routePairKey, _hScore: hScore,
                        transferOutIndex: i,
                        transferInIndex: dest.transferIdx,
                        transferWalkDistanceKm: nb.distance,
                        segments: [
                            { route: orig.route.route, bound: orig.route.bound, service_type: orig.route.service_type, routeKey: r1Key, fromStop: orig.oStop.id, toStop: transferStopId, stops: seg1Stops, routeInfo: routeMap[r1Key] },
                            { route: dest.route.route, bound: dest.route.bound, service_type: dest.route.service_type, routeKey: dest.routeKey, fromStop: nb.id, toStop: dest.dStop.id, stops: seg2Stops, routeInfo: routeMap[dest.routeKey] },
                        ],
                        originLoc, destLoc,
                        oLat: orig.oStop.lat, oLng: orig.oStop.lng, oDist: orig.oStop.distance,
                        dLat: dest.dStop.lat, dLng: dest.dStop.lng, dDist: dest.dStop.distance,
                        t1Lat: transferStop.lat, t1Lng: transferStop.lng,
                        t2Lat: nb.lat, t2Lng: nb.lng,
                    });
                    foundByDedupKey.set(dk, found[found.length - 1]);
                }
            }
        }
      }
    }

    // Two-transfer routes use a genuine middle route between the origin and
    // destination route sets, and are skipped when simpler choices are plentiful.
    onProgress?.('Finding 2-transfer routes...');
    const directCandidates = found.filter((candidate) => candidate.transfers === 0);
    const retainedOneTransferCandidates = retainTransferVariants(
        found.filter((candidate) => candidate.transfers === 1)
    );
    found.length = 0;
    found.push(...directCandidates, ...retainedOneTransferCandidates);

    if (found.length < SIMPLE_CANDIDATES_BEFORE_SKIPPING_TWO_TRANSFER) {
        found.push(...findTwoTransferCandidates({
            originRouteSet,
            destStopIndex,
            stopMap,
            stopRoutes,
            routeStops,
            routeMap,
            originLoc,
            destLoc,
            grid,
            dedupSeen,
        }));
    }

    for (const route of found) {
        for (const segment of route.segments || []) {
            annotateHistoricalSegmentContext(segment, routeStops, stopMap);
        }
    }

    // Initial heuristic sort prioritizes service validation work.
    // A transfer is commonly outside KMB's live ETA horizon. Prioritize candidates
    // whose future legs are supported for this day and approximate boarding time,
    // so inactive express services cannot consume the bounded shortlist.
    if (timeMode === 'now') {
        await rankNowCandidatesByTransferService(
            found,
            now,
            strictEtaOnly,
            allowSparseHistoricalFallback
        );
    }

    found.sort((a, b) => {
        const transferServiceDelta = (a._nowTransferScheduleRank || 0) -
            (b._nowTransferScheduleRank || 0);
        if (transferServiceDelta !== 0) return transferServiceDelta;
        // Drastically reduce stop penalty: a highway route with 5 stops vs an express route with 25 stops 
        // often take the same time. The real penalty should be transfers and walking distance.
        const score = f => f.totalStops * 0.1 + f.transfers * 15 + ((f.oDist || 0) + (f.dDist || 0)) * 20;
        return score(a) - score(b);
    });

    // Reject meaningless same-number transfers before any service or Google work.
    let repeatedRouteCandidatesRejected = 0;
    const nonRepeatedCandidates = [];
    for (const c of found) {
        if (hasRepeatedRouteTransfer(c)) {
            repeatedRouteCandidatesRejected += 1;
            continue;
        }
        nonRepeatedCandidates.push(c);
    }

    // Planned service evidence must be checked before the shortlist cap. Otherwise a
    // large group of nearby but inactive route pairs can consume every shortlist slot
    // and hide a valid route that appears later in the heuristic ordering.
    finishStage('candidateGeneration');
    const plannedShortlist = await preparePlannedValidationShortlist(nonRepeatedCandidates, {
        timeMode,
        dateValue,
        timeValue,
        now,
        allowSparseHistoricalFallback,
    });
    // Bound ETA and Google work only after planned candidates have been filtered,
    // while preserving route-pair and transfer-point diversity.
    const candidates = plannedShortlist.candidates;
    const earlyNowFilter = timeMode === 'now'
        ? await earlyFilterNowCandidates(candidates, now, strictEtaOnly)
        : { candidates, rejectedCount: 0 };
    const networkCandidates = earlyNowFilter.candidates;
    finishStage('earlyServiceFilter');

    onProgress?.('Calculating walking times with Google Maps...');
    const googleWalkingSummary = await enrichGoogleWalkingEstimates(networkCandidates);
    finishStage('walkingEnrichment');

    // ETA and historical-service validation.
    onProgress?.('Checking scheduled services...');
    const filteredCandidates = [];

    await Promise.all(networkCandidates.map(async route => {
        const isValid = await applyRouteTiming(route, {
            timeMode,
            dateValue,
            timeValue,
            now,
            allowNoEtaNow: !strictEtaOnly,
            allowSparseHistoricalFallback,
            currentLocation,
        });
        if (isValid) filteredCandidates.push(route);
    }));
    finishStage('serviceValidation');

    // Google ride-time references are bounded and explicitly enabled.  The
    // legacy refinement flag remains supported for callers/tests that already
    // opt into it.
    const shouldUseGoogleRideTimeReference = useGoogleRideTimeReference || useGoogleRefinement;
    let googleRideCandidatesRefined = 0;
    if (shouldUseGoogleRideTimeReference && filteredCandidates.length > 0) {
        onProgress?.('Estimating KMB in-vehicle bus time...');
        const plannedAnchorTime = buildPlannedDateTime(dateValue, timeValue, now);
        filteredCandidates.sort(compareRouteCandidates);
        const rideRefinementCandidates = filteredCandidates.slice(
            0,
            MAX_GOOGLE_RIDE_REFINEMENT_CANDIDATES
        );
        googleRideCandidatesRefined = rideRefinementCandidates.length;
        await enrichGoogleRideDurations(rideRefinementCandidates, stopMap, {
            timeMode,
            departureTime: timeMode === 'now' ? now : plannedAnchorTime,
            arrivalTime: plannedAnchorTime,
        });

        const refinedCandidates = [];
        await Promise.all(filteredCandidates.map(async route => {
            const isValid = await applyRouteTiming(route, {
                timeMode,
                dateValue,
                timeValue,
                now,
                allowNoEtaNow: !strictEtaOnly,
                allowSparseHistoricalFallback,
                currentLocation,
            });
            if (isValid) refinedCandidates.push(route);
        }));

        filteredCandidates.length = 0;
        filteredCandidates.push(...refinedCandidates);
    }
    finishStage('rideRefinement');

    filteredCandidates.sort(compareRouteCandidates);
    finishStage('finalSort');

    const requestDelta = requestStatsDelta(requestStatsBefore);
    // ETA/schedule ranking has already selected the most efficient transfer point.
    // Display only that winner when other candidates show the same bus-number
    // sequence but differ by route pattern metadata or overlapping transfer stop.
    const rankedUniqueCandidates = deduplicateRankedRouteSequences(filteredCandidates);
    const finalCandidates = rankedUniqueCandidates.slice(0, MAX_FINAL);
    const slowestStep = Object.entries(stageTimings)
        .sort((a, b) => b[1] - a[1])[0] || ['none', 0];
    LAST_PLANNING_DEBUG_SUMMARY = {
        timeMode,
        totalMs: Date.now() - planningStartedAt,
        stagesMs: stageTimings,
        slowestStep: { name: slowestStep[0], durationMs: slowestStep[1] },
        candidatesGenerated: found.length,
        candidatesShortlisted: candidates.length,
        earlyHistoricalRejected: plannedShortlist.rejectedCount,
        earlyLiveEtaRejected: earlyNowFilter.rejectedCount,
        repeatedRouteCandidatesRejected,
        googleRefinementEnabled: useGoogleRefinement,
        googleRideTimeReferenceEnabled: shouldUseGoogleRideTimeReference,
        googleRideCandidatesRefined,
        googleWalkingUniqueLegs: googleWalkingSummary.uniqueLegCount,
        googleWalkingFallbacks: googleWalkingSummary.fallbackCount,
        candidatesAfterEarlyFilter: networkCandidates.length,
        candidatesAfterServiceValidation: filteredCandidates.length,
        finalCandidateCount: finalCandidates.length,
        externalRequestCount: requestDelta.gcpNetworkRequests +
            requestDelta.etaNetworkRequests +
            requestDelta.historicalNetworkRequests,
        requests: requestDelta,
    };
    if (shouldLogPlanningDebug()) {
        console.debug('[KMB planning performance]', LAST_PLANNING_DEBUG_SUMMARY);
    }

    return { filteredCandidates: finalCandidates, originStops, destStops, debugSummary: LAST_PLANNING_DEBUG_SUMMARY };
}

function getLastPlanningDebugSummary() {
    return LAST_PLANNING_DEBUG_SUMMARY
        ? JSON.parse(JSON.stringify(LAST_PLANNING_DEBUG_SUMMARY))
        : null;
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// EXPORT
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
window.routeEngine = {
    findRoutes,
    fetchETA,
    fetchGCPRoute,
    clearETACache,
    getActiveEtas,
    getNextValidBusETA,
    getFallbackRideDurationMinutes,
    applyRouteTiming,
    validateSegmentHistoricalSchedule,
    compareRouteCandidates,
    retainTransferVariants,
    visibleRouteSequenceKey,
    deduplicateRankedRouteSequences,
    preparePlannedValidationShortlist,
    getLastPlanningDebugSummary,
    STRICT_STOP_LEVEL_ROUTES,
};

