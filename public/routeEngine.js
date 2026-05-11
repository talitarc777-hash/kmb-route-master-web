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
const RIDE_TIME_CACHE_BUCKET_MS = 30 * 60 * 1000;
const GCP_CACHE = new Map(); // in-memory promise cache
const GCP_CACHE_STORAGE_KEY = 'kmb_gcp_route_cache_v1';
const GCP_CACHE_MAX_ENTRIES = 180;
const GCP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let GCP_PERSISTED_CACHE = null;

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
    const grid = new Map();
    for (const [id, s] of Object.entries(stopMap)) {
        const gx = Math.floor(s.lat / GRID_DEG);
        const gy = Math.floor(s.lng / GRID_DEG);
        const k = `${gx},${gy}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ id, ...s });
    }
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
    if (GCP_CACHE.has(cacheKey)) return GCP_CACHE.get(cacheKey);
    const cache = loadPersistedGcpCache();
    const hit = cache.get(cacheKey);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
        cache.delete(cacheKey);
        savePersistedGcpCache(cache);
        return null;
    }
    const resolved = Promise.resolve(hit.value);
    GCP_CACHE.set(cacheKey, resolved);
    return resolved;
}

function setGcpCachedValue(cacheKey, value, ttlMs = GCP_CACHE_TTL_MS) {
    const cache = loadPersistedGcpCache();
    cache.set(cacheKey, {
        value,
        savedAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
    });
    savePersistedGcpCache(cache);
}

async function fetchGCPRoute(lat1, lng1, lat2, lng2, mode = 'walking', intermediateStops = [], _gcpKey) {
    const wpSig = getWaypointSignature(intermediateStops);
    const cacheKey = `${mode}|${lat1.toFixed(4)},${lng1.toFixed(4)}->${lat2.toFixed(4)},${lng2.toFixed(4)}|${wpSig}`;
    const cached = getGcpCachedValue(cacheKey);
    if (cached) return cached;

    const promise = (async () => {
        try {
            let wpStr = '';
            if (intermediateStops.length > 0) {
                let s = intermediateStops.length > 23
                    ? Array.from({ length: 23 }, (_, i) => intermediateStops[Math.floor(i * intermediateStops.length / 23)])
                    : intermediateStops;
                wpStr = '&waypoints=' + s.map(p => `${p.lat},${p.lng}`).join('%7C');
            }
            const url = toApiUrl(`/api/google/directions/json?origin=${lat1},${lng1}&destination=${lat2},${lng2}&mode=${mode}${wpStr}`);
            const data = await (await fetch(url)).json();
            if (data.status === 'OK' && data.routes.length > 0) {
                const r = data.routes[0];
                const out = {
                    distance: r.legs.reduce((s, l) => s + l.distance.value, 0),
                    duration: Math.ceil(r.legs.reduce((s, l) => s + l.duration.value, 0) / 60),
                    geometry: decodePolyline(r.overview_polyline.points),
                };
                setGcpCachedValue(cacheKey, out);
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

    GCP_CACHE.set(cacheKey, promise);
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
    if (ETA_CACHE.has(key)) {
        logEtaCall({ type: 'cache_hit', key, stopId, route, serviceType });
        return ETA_CACHE.get(key);
    }
    const p = (async () => {
        const startedAt = Date.now();
        const url = `https://data.etabus.gov.hk/v1/transport/kmb/eta/${stopId}/${route}/${serviceType}`;
        try {
            const data = await (await fetch(url)).json();
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
    ETA_CACHE.set(key, p);
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

    GCP_CACHE.set(cacheKey, promise);
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
}

async function applyNowTiming(route, now, options = {}) {
    const { allowNoEta = false } = options;
    let cursor = new Date(now);

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
            if (!allowNoEta) return false;
            const boardTime = new Date(readyTime.getTime() + defaultFrequency * 60000);
            const arrivalTime = new Date(
                boardTime.getTime() + getRideDurationMinutes(segment) * 60000
            );
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
    } = options;
    route.originWaitTime = 0;

    if (timeMode === 'now') {
        return applyNowTiming(route, now, { allowNoEta: allowNoEtaNow });
    }

    const plannedAnchorTime = buildPlannedDateTime(dateValue, timeValue, now);
    if (timeMode === 'leave') {
        return applyLeaveTiming(route, plannedAnchorTime);
    }

    return applyArriveTiming(route, plannedAnchorTime, now);
}

// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
// MAIN ROUTE FINDER ??Bidirectional
// ?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€?€
async function findRoutes(params) {
    const { originLoc, destLoc, stopMap, routeMap, routeStops, stopRoutes, timeMode, dateValue, timeValue, excludedRoutesText, strictEtaOnly = true, gcpKey, onProgress } = params;
    clearETACache();

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

    // ?€?€ DIRECT routes (ORIGIN ??DEST, same routeKey, oIdx < dIdx) 
    onProgress?.('Finding direct routes...');
    for (const [key, orig] of originRouteSet) {
        if (!destRouteSet.has(key)) continue;
        const dest = destRouteSet.get(key);
        if (orig.oIdx >= dest.dIdx) continue; // going wrong way

        const segStops = orig.stops.slice(orig.oIdx, dest.dIdx + 1);
        const dk = `direct|${orig.route.route}`;
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
                    const dk = `1t|${orig.route.route}->${dest.route.route}`;

                    // Only keep one candidate per route-pair; pick best by heuristic
                    const hScore = seg1Stops.length * RIDE_MIN_PER_STOP + seg2Stops.length * RIDE_MIN_PER_STOP
                        + orig.oStop.distance * 12 + dest.dStop.distance * 12 + nb.distance * 10;

                    if (dedupSeen.has(dk)) {
                        // Replace if better score
                        const existing = found.find(f => f.dedupKey === dk);
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
                const dk = `2t|${parent.segments[0].route}->${parent.segments[1].route}->${dest3.route.route}`;
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
            }
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
            const origR = c.segments[0].route;
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
    onProgress?.('Calculating walking times...');
    await Promise.all(candidates.map(async route => {
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

    // ?€?€ ETA filter + accurate time calculation
    onProgress?.('Checking scheduled services...');
    const now = new Date();
    const filteredCandidates = [];

    await Promise.all(candidates.map(async route => {
        const isValid = await applyRouteTiming(route, {
            timeMode,
            dateValue,
            timeValue,
            now,
            allowNoEtaNow: !strictEtaOnly,
        });
        if (isValid) filteredCandidates.push(route);
    }));

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
            });
            if (isValid) refinedCandidates.push(route);
        }));

        filteredCandidates.length = 0;
        filteredCandidates.push(...refinedCandidates);
    }

    filteredCandidates.sort((a, b) => {
        const dt = a.estimatedTime - b.estimatedTime;
        if (Math.abs(dt) > 5) return dt;
        if (a.transfers !== b.transfers) return a.transfers - b.transfers;
        return ((a.walkTimeOrigin || 0) + (a.walkTimeDest || 0)) - ((b.walkTimeOrigin || 0) + (b.walkTimeDest || 0));
    });

    return { filteredCandidates: filteredCandidates.slice(0, MAX_FINAL), originStops, destStops };
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
};

