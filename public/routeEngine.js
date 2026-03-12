/**
 * KMB Route Engine — Bidirectional Search with Spatial Grid
 *
 * Algorithm:
 *  1. Build a spatial grid of all stops (O(1) neighbor lookups)
 *  2. Build ORIGIN SET — routes departing from within 600m of origin
 *  3. Build DEST SET   — routes arriving  at  stops within 600m of dest
 *  4. Direct routes    — set intersection (ORIGIN SET ∩ DEST SET, same route)
 *  5. 1-Transfer       — for each origin route, scan forward stops;
 *                        check the spatial grid for dest-set routes nearby
 *  6. 2-Transfer       — extend 1-transfer dropoffs using the same approach
 *  7. Rank & dedup     — by (estimatedTime, transfers, walk)
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────
const WALK_RADIUS_KM = 0.6;   // walk from origin/dest to bus stop
const TRANSFER_WALK_KM = 0.6;   // walk between transfer stops
const MAX_FINAL = 100;   // results shown to user (increased for debugging)
const RIDE_MIN_PER_STOP = 1.5;  // minutes per bus stop
const GRID_DEG = 0.005; // spatial grid cell ≈ 500m
const GCP_CACHE = new Map();

// ─────────────────────────────────────────────────────────────────────
// MATH
// ─────────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─────────────────────────────────────────────────────────────────────
// SPATIAL GRID  — build once per search, reuse for all lookups
// ─────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────
// GCP ROUTE FETCH (with caching)
// ─────────────────────────────────────────────────────────────────────
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

async function fetchGCPRoute(lat1, lng1, lat2, lng2, mode = 'walking', intermediateStops = [], gcpKey) {
    const cacheKey = `${lat1.toFixed(4)},${lng1.toFixed(4)}→${lat2.toFixed(4)},${lng2.toFixed(4)}|${mode}`;
    if (GCP_CACHE.has(cacheKey)) return GCP_CACHE.get(cacheKey);

    const promise = (async () => {
        try {
            let wpStr = '';
            if (intermediateStops.length > 0) {
                let s = intermediateStops.length > 23
                    ? Array.from({ length: 23 }, (_, i) => intermediateStops[Math.floor(i * intermediateStops.length / 23)])
                    : intermediateStops;
                wpStr = '&waypoints=' + s.map(p => `${p.lat},${p.lng}`).join('%7C');
            }
            const url = `/api/google/directions/json?origin=${lat1},${lng1}&destination=${lat2},${lng2}&mode=${mode}${wpStr}&key=${gcpKey}`;
            const data = await (await fetch(url)).json();
            if (data.status === 'OK' && data.routes.length > 0) {
                const r = data.routes[0];
                return {
                    distance: r.legs.reduce((s, l) => s + l.distance.value, 0),
                    duration: Math.ceil(r.legs.reduce((s, l) => s + l.duration.value, 0) / 60),
                    geometry: decodePolyline(r.overview_polyline.points)
                };
            }
            console.warn(`GCP ${mode}:`, data.status);
        } catch (e) { console.warn(`GCP ${mode} error:`, e); }
        const d = haversine(lat1, lng1, lat2, lng2);
        return { distance: d * 1000, duration: Math.ceil(d / (mode === 'walking' ? 4 : 30) * 60), geometry: [[lng1, lat1], [lng2, lat2]] };
    })();

    GCP_CACHE.set(cacheKey, promise);
    return promise;
}

// ─────────────────────────────────────────────────────────────────────
// ETA FETCH (per-search cache)
// ─────────────────────────────────────────────────────────────────────
const ETA_CACHE = new Map();

async function fetchETA(stopId, route, serviceType) {
    const key = `${stopId}|${route}|${serviceType}`;
    if (ETA_CACHE.has(key)) return ETA_CACHE.get(key);
    const p = (async () => {
        // try { return (await (await fetch(`/api/kmb/eta/${stopId}/${route}/${serviceType}`)).json()).data || []; }
        try { return (await (await fetch(`https://data.etabus.gov.hk/v1/transport/kmb/eta/${stopId}/${route}/${serviceType}`)).json()).data || []; }
        catch { return []; }
    })();
    ETA_CACHE.set(key, p);
    return p;
}

function clearETACache() { ETA_CACHE.clear(); }

// ─────────────────────────────────────────────────────────────────────
// MAIN ROUTE FINDER — Bidirectional
// ─────────────────────────────────────────────────────────────────────
async function findRoutes(params) {
    const { originLoc, destLoc, stopMap, routeMap, routeStops, stopRoutes, timeMode, dateValue, timeValue, excludedRoutesText, gcpKey, onProgress } = params;
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

    // ── Build ORIGIN ROUTE SET
    // routeKey → { oStop, oIdx, stops, route }  (best = closest origin stop)
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

    // ── Build DEST ROUTE SET
    // routeKey → { dStop, dIdx, stops, route }  (best = closest dest stop)
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

    // ── Build DEST STOP INDEX
    // For every stop that appears BEFORE the dest stop on any dest-set route,
    // map stopId → [{ routeKey, dIdx, dStop, route }]
    // This is what makes fast 1-transfer matching possible.
    const destStopIndex = new Map(); // stopId → [destRouteEntry]
    for (const [key, dest] of destRouteSet) {
        for (let i = 0; i < dest.dIdx; i++) {
            const sid = dest.stops[i];
            if (!destStopIndex.has(sid)) destStopIndex.set(sid, []);
            destStopIndex.get(sid).push({ ...dest, transferIdx: i });
        }
    }

    const found = [];
    const dedupSeen = new Set();

    // ── DIRECT routes (ORIGIN ∩ DEST, same routeKey, oIdx < dIdx) 
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

    // ── 1-TRANSFER routes
    // For each origin route, walk its stops forward. For each stop, check its
    // neighbors in the spatial grid. If any neighbor's stopId is in destStopIndex,
    // we found a valid transfer.
    onProgress?.('Finding 1-transfer routes...');
    for (const [r1Key, orig] of originRouteSet) {
        for (let i = orig.oIdx + 1; i < orig.stops.length; i++) {
            const transferStopId = orig.stops[i];
            const transferStop = stopMap[transferStopId];
            if (!transferStop) continue;

            // Find nearby stops — use grid for speed
            const nearby = nearbyFromGrid(grid, transferStop.lat, transferStop.lng, TRANSFER_WALK_KM);

            for (const nb of nearby) {
                // Check if this nearby stop is a valid boarding point for any dest-set route
                const destMatches = destStopIndex.get(nb.id) || [];
                for (const dest of destMatches) {
                    if (dest.routeKey === r1Key) continue; // avoid same route transfer

                    const seg1Stops = orig.stops.slice(orig.oIdx, i + 1);
                    const seg2Stops = dest.stops.slice(dest.transferIdx, dest.dIdx + 1);
                    const dk = `1t|${orig.route.route}→${dest.route.route}`;

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

    // ── 2-TRANSFER routes
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
                const dk = `2t|${parent.segments[0].route}→${parent.segments[1].route}→${dest3.route.route}`;
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

    // ── Initial heuristic sort (to prioritize for GCP/ETA enrichments)
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

    // ── Parallel GCP walking times
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

    // ── ETA filter + accurate time calculation
    onProgress?.('Checking scheduled services...');
    const now = new Date();
    const filteredCandidates = [];

    await Promise.all(candidates.map(async route => {
        const etaResults = await Promise.all(
            route.segments.map(seg => fetchETA(seg.fromStop, seg.route, seg.service_type))
        );

        // Attach ETAs and intervals to segments so UI can show them immediately
        route.segments.forEach((seg, i) => {
            const etasForSeg = etaResults[i] || [];
            const future = etasForSeg.filter(e => e.eta && new Date(e.eta) > now);
            if (future.length > 0) seg.nextEta = future[0].eta;
            seg.busInterval = parseFloat(seg.routeInfo?.freq) || null;
        });

        const firstETAs = etaResults[0];
        // Discard ONLY if the API returned an entirely empty array
        // (route does not serve this stop in this direction at all).
        // Records with eta=null mean the route IS scheduled but has no
        // current real-time GPS data — keep these.
        if (firstETAs.length === 0) return;

        const futureETAs = firstETAs.filter(e => e.eta && new Date(e.eta) > now);

        // Determine wait
        let waitTime;
        if (timeMode === 'now') {
            if (futureETAs.length > 0) {
                waitTime = Math.max(0, (new Date(futureETAs[0].eta) - now) / 60000);
            } else {
                // No real-time data — use scheduled frequency as wait estimate
                waitTime = parseFloat(route.segments[0].routeInfo?.freq) || 15;
            }
        } else {
            waitTime = parseFloat(route.segments[0].routeInfo?.freq) || 15;
        }

        // Bump wait if we can't make the first bus in time
        if (waitTime < route.walkTimeOrigin) {
            waitTime = route.walkTimeOrigin + (parseFloat(route.segments[0].routeInfo?.freq) || 15);
        }

        let totalTime = route.walkTimeOrigin + waitTime + route.segments[0].stops.length * RIDE_MIN_PER_STOP;
        for (let i = 1; i < route.segments.length; i++) {
            const xwalk = i === 1 ? route.walkTimeTransfer : route.walkTimeTransfer2;
            const xwait = parseFloat(route.segments[i].routeInfo?.freq) || 12;
            totalTime += (xwalk || 0) + xwait + route.segments[i].stops.length * RIDE_MIN_PER_STOP;
        }
        totalTime += route.walkTimeDest;

        route.estimatedTime = Math.round(totalTime);
        route.originWaitTime = Math.round(waitTime);
        filteredCandidates.push(route);
    }));

    // ── Final sort: time → transfers → walk
    filteredCandidates.sort((a, b) => {
        const dt = a.estimatedTime - b.estimatedTime;
        if (Math.abs(dt) > 5) return dt;
        if (a.transfers !== b.transfers) return a.transfers - b.transfers;
        return ((a.walkTimeOrigin || 0) + (a.walkTimeDest || 0)) - ((b.walkTimeOrigin || 0) + (b.walkTimeDest || 0));
    });

    return { filteredCandidates: filteredCandidates.slice(0, MAX_FINAL), originStops, destStops };
}

// ─────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────
window.routeEngine = { findRoutes, fetchETA, fetchGCPRoute, clearETACache };

