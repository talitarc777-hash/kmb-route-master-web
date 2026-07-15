/**
 * KMB Route Engine ??Bidirectional Search with Spatial Grid
 *
 * Algorithm:
 *  1. Build a spatial grid of all stops (O(1) neighbor lookups)
 *  2. Build ORIGIN SET ??routes departing from within 600m of origin
 *  3. Build DEST SET   ??routes arriving  at  stops within 600m of dest
 *  4. Direct routes    ??set intersection (ORIGIN SET ??DEST SET, same route)
 *  5. 1-Transfer       ??for each origin route, scan forward stops;
 *                        check the spatial grid for dest-set routes nearby
 *  6. 2-Transfer       ??extend 1-transfer dropoffs using the same approach
 *  7. Rank & dedup     ??by (estimatedTime, transfers, walk)
 */

'use strict';

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// CONSTANTS
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
const WALK_RADIUS_KM = 0.6;   // walk from origin/dest to bus stop
const TRANSFER_WALK_KM = 0.6;   // walk between transfer stops
const MAX_FINAL = 100;   // results shown to user (increased for debugging)
const RIDE_MIN_PER_STOP = 1.5;  // minutes per bus stop
const BOARDING_BUFFER_MIN = 1; // small safety buffer before boarding each leg
const GRID_DEG = 0.005; // spatial grid cell ??500m
const ETA_ACTIVE_WINDOW_MIN = 120; // ETA must be within this window to be considered active
const ETA_CACHE_TTL_MS = 30 * 1000;
const RIDE_TIME_CACHE_BUCKET_MS = 30 * 60 * 1000;
const GCP_CACHE = new Map(); // in-memory promise cache
const GCP_CACHE_STORAGE_KEY = 'kmb_gcp_route_cache_v1';
const GCP_CACHE_MAX_ENTRIES = 400;
const GCP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GCP_DRIVING_ROUTE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KMB_OPERATION_SCHEDULE_URL = '/operator-data/kmb_operation_time_slots.runtime.json?v=3';
const KMB_ROUTE_STOP_SLOT_TOLERANCE_MIN = 20;
const KMB_ROUTE_SLOT_TOLERANCE_MIN = 75;
const KMB_HIGH_CONFIDENCE_MIN_SAMPLES = 30;
const KMB_HIGH_CONFIDENCE_MIN_SAMPLE_DAYS = 7;
const EARLY_HISTORICAL_BOUNDARY_GUARD_MIN = 30;
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
    payloadBytes: 0,
};
let GCP_PERSISTED_CACHE = null;
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
// SPATIAL GRID  ??build once per search, reuse for all lookups
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
function buildSpatialGrid(stopMap) {
    if (stopMap && typeof stopMap === 'object' && SPATIAL_GRID_CACHE.has(stopMap)) {
        return SPATIAL_GRID_CACHE.get(stopMap);
    }
    const grid = new Map();
    for (const [id, s] of Object.entries(stopMap)) {
        const gx = Math.floor(s.lat / GRID_DEG);
        const gy = Math.floor(s.lng / GRID_DEG);
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ id, ...s });
    }
    if (stopMap && typeof stopMap === 'object') SPATIAL_GRID_CACHE.set(stopMap, grid);
    return grid;
}

function nearbyFromGrid(grid, lat, lng, radiusKm) {
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

async function fetchGCPRoute(lat1, lng1, lat2, lng2, mode = 'walking', intermediateStops = [], _gcpKey) {
    const wpSig = getWaypointSignature(intermediateStops);
    const cacheKey = `${mode}|${lat1.toFixed(4)},${lng1.toFixed(4)}->${lat2.toFixed(4)},${lng2.toFixed(4)}|${wpSig}`;
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
const ETA_CALL_LOG = [];

function logEtaCall(entry) {
    ETA_CALL_LOG.push({ ts: new Date().toISOString(), ...entry });
    if (ETA_CALL_LOG.length > 500) ETA_CALL_LOG.shift();
}

async function fetchETA(stopId, route, serviceType) {
    const key = `${stopId}|${route}|${serviceType}`;
    const cached = ETA_CACHE.get(key);
    if (cached) {
        if (cached.expiresAt > Date.now()) {
            REQUEST_STATS.etaCacheHits += 1;
            REQUEST_STATS.duplicateRequestsPrevented += 1;
            logEtaCall({ type: 'cache_hit', key, stopId, route, serviceType });
            return cached.promise;
        }
        ETA_CACHE.delete(key);
    }
    const p = (async () => {
        const startedAt = Date.now();
        const url = `https://data.etabus.gov.hk/v1/transport/kmb/eta/${stopId}/${route}/${serviceType}`;
        REQUEST_STATS.etaNetworkRequests += 1;
        try {
            const response = await fetch(url);
            recordPayloadBytes(response);
            const data = await response.json();
            const items = data?.data || [];
            logEtaCall({
                type: 'network_ok',
                key,
                stopId,
                route,
                serviceType,
                count: items.length,
                durationMs: Date.now() - startedAt,
                url,
            });
            return items;
        } catch (e) {
            logEtaCall({
                type: 'network_error',
                key,
                stopId,
                route,
                serviceType,
                durationMs: Date.now() - startedAt,
                error: String(e?.message || e),
                url,
            });
            return [];
        }
    })();
    ETA_CACHE.set(key, { promise: p, expiresAt: Date.now() + ETA_CACHE_TTL_MS });
    return p;
}

function clearETACache() { ETA_CACHE.clear(); }
function clearEtaCallLog() { ETA_CALL_LOG.length = 0; }
function getEtaCallLog() { return [...ETA_CALL_LOG]; }
function formatEtaCallLogTxt() {
    return ETA_CALL_LOG.map((row, i) => {
        const parts = [
            `#${i + 1}`,
            row.ts,
            row.type,
            `route=${row.route || '-'}`,
            `stop=${row.stopId || '-'}`,
            `service=${row.serviceType || '-'}`,
            `count=${row.count ?? '-'}`,
            `durationMs=${row.durationMs ?? '-'}`,
            `key=${row.key || '-'}`,
        ];
        if (row.error) parts.push(`error=${row.error}`);
        if (row.url) parts.push(`url=${row.url}`);
        return parts.join(' | ');
    }).join('\n');
}
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

function validateSchedulePeriod(period, plannedDate, toleranceMin, requireObservedSlots = false) {
    if (!period) return { valid: false, reason: 'missing_period' };
    const minute = dateToMinutes(plannedDate);
    const startMinute = timeStringToMinutes(period.s);
    const endMinute = timeStringToMinutes(period.e);
    const startTime = formatMinutesAsTime(startMinute) || period.s;
    const endTime = formatMinutesAsTime(endMinute) || period.e;
    if (!isMinuteWithinPeriod(minute, startMinute, endMinute)) {
        return {
            valid: false,
            reason: 'outside_operation_window',
            startTime,
            endTime,
        };
    }
    const nearest = nearestSlotDistance(minute, period.a || []) ||
        nearestEncodedSlotDistance(minute, period.m, period.sm || 15);
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
        reason: 'matched_historical_operation',
        startTime,
        endTime,
        nearestSlot: nearest?.slot || null,
        nearestSlotDeltaMin: nearest?.deltaMin ?? null,
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
            reason: 'operating at boarding stop in historical window',
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
    const schedule = await loadKmbOperationSchedule();
    if (!schedule) {
        route.historicalScheduleStatus = 'schedule_unavailable';
        route.historicalScheduleRejectReason = 'schedule_unavailable';
        route.historicalConfidence = 'unsupported';
        route.historicalConfidenceScore = 0;
        return false;
    }

    let routeConfidenceRank = 3;
    for (const segment of route.segments || []) {
        const result = validateSegmentHistoricalSchedule(segment, segment.boardTime, schedule, options);
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
    return (segment?.stops?.length || 0) * RIDE_MIN_PER_STOP;
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
    const referenceTime = timeMode === 'arrive'
        ? options.arrivalTime
        : options.departureTime;
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
    if (cached) return cached;

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
                const usableSteps = matchingBusSteps.length > 0
                    ? matchingBusSteps
                    : transitSteps.filter((step) => String(step?.transit_details?.line?.vehicle?.type || '').toUpperCase() === 'BUS');

                if (usableSteps.length > 0) {
                    const duration = Math.max(
                        1,
                        Math.round(
                            usableSteps.reduce((sum, step) => sum + (step?.duration?.value || 0), 0) / 60
                        )
                    );
                    const payload = { duration, source: 'google_transit_bus_duration' };
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
    segment.busInterval = defaultFrequency;
    segment.readyTime = null;
    segment.boardTime = null;
    segment.arrivalTime = null;
    segment.waitMinutes = null;
    segment.timingFallbackReason = null;
    segment.historicalSchedule = null;
}

async function applyNowTiming(route, now, options = {}) {
    const { allowNoEta = false, allowTransferScheduleFallback = true } = options;
    let cursor = new Date(now);
    let schedule = null;

    for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        const defaultFrequency = parseFrequencyMinutes(segment.routeInfo?.freq, i === 0 ? 15 : 12);
        const etaList = await fetchSegmentETA(segment);
        const readyTime = new Date(
            cursor.getTime() + (getLegApproachMinutes(route, i) + BOARDING_BUFFER_MIN) * 60000
        );
        const nextValidEta = getNextValidBusETA(etaList, readyTime, now);

        resetSegmentTiming(segment, defaultFrequency);
        segment.readyTime = readyTime.toISOString();

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
                const historicalResult = validateSegmentHistoricalSchedule(segment, boardTime, schedule, {
                    requireObservedSlotMatch: true,
                });
                segment.historicalSchedule = historicalResult;
                if (!historicalResult.valid) return false;
                segment.timingFallbackReason = 'transfer_eta_unavailable_historical_schedule';
            }
            segment.activeEtaCount = getActiveEtas(etaList, now).filter(
                (eta) => new Date(eta.eta) >= readyTime
            ).length;
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

function applyLeaveTiming(route, departureTime) {
    let cursor = new Date(departureTime);

    for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        const waitMinutes = parseFrequencyMinutes(segment.routeInfo?.freq, i === 0 ? 15 : 12);
        const readyTime = new Date(
            cursor.getTime() + (getLegApproachMinutes(route, i) + BOARDING_BUFFER_MIN) * 60000
        );
        const boardTime = new Date(readyTime.getTime() + waitMinutes * 60000);
        const arrivalTime = new Date(
            boardTime.getTime() + getRideDurationMinutes(segment) * 60000
        );

        resetSegmentTiming(segment, waitMinutes);
        segment.readyTime = readyTime.toISOString();
        segment.boardTime = boardTime.toISOString();
        segment.arrivalTime = arrivalTime.toISOString();
        segment.waitMinutes = waitMinutes;

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

function applyArriveTiming(route, arrivalDeadline, now) {
    let cursor = new Date(arrivalDeadline.getTime() - (route.walkTimeDest || 0) * 60000);
    let firstLegWait = 0;

    for (let i = route.segments.length - 1; i >= 0; i--) {
        const segment = route.segments[i];
        const waitMinutes = parseFrequencyMinutes(segment.routeInfo?.freq, i === 0 ? 15 : 12);
        const arrivalTime = new Date(cursor);
        const boardTime = new Date(
            arrivalTime.getTime() - getRideDurationMinutes(segment) * 60000
        );
        const readyTime = new Date(boardTime.getTime() - waitMinutes * 60000);
        const previousCursor = new Date(
            readyTime.getTime() - (getLegApproachMinutes(route, i) + BOARDING_BUFFER_MIN) * 60000
        );

        resetSegmentTiming(segment, waitMinutes);
        segment.readyTime = readyTime.toISOString();
        segment.boardTime = boardTime.toISOString();
        segment.arrivalTime = arrivalTime.toISOString();
        segment.waitMinutes = waitMinutes;

        if (i === 0) firstLegWait = waitMinutes;
        cursor = previousCursor;
    }

    route.originWaitTime = firstLegWait;
    route.estimatedTime = Math.round(
        (arrivalDeadline.getTime() - cursor.getTime()) / 60000
    );
    route.plannedDepartureTime = cursor.toISOString();
    route.plannedArrivalTime = arrivalDeadline.toISOString();
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
    } = options;
    route.originWaitTime = 0;

    if (timeMode === 'now') {
        return applyNowTiming(route, now, { allowNoEta: allowNoEtaNow });
    }

    const plannedAnchorTime = buildPlannedDateTime(dateValue, timeValue, now);
    let isValid = false;
    if (timeMode === 'leave') {
        isValid = applyLeaveTiming(route, plannedAnchorTime);
    } else {
        isValid = applyArriveTiming(route, plannedAnchorTime, now);
    }

    if (!isValid) return false;
    return validateRouteHistoricalSchedule(route, {
        allowSparseDataFallback: allowSparseHistoricalFallback,
        requestedDateTime: plannedAnchorTime,
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
    const schedule = await loadKmbOperationSchedule();
    if (!schedule) return { candidates, rejectedCount: 0 };

    const plannedAnchorTime = buildPlannedDateTime(options.dateValue, options.timeValue, options.now);
    const retained = [];
    for (const route of candidates) {
        applyStraightLineWalkingEstimate(route);
        const timingValid = options.timeMode === 'leave'
            ? applyLeaveTiming(route, plannedAnchorTime)
            : applyArriveTiming(route, plannedAnchorTime, options.now);
        if (!timingValid) continue;
        const historicalValid = await validateRouteHistoricalSchedule(route, {
            allowSparseDataFallback: options.allowSparseHistoricalFallback,
            requestedDateTime: plannedAnchorTime,
            logValidation: false,
        });
        if (historicalValid || !isDefinitiveEarlyHistoricalRejection(route)) retained.push(route);
    }
    return { candidates: retained, rejectedCount: candidates.length - retained.length };
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

function shouldLogPlanningDebug() {
    try {
        const hostname = String(window?.location?.hostname || '').toLowerCase();
        return hostname === 'localhost' || hostname === '127.0.0.1' ||
            window?.localStorage?.getItem('kmbPlanningDebug') === '1';
    } catch {
        return false;
    }
}

function compareRouteCandidates(a, b) {
    const confidenceDelta = (b.historicalConfidenceScore || 0) - (a.historicalConfidenceScore || 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    const estimatedTimeDelta = a.estimatedTime - b.estimatedTime;
    if (Math.abs(estimatedTimeDelta) > 5) return estimatedTimeDelta;
    if (a.transfers !== b.transfers) return a.transfers - b.transfers;
    return ((a.walkTimeOrigin || 0) + (a.walkTimeDest || 0)) -
        ((b.walkTimeOrigin || 0) + (b.walkTimeDest || 0));
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// MAIN ROUTE FINDER ??Bidirectional
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
async function findRoutes(params) {
    const { originLoc, destLoc, stopMap, routeMap, routeStops, stopRoutes, timeMode, dateValue, timeValue, excludedRoutesText, strictEtaOnly = true, allowSparseHistoricalFallback = false, gcpKey, onProgress } = params;
    const planningStartedAt = Date.now();
    const requestStatsBefore = requestStatsSnapshot();
    const stageTimings = {};
    let stageStartedAt = planningStartedAt;
    const finishStage = (name) => {
        const now = Date.now();
        stageTimings[name] = now - stageStartedAt;
        stageStartedAt = now;
    };

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

    // ?€?€ Build ORIGIN ROUTE SET
    // routeKey ??{ oStop, oIdx, stops, route }  (best = closest origin stop)
    const originRouteSet = new Map();
    for (const oStop of originStops) {
        for (const r of (stopRoutes[oStop.id] || [])) {
            if (excludedRoutes.has(r.route.toUpperCase())) continue;

            const key = `${r.route}|${r.bound}|${r.service_type}`;
            const stops = routeStops[key] || [];
            const idx = stops.indexOf(oStop.id);
            if (idx === -1) continue;
            if (!originRouteSet.has(key) || originRouteSet.get(key).oStop.distance > oStop.distance)
                originRouteSet.set(key, { oStop, oIdx: idx, stops, route: r, routeKey: key });
        }
    }

    // ?€?€ Build DEST ROUTE SET
    // routeKey ??{ dStop, dIdx, stops, route }  (best = closest dest stop)
    const destRouteSet = new Map();
    for (const dStop of destStops) {
        for (const r of (stopRoutes[dStop.id] || [])) {
            if (excludedRoutes.has(r.route.toUpperCase())) continue;

            const key = `${r.route}|${r.bound}|${r.service_type}`;
            const stops = routeStops[key] || [];
            const idx = stops.indexOf(dStop.id);
            if (idx === -1) continue;
            if (!destRouteSet.has(key) || destRouteSet.get(key).dStop.distance > dStop.distance)
                destRouteSet.set(key, { dStop, dIdx: idx, stops, route: r, routeKey: key });
        }
    }

    // ?€?€ Build DEST STOP INDEX
    // For every stop that appears BEFORE the dest stop on any dest-set route,
    // map stopId ??[{ routeKey, dIdx, dStop, route }]
    // This is what makes fast 1-transfer matching possible.
    const destStopIndex = new Map(); // stopId ??[destRouteEntry]
    for (const [key, dest] of destRouteSet) {
        for (let i = 0; i < dest.dIdx; i++) {
            const sid = dest.stops[i];
            if (!destStopIndex.has(sid)) destStopIndex.set(sid, []);
            destStopIndex.get(sid).push({ ...dest, transferIdx: i });
        }
    }

    const found = [];
    const dedupSeen = new Set();
    const foundByDedupKey = new Map();

    // ?€?€ DIRECT routes (ORIGIN ??DEST, same routeKey, oIdx < dIdx) 
    onProgress?.('Finding direct routes...');
    for (const [key, orig] of originRouteSet) {
        if (!destRouteSet.has(key)) continue;
        const dest = destRouteSet.get(key);
        if (orig.oIdx >= dest.dIdx) continue; // going wrong way

        const segStops = orig.stops.slice(orig.oIdx, dest.dIdx + 1);
        const dk = `direct|${key}`;
        if (dedupSeen.has(dk)) continue;
        dedupSeen.add(dk);

        found.push({
            id: `d-${found.length}`, transfers: 0,
            totalStops: segStops.length, dedupKey: dk,
            segments: [{ route: orig.route.route, bound: orig.route.bound, service_type: orig.route.service_type, routeKey: key, fromStop: orig.oStop.id, toStop: dest.dStop.id, stops: segStops, routeInfo: routeMap[key] }],
            originLoc, destLoc,
            oLat: orig.oStop.lat, oLng: orig.oStop.lng, oDist: orig.oStop.distance,
            dLat: dest.dStop.lat, dLng: dest.dStop.lng, dDist: dest.dStop.distance,
        });
        foundByDedupKey.set(dk, found[found.length - 1]);
    }

    // ?€?€ 1-TRANSFER routes
    // For each origin route, walk its stops forward. For each stop, check its
    // neighbors in the spatial grid. If any neighbor's stopId is in destStopIndex,
    // we found a valid transfer.
    onProgress?.('Finding 1-transfer routes...');
    for (const [r1Key, orig] of originRouteSet) {
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

                    const seg1Stops = orig.stops.slice(orig.oIdx, i + 1);
                    const seg2Stops = dest.stops.slice(dest.transferIdx, dest.dIdx + 1);
                    const dk = `1t|${r1Key}->${dest.routeKey}`;

                    // Only keep one candidate per route-pair; pick best by heuristic
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
                        }
                        continue;
                    }
                    dedupSeen.add(dk);

                    found.push({
                        id: `t1-${found.length}`, transfers: 1,
                        totalStops: seg1Stops.length + seg2Stops.length,
                        dedupKey: dk, _hScore: hScore,
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

    // ?€?€ 2-TRANSFER routes
    // Seed from 1-transfer results. At the dropoff of seg2, look for a 3rd leg
    // that reaches the destination. Same grid trick.
    onProgress?.('Finding 2-transfer routes...');
    const oneTransfers = found.filter(f => f.transfers === 1);
    for (const parent of oneTransfers.slice(0, 40)) { // cap seeds, not exploration
        const seg2 = parent.segments[1];
        const dropStop = stopMap[seg2.toStop];
        if (!dropStop) continue;

        const nearby3 = nearbyFromGrid(grid, dropStop.lat, dropStop.lng, TRANSFER_WALK_KM);
        for (const nb3 of nearby3) {
            const destMatches3 = destStopIndex.get(nb3.id) || [];
            for (const dest3 of destMatches3) {
                if (dest3.routeKey === seg2.routeKey) continue;

                const seg3Stops = dest3.stops.slice(dest3.transferIdx, dest3.dIdx + 1);
                const dk = `2t|${parent.segments[0].routeKey}->${parent.segments[1].routeKey}->${dest3.routeKey}`;
                if (dedupSeen.has(dk)) continue;
                dedupSeen.add(dk);

                found.push({
                    id: `t2-${found.length}`, transfers: 2,
                    totalStops: parent.totalStops + seg3Stops.length,
                    dedupKey: dk,
                    segments: [
                        ...parent.segments,
                        { route: dest3.route.route, bound: dest3.route.bound, service_type: dest3.route.service_type, routeKey: dest3.routeKey, fromStop: nb3.id, toStop: dest3.dStop.id, stops: seg3Stops, routeInfo: routeMap[dest3.routeKey] },
                    ],
                    originLoc, destLoc,
                    oLat: parent.oLat, oLng: parent.oLng, oDist: parent.oDist,
                    dLat: dest3.dStop.lat, dLng: dest3.dStop.lng, dDist: dest3.dStop.distance,
                    t1Lat: parent.t1Lat, t1Lng: parent.t1Lng,
                    t2Lat: parent.t2Lat, t2Lng: parent.t2Lng,
                    t3Lat: dropStop.lat, t3Lng: dropStop.lng,
                    t4Lat: nb3.lat, t4Lng: nb3.lng,
                });
                foundByDedupKey.set(dk, found[found.length - 1]);
            }
        }
    }

    for (const route of found) {
        for (const segment of route.segments || []) {
            annotateHistoricalSegmentContext(segment, routeStops, stopMap);
        }
    }

    // ?€?€ Initial heuristic sort (to prioritize for GCP/ETA enrichments)
    found.sort((a, b) => {
        // Drastically reduce stop penalty: a highway route with 5 stops vs an express route with 25 stops 
        // often take the same time. The real penalty should be transfers and walking distance.
        const score = f => f.totalStops * 0.1 + f.transfers * 15 + ((f.oDist || 0) + (f.dDist || 0)) * 20;
        return score(a) - score(b);
    });

    // Take top 200 unique candidates for GCP + ETA enrichment
    const seenForGCP = new Set();
    const originRouteCount = new Map();
    const candidates = [];
    for (const c of found) {
        if (!seenForGCP.has(c.dedupKey)) {
            const origR = c.segments[0].routeKey || c.segments[0].route;
            const count = originRouteCount.get(origR) || 0;

            // Limit to max 6 unique combinations originating from the same bus line
            if (count < 6) {
                seenForGCP.add(c.dedupKey);
                originRouteCount.set(origR, count + 1);
                candidates.push(c);
                if (candidates.length >= 200) break;
            }
        }
    }

    // ?€?€ Parallel GCP walking times
    finishStage('candidateGeneration');
    const now = new Date();
    const earlyFilter = await earlyFilterPlannedCandidates(candidates, {
        timeMode,
        dateValue,
        timeValue,
        now,
        allowSparseHistoricalFallback,
    });
    const earlyNowFilter = timeMode === 'now'
        ? await earlyFilterNowCandidates(earlyFilter.candidates, now, strictEtaOnly)
        : { candidates: earlyFilter.candidates, rejectedCount: 0 };
    const networkCandidates = earlyNowFilter.candidates;
    finishStage('earlyServiceFilter');

    onProgress?.('Calculating walking times...');
    await Promise.all(networkCandidates.map(async route => {
        const [wO, wD] = await Promise.all([
            fetchGCPRoute(originLoc.lat, originLoc.lng, route.oLat, route.oLng, 'walking', [], gcpKey),
            fetchGCPRoute(route.dLat, route.dLng, destLoc.lat, destLoc.lng, 'walking', [], gcpKey),
        ]);
        route.walkInfoOrigin = wO; route.walkTimeOrigin = wO.duration;
        route.walkInfoDest = wD; route.walkTimeDest = wD.duration;
        route.walkTimeTransfer = 0; route.walkTimeTransfer2 = 0;

        if (route.transfers >= 1) {
            const tw = await fetchGCPRoute(route.t1Lat, route.t1Lng, route.t2Lat, route.t2Lng, 'walking', [], gcpKey);
            route.walkInfoTransfer = tw; route.walkTimeTransfer = tw.duration;
        }
        if (route.transfers >= 2) {
            const tw2 = await fetchGCPRoute(route.t3Lat, route.t3Lng, route.t4Lat, route.t4Lng, 'walking', [], gcpKey);
            route.walkInfoTransfer2 = tw2; route.walkTimeTransfer2 = tw2.duration;
        }
    }));
    finishStage('walkingEnrichment');

    // ?€?€ ETA filter + accurate time calculation
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
        });
        if (isValid) filteredCandidates.push(route);
    }));
    finishStage('serviceValidation');

    // ?€?€ Final sort: time ??transfers ??walk
    if (filteredCandidates.length > 0) {
        onProgress?.('Refining in-vehicle bus time...');
        const plannedAnchorTime = buildPlannedDateTime(dateValue, timeValue, now);
        await enrichGoogleRideDurations(filteredCandidates, stopMap, {
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
    const finalCandidates = filteredCandidates.slice(0, MAX_FINAL);
    const slowestStep = Object.entries(stageTimings)
        .sort((a, b) => b[1] - a[1])[0] || ['none', 0];
    LAST_PLANNING_DEBUG_SUMMARY = {
        timeMode,
        totalMs: Date.now() - planningStartedAt,
        stagesMs: stageTimings,
        slowestStep: { name: slowestStep[0], durationMs: slowestStep[1] },
        candidatesGenerated: found.length,
        candidatesShortlisted: candidates.length,
        earlyHistoricalRejected: earlyFilter.rejectedCount,
        earlyLiveEtaRejected: earlyNowFilter.rejectedCount,
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
    clearEtaCallLog,
    getEtaCallLog,
    formatEtaCallLogTxt,
    getActiveEtas,
    getNextValidBusETA,
    applyRouteTiming,
    validateSegmentHistoricalSchedule,
    compareRouteCandidates,
    getLastPlanningDebugSummary,
    STRICT_STOP_LEVEL_ROUTES,
};

