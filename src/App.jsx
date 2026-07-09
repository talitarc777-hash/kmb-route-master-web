import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { publishApiBaseUrl, toApiUrl } from './utils/apiBase.js';

publishApiBaseUrl();

// Constants
const ROUTE_COLORS = [
  '#E1251B',
  '#2563EB',
  '#16A34A',
  '#D97706',
  '#9333EA',
  '#DB2777',
  '#0891B2',
  '#65A30D',
];

const GCP_CACHE_LIMIT = 200;
const GCP_GEOCODE_CACHE_KEY = 'kmb_gcp_geocode_cache_v1';
const GCP_AUTOCOMPLETE_CACHE_KEY = 'kmb_gcp_autocomplete_cache_v1';
const GCP_TRANSIT_GAP_CACHE_KEY = 'kmb_gcp_transit_gap_cache_v1';
const STATIC_OPERATOR_FARE_CACHE_KEY = 'kmb_static_operator_fare_cache_v1';
const CSDI_ROUTE_GEOMETRY_CACHE_KEY = 'kmb_csdi_route_geometry_cache_v1';
const GCP_GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GCP_AUTOCOMPLETE_TTL_MS = 12 * 60 * 60 * 1000;
const GCP_TRANSIT_GAP_TTL_MS = 15 * 60 * 1000;
const STATIC_OPERATOR_FARE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const CSDI_ROUTE_GEOMETRY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const ARCGIS_JS_URL = 'https://js.arcgis.com/4.29/';
const CSDI_BUS_ROUTE_QUERY_URL =
  'https://portal.csdi.gov.hk/server/rest/services/common/' +
  'td_rcd_1638844988873_41214/FeatureServer/0/query';

let arcgisApiPromise = null;

function loadArcGISApi() {
  if (window.require) return Promise.resolve(window.require);
  if (arcgisApiPromise) return arcgisApiPromise;

  arcgisApiPromise = new Promise((resolve, reject) => {
    const existingScript = Array.from(document.scripts).find((script) =>
      script.src === ARCGIS_JS_URL || script.src === `${ARCGIS_JS_URL}init.js`,
    );
    const script = existingScript || document.createElement('script');

    const handleLoad = () => {
      if (window.require) resolve(window.require);
      else reject(new Error('ArcGIS API loaded without window.require.'));
    };

    script.addEventListener('load', handleLoad, { once: true });
    script.addEventListener('error', () => reject(new Error('ArcGIS API failed to load.')), { once: true });

    if (!existingScript) {
      script.src = ARCGIS_JS_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });

  return arcgisApiPromise;
}

const geocodeCacheState = {
  memory: new Map(),
  inflight: new Map(),
  persisted: null,
  storageKey: GCP_GEOCODE_CACHE_KEY,
  ttlMs: GCP_GEOCODE_TTL_MS,
};

const autocompleteCacheState = {
  memory: new Map(),
  inflight: new Map(),
  persisted: null,
  storageKey: GCP_AUTOCOMPLETE_CACHE_KEY,
  ttlMs: GCP_AUTOCOMPLETE_TTL_MS,
};

const transitGapCacheState = {
  memory: new Map(),
  inflight: new Map(),
  persisted: null,
  storageKey: GCP_TRANSIT_GAP_CACHE_KEY,
  ttlMs: GCP_TRANSIT_GAP_TTL_MS,
};

const staticOperatorFareCacheState = {
  memory: new Map(),
  inflight: new Map(),
  persisted: null,
  storageKey: STATIC_OPERATOR_FARE_CACHE_KEY,
  ttlMs: STATIC_OPERATOR_FARE_TTL_MS,
};

const csdiRouteGeometryCacheState = {
  memory: new Map(),
  inflight: new Map(),
  persisted: null,
  storageKey: CSDI_ROUTE_GEOMETRY_CACHE_KEY,
  ttlMs: CSDI_ROUTE_GEOMETRY_TTL_MS,
};

function loadGcpCache(state) {
  if (state.persisted) return state.persisted;
  state.persisted = new Map();
  try {
    const raw = localStorage.getItem(state.storageKey);
    if (!raw) return state.persisted;
    const rows = JSON.parse(raw);
    const now = Date.now();
    rows.forEach((row) => {
      if (!row?.key) return;
      if (!row.expiresAt || row.expiresAt <= now) return;
      state.persisted.set(row.key, row);
    });
  } catch {
    state.persisted = new Map();
  }
  return state.persisted;
}

function saveGcpCache(state) {
  try {
    const now = Date.now();
    const rows = Array.from(loadGcpCache(state).entries())
      .map(([key, row]) => ({ key, ...row }))
      .filter((row) => row.expiresAt > now)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, GCP_CACHE_LIMIT);
    localStorage.setItem(state.storageKey, JSON.stringify(rows));
  } catch {
    // Ignore quota/storage errors to avoid blocking UI.
  }
}

function getCachedGcpValue(state, key) {
  if (state.memory.has(key)) return state.memory.get(key);
  const cache = loadGcpCache(state);
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    saveGcpCache(state);
    return null;
  }
  state.memory.set(key, hit.value);
  return hit.value;
}

function setCachedGcpValue(state, key, value) {
  state.memory.set(key, value);
  const cache = loadGcpCache(state);
  cache.set(key, {
    value,
    savedAt: Date.now(),
    expiresAt: Date.now() + state.ttlMs,
  });
  saveGcpCache(state);
}

async function fetchGcpWithCache(state, key, fetcher) {
  const cached = getCachedGcpValue(state, key);
  if (cached) return cached;
  if (state.inflight.has(key)) return state.inflight.get(key);

  const request = (async () => {
    try {
      const value = await fetcher();
      if (value !== null && value !== undefined) setCachedGcpValue(state, key, value);
      return value;
    } finally {
      state.inflight.delete(key);
    }
  })();

  state.inflight.set(key, request);
  return request;
}

// Utility: Coordinate conversion
function hk80ToWgs84(x, y) {
  return {
    lat: 22.312133 + (y - 819069.8) / 111111,
    lng: 114.178556 + (x - 836694.05) / 102980,
  };
}

function wgs84ToHk80(lat, lng) {
  return {
    x: 836694.05 + (lng - 114.178556) * 102980,
    y: 819069.8 + (lat - 22.312133) * 111111,
  };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validCsdiCoordinate(point) {
  if (!Array.isArray(point) || point.length < 2) return null;
  const lng = Number(point[0]);
  const lat = Number(point[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < 21.5 || lat > 23.5 || lng < 113 || lng > 115.5) return null;
  return [lng, lat];
}

function stitchCsdiLineParts(geometry) {
  if (!geometry) return [];
  const rawParts = geometry.type === 'LineString'
    ? [geometry.coordinates]
    : geometry.type === 'MultiLineString'
      ? geometry.coordinates
      : [];
  const parts = rawParts
    .map((part) => (part || []).map(validCsdiCoordinate).filter(Boolean))
    .filter((part) => part.length >= 2);
  if (parts.length === 0) return [];

  const stitched = [...parts[0]];
  for (const originalPart of parts.slice(1)) {
    const currentEnd = stitched[stitched.length - 1];
    const startDistance = haversine(
      currentEnd[1],
      currentEnd[0],
      originalPart[0][1],
      originalPart[0][0],
    );
    const endDistance = haversine(
      currentEnd[1],
      currentEnd[0],
      originalPart[originalPart.length - 1][1],
      originalPart[originalPart.length - 1][0],
    );
    const part = endDistance < startDistance ? [...originalPart].reverse() : originalPart;
    stitched.push(...part);
  }
  return stitched;
}

function simplifyCsdiGeometry(geometry, minDistanceKm = 0.005) {
  if (geometry.length <= 2) return geometry;
  const simplified = [geometry[0]];
  for (let index = 1; index < geometry.length - 1; index += 1) {
    const previous = simplified[simplified.length - 1];
    const current = geometry[index];
    if (haversine(previous[1], previous[0], current[1], current[0]) >= minDistanceKm) {
      simplified.push(current);
    }
  }
  simplified.push(geometry[geometry.length - 1]);
  return simplified;
}

function sliceCsdiGeometry(geometry, startStop, endStop) {
  if (geometry.length < 2) return null;
  const endDistances = geometry.map(([lng, lat]) =>
    haversine(endStop.lat, endStop.lng, lat, lng));
  const suffixEnd = new Array(geometry.length);
  let nearestEnd = { index: geometry.length - 1, distance: endDistances[geometry.length - 1] };
  for (let index = geometry.length - 1; index >= 0; index -= 1) {
    if (endDistances[index] <= nearestEnd.distance) {
      nearestEnd = { index, distance: endDistances[index] };
    }
    suffixEnd[index] = nearestEnd;
  }

  let best = null;
  for (let startIndex = 0; startIndex < geometry.length - 1; startIndex += 1) {
    const [lng, lat] = geometry[startIndex];
    const startDistance = haversine(startStop.lat, startStop.lng, lat, lng);
    const end = suffixEnd[startIndex + 1];
    if (!end || end.index <= startIndex) continue;
    const score = startDistance + end.distance;
    if (!best || score < best.score) {
      best = {
        geometry: geometry.slice(startIndex, end.index + 1),
        score,
        startDistance,
        endDistance: end.distance,
      };
    }
  }
  return best;
}

function selectCsdiRouteGeometry(features, startStop, endStop, operator = 'KMB') {
  const requestedOperator = String(operator || 'KMB').toUpperCase();
  const candidates = (features || []).map((feature) => {
    const geometry = stitchCsdiLineParts(feature?.geometry);
    if (geometry.length < 2) return null;
    const sliced = sliceCsdiGeometry(geometry, startStop, endStop);
    if (!sliced) return null;
    const company = String(feature?.properties?.COMPANY_CODE || '').toUpperCase();
    const operatorMismatch = requestedOperator && !company.includes(requestedOperator);
    return {
      ...sliced,
      score: sliced.score,
      operatorMismatch,
    };
  }).filter(Boolean).sort((a, b) => a.score - b.score);

  const best = candidates.find((candidate) => !candidate.operatorMismatch);
  if (!best || best.startDistance > 1 || best.endDistance > 1) return null;
  return best.geometry;
}

function selectFullCsdiRouteGeometry(features, routeStops, operator = 'KMB') {
  const requestedOperator = String(operator || 'KMB').toUpperCase();
  const sampleCount = Math.min(12, routeStops.length);
  const sampledStops = Array.from({ length: sampleCount }, (_, index) => (
    routeStops[Math.round(index * (routeStops.length - 1) / Math.max(1, sampleCount - 1))]
  ));
  const candidates = (features || []).map((feature) => {
    const geometry = stitchCsdiLineParts(feature?.geometry);
    if (geometry.length < 2) return null;
    const company = String(feature?.properties?.COMPANY_CODE || '').toUpperCase();
    const operatorMismatch = requestedOperator && !company.includes(requestedOperator);
    const distances = sampledStops.map((stop) => geometry.reduce((nearest, [lng, lat]) => (
      Math.min(nearest, haversine(stop.lat, stop.lng, lat, lng))
    ), Infinity));
    return {
      geometry,
      operatorMismatch,
      score: distances.reduce((sum, distance) => sum + distance, 0) / distances.length,
      furthestStopDistance: Math.max(...distances),
    };
  }).filter(Boolean).sort((a, b) => a.score - b.score);

  const best = candidates.find((candidate) => !candidate.operatorMismatch);
  if (!best || best.furthestStopDistance > 1) return null;
  return best.geometry;
}

function compactCsdiRouteFeatures(features) {
  return (features || []).map((feature) => {
    const geometry = simplifyCsdiGeometry(stitchCsdiLineParts(feature?.geometry));
    if (geometry.length < 2) return null;
    return {
      type: 'Feature',
      properties: feature.properties || {},
      geometry: {
        type: 'LineString',
        coordinates: geometry,
      },
    };
  }).filter(Boolean);
}

function buildDirectCsdiRouteUrl(routeNumber) {
  const query = new URLSearchParams({
    f: 'geojson',
    where: `ROUTE_NAMEE='${routeNumber}'`,
    outFields: [
      'ROUTE_ID',
      'ROUTE_SEQ',
      'COMPANY_CODE',
      'ROUTE_NAMEE',
      'ST_STOP_ID',
      'ED_STOP_ID',
      'ST_STOP_NAMEE',
      'ED_STOP_NAMEE',
    ].join(','),
    returnGeometry: 'true',
    outSR: '4326',
    orderByFields: 'ROUTE_ID,ROUTE_SEQ',
  });
  return `${CSDI_BUS_ROUTE_QUERY_URL}?${query.toString()}`;
}

async function fetchCsdiRouteFeatures(routeNumber) {
  const route = String(routeNumber || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(route)) return [];

  return fetchGcpWithCache(csdiRouteGeometryCacheState, route, async () => {
    const urls = [
      toApiUrl(`/api/kmb/route-geometry?route=${encodeURIComponent(route)}`),
      buildDirectCsdiRouteUrl(route),
    ];
    let lastError = null;
    for (const url of urls) {
      try {
        const response = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.type === 'FeatureCollection' && Array.isArray(payload.features)) {
          return compactCsdiRouteFeatures(payload.features);
        }
        throw new Error('CSDI returned an invalid GeoJSON payload.');
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('CSDI route geometry is unavailable.');
  });
}

function parseLocationInput(input) {
  const trimmed = input.trim();
  const m = trimmed.match(/^([\d.]+)\s*[,\s]\s*([\d.]+)$/);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (a > 800000 && b > 800000) {
      const w = hk80ToWgs84(a, b);
      return { type: 'coords', lat: w.lat, lng: w.lng };
    }
    if (a > 10 && a < 30 && b > 100 && b < 130)
      return { type: 'coords', lat: a, lng: b };
  }
  return { type: 'text', query: trimmed };
}

function parseNominatimPlaceId(placeId) {
  if (typeof placeId !== 'string' || !placeId.startsWith('nominatim:')) return null;
  const pair = placeId.slice('nominatim:'.length).split(',');
  if (pair.length !== 2) return null;
  const lat = Number(pair[0]);
  const lng = Number(pair[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function buildNominatimSuggestion(row) {
  const lat = Number(row?.lat);
  const lng = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const label = String(row?.display_name || '').trim();
  if (!label) return null;
  const pieces = label.split(',').map((part) => part.trim()).filter(Boolean);
  return {
    place_id: `nominatim:${lat},${lng}`,
    description: label,
    structured_formatting: {
      main_text: pieces[0] || label,
      secondary_text: pieces.slice(1).join(', '),
    },
  };
}

async function searchNominatim(query, limit = 1) {
  const search = new URLSearchParams({
    format: 'jsonv2',
    countrycodes: 'hk',
    addressdetails: '0',
    limit: String(Math.max(1, limit)),
    q: query,
  });
  const response = await fetch(`${NOMINATIM_SEARCH_URL}?${search.toString()}`);
  if (!response.ok) return [];
  const payload = await response.json();
  if (!Array.isArray(payload)) return [];
  return payload;
}

async function fetchJsonEndpoint(url, label) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
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

async function loadKmbPayloads(endpoints, sourceLabel) {
  const [stopsData, routesData, routeStopsData] = await Promise.all([
    fetchJsonEndpoint(endpoints[0], `${sourceLabel} stop`),
    fetchJsonEndpoint(endpoints[1], `${sourceLabel} route`),
    fetchJsonEndpoint(endpoints[2], `${sourceLabel} route-stop`),
  ]);

  if (!Array.isArray(stopsData?.data) || !Array.isArray(routesData?.data) || !Array.isArray(routeStopsData?.data)) {
    throw new Error(`${sourceLabel} KMB payload format error (missing data arrays).`);
  }

  return { stopsData, routesData, routeStopsData };
}

async function geocode(query, placeId = null) {
  const selectedNominatim = parseNominatimPlaceId(placeId);
  if (selectedNominatim) return { ...selectedNominatim, name: query };

  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = placeId ? `pid:${placeId}` : `q:${normalizedQuery}`;
  return fetchGcpWithCache(geocodeCacheState, cacheKey, async () => {
    const queryPart = placeId
      ? `place_id=${encodeURIComponent(placeId)}`
      : `address=${encodeURIComponent(query)}&components=country:hk`;

    try {
      const res = await fetch(toApiUrl(`/api/google/geocode/json?${queryPart}`));
      const data = await res.json();
      if (data?.status === 'OK' && Array.isArray(data.results) && data.results.length > 0) {
        const loc = data.results[0]?.geometry?.location;
        if (loc?.lat != null && loc?.lng != null) {
          return { lat: loc.lat, lng: loc.lng, name: query };
        }
      }
    } catch {
      // Continue to fallback geocoder below.
    }

    const fallbackRows = await searchNominatim(query, 1);
    const fallback = buildNominatimSuggestion(fallbackRows[0]);
    if (!fallback) return null;
    const loc = parseNominatimPlaceId(fallback.place_id);
    return loc ? { ...loc, name: query } : null;
  });
}

async function resolveLocation(inputObj) {
  const rawText = typeof inputObj === 'string' ? inputObj : inputObj.name;
  const placeId = typeof inputObj === 'object' ? inputObj.place_id : null;
  const parsed = parseLocationInput(rawText);
  if (parsed.type === 'coords') return { lat: parsed.lat, lng: parsed.lng, name: rawText };
  const result = await geocode(rawText, placeId);
  if (!result) throw new Error(`Cannot find location: "${rawText}"`);
  return { ...result, name: rawText };
}

function cloneRouteResults(routes) {
  return (routes || []).map((route) => ({
    ...route,
    segments: (route.segments || []).map((seg) => ({ ...seg })),
    legs: (route.legs || []).map((leg) => ({ ...leg })),
  }));
}

function buildSearchCacheKey({
  originLoc,
  destLoc,
  timeMode,
  dateValue,
  timeValue,
  excludedRoutesText,
  allowFallbackNonKmb,
  strictEtaOnly,
}) {
  return JSON.stringify({
    origin: [originLoc.lat.toFixed(6), originLoc.lng.toFixed(6)],
    destination: [destLoc.lat.toFixed(6), destLoc.lng.toFixed(6)],
    timeMode,
    dateValue: timeMode === 'now' ? '' : dateValue,
    timeValue: timeMode === 'now' ? '' : timeValue,
    excludedRoutesText: (excludedRoutesText || '').trim().toUpperCase(),
    allowFallbackNonKmb: Boolean(allowFallbackNonKmb),
    strictEtaOnly: Boolean(strictEtaOnly),
  });
}

function isFallbackRoute(route) {
  return route?.type === 'fallback_candidate' || route?.isFallback;
}

function hasUsableNowTiming(segment, index) {
  if (segment?.hasActiveEta === true) return true;
  return index > 0 && segment?.timingFallbackReason === 'transfer_eta_unavailable_historical_schedule';
}

function parseMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatFare(fare) {
  if (!fare || fare.status !== 'available' || fare.amount == null) return 'Fare unavailable';
  return `${fare.currency || 'HKD'} ${Number(fare.amount).toFixed(1)}`;
}

function formatHybridFare(route) {
  if (!isFallbackRoute(route)) return formatFare(route?.fare);
  if (route?.fare?.status === 'available') return formatFare(route.fare);
  const hasKmb = (route?.legs || []).some((leg) => leg.operator === 'KMB');
  const hasPaidUnknown = (route?.legs || []).some((leg) =>
    leg.operator !== 'KMB' && leg.fare?.status !== 'available'
  );
  if (hasKmb && hasPaidUnknown) return 'KMB $0 + Google fare unavailable';
  return formatFare(route?.fare);
}

function getOperatorDisplayName(code) {
  const key = String(code || '').trim().toUpperCase();
  if (key === 'KMB') return 'KMB';
  if (key === 'CTB') return 'Citybus';
  if (key === 'TRAM') return 'Tram';
  if (key === 'MTR') return 'MTR';
  if (key === 'MTR_BUS') return 'MTR Bus';
  if (key === 'LRT') return 'Light Rail';
  if (key === 'WALK') return 'Walk';
  if (key === 'BUS') return 'Bus';
  return code || 'Other';
}

function getOperatorBadgeClass(code) {
  const key = String(code || '').trim().toUpperCase();
  if (key === 'KMB') return 'bg-red-600 text-white';
  if (key === 'CTB') return 'bg-blue-600 text-white';
  if (key === 'TRAM') return 'bg-emerald-600 text-white';
  if (key === 'MTR') return 'bg-amber-500 text-slate-900';
  if (key === 'MTR_BUS') return 'bg-cyan-600 text-white';
  if (key === 'LRT') return 'bg-lime-600 text-white';
  if (key === 'WALK') return 'bg-slate-400 text-white';
  if (key === 'BUS') return 'bg-sky-600 text-white';
  return 'bg-slate-500 text-white';
}

function getOperatorColor(code, fallbackColor = '#64748B') {
  const key = String(code || '').trim().toUpperCase();
  if (key === 'KMB') return '#E1251B';
  if (key === 'CTB') return '#2563EB';
  if (key === 'TRAM') return '#059669';
  if (key === 'MTR') return '#F59E0B';
  if (key === 'MTR_BUS') return '#0891B2';
  if (key === 'LRT') return '#65A30D';
  if (key === 'WALK') return '#94A3B8';
  if (key === 'BUS') return '#0284C7';
  return fallbackColor;
}

function getLegStopName(stop) {
  return stop?.name?.tc || stop?.name?.en || stop?.stop_id || stop?.id || 'Stop';
}

function parseOperatorCodes(value) {
  if (!value) return [];
  return String(value)
    .split('+')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function plannedTimeValidity(route, timeMode) {
  if (timeMode === 'now' || isFallbackRoute(route)) return null;
  const status = String(route?.historicalScheduleStatus || '').trim();
  if (status === 'matched') {
    return {
      label: 'Valid for selected time',
      className: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    };
  }
  if (status === 'schedule_unavailable') {
    return {
      label: 'Historical slots unavailable',
      className: 'bg-amber-50 text-amber-700 border-amber-200',
    };
  }
  return {
    label: 'Not validated for selected time',
    className: 'bg-slate-100 text-slate-600 border-slate-200',
  };
}

function historicalScheduleSourceLabel(status) {
  if (status === 'route_stop_profile') return 'station profile';
  if (status === 'route_profile') return 'route profile';
  if (status === 'route_stop_profile_missing') return 'station profile unavailable';
  if (status === 'profile_missing') return 'profile unavailable';
  if (status === 'schedule_unavailable') return 'schedule unavailable';
  return 'historical profile';
}

function dayClassLabel(dayClass) {
  if (dayClass === 'saturday') return 'Saturday';
  if (dayClass === 'sunday_public_holiday') return 'Sunday/holiday';
  return 'Weekday';
}

function kmbVariantRemark(segment) {
  const route = String(segment?.route || '').toUpperCase();
  const bound = String(segment?.bound || '').toUpperCase();
  const serviceType = String(segment?.service_type || '1');
  if (route === '269C' && bound === 'O' && serviceType === '5') {
    return 'Includes Tin Shui Wai Station + Shek Po Tsuen';
  }
  return null;
}

function kmbEtaOptionKey(segment, fallbackStopId = '') {
  return [
    segment?.fromStop || fallbackStopId,
    segment?.route,
    segment?.bound,
    segment?.service_type || '1',
  ].map((value) => String(value || '')).join('|');
}

function formatHistoricalSchedule(schedule) {
  if (!schedule) return null;
  if (schedule.status === 'profile_missing' || schedule.status === 'route_stop_profile_missing') {
    return `${dayClassLabel(schedule.dayClass)} service window unavailable for this station`;
  }
  if (schedule.status === 'schedule_unavailable') return 'Historical service slots unavailable';
  if (!schedule.startTime || !schedule.endTime) return null;

  const pieces = [
    `${dayClassLabel(schedule.dayClass)} observed ${schedule.startTime}-${schedule.endTime}`,
    historicalScheduleSourceLabel(schedule.status),
  ];
  if (Number.isFinite(schedule.sampleCount)) pieces.push(`${schedule.sampleCount} ETA samples`);
  return pieces.join(' · ');
}

function historicalScheduleClass(schedule) {
  if (!schedule) return 'bg-slate-50 text-slate-500 border-slate-200';
  if (schedule.valid === false) return 'bg-red-50 text-red-700 border-red-200';
  if (schedule.status === 'profile_missing' || schedule.status === 'route_stop_profile_missing') {
    return 'bg-amber-50 text-amber-700 border-amber-200';
  }
  if (schedule.status === 'route_profile') return 'bg-cyan-50 text-cyan-700 border-cyan-200';
  return 'bg-emerald-50 text-emerald-700 border-emerald-200';
}

function knownFareForRanking(route) {
  if (isFallbackRoute(route)) {
    return route.fare?.status === 'available' ? parseMoney(route.fare.amount) : null;
  }
  // User-specific rule: treat KMB as zero-cost for ranking because of monthly pass.
  return 0;
}

function estimatedTimeForRanking(route) {
  return isFallbackRoute(route)
    ? route.estimated_time_min ?? route.estimatedTime ?? 9999
    : route.estimatedTime ?? 9999;
}

function rankCombinedTransportOptions(routes) {
  return [...(routes || [])].sort((a, b) => {
    const aFare = knownFareForRanking(a);
    const bFare = knownFareForRanking(b);

    if (aFare != null && bFare != null && aFare !== bFare) return aFare - bFare;
    if (estimatedTimeForRanking(a) !== estimatedTimeForRanking(b)) {
      return estimatedTimeForRanking(a) - estimatedTimeForRanking(b);
    }
    if ((a.transfers || 0) !== (b.transfers || 0)) {
      return (a.transfers || 0) - (b.transfers || 0);
    }
    // Final tie-breaker: if everything else is equal, prefer known fare.
    if (aFare == null && bFare != null) return 1;
    if (aFare != null && bFare == null) return -1;
    return 0;
  });
}

function stopNameFromMap(stop) {
  return stop?.name_tc || stop?.name_en || stop?.name || stop?.id || 'KMB stop';
}

function kmbStopLocation(stopMap, stopId) {
  const stop = stopMap?.[stopId];
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    name: stopNameFromMap(stop),
    stopId,
  };
}

function findKmbEtaGaps(routes, stopMap, limit = 3) {
  return [...(routes || [])]
    .sort((a, b) => estimatedTimeForRanking(a) - estimatedTimeForRanking(b))
    .slice(0, limit)
    .flatMap((route, routeIndex) => {
      const segments = route.segments || [];
      return segments
        .map((segment, segmentIndex) => ({ route, routeIndex, segment, segmentIndex }))
        .filter(({ segment }) => !segment.hasActiveEta && !segment.nextEta)
        .map(({ route, routeIndex, segment, segmentIndex }) => {
          const originLoc = kmbStopLocation(stopMap, segment.fromStop);
          const destLoc = kmbStopLocation(stopMap, segment.toStop);
          if (!originLoc || !destLoc) return null;
          return {
            route,
            routeIndex,
            segment,
            segmentIndex,
            originLoc: {
              ...originLoc,
              name: `${originLoc.name} (KMB gap start)`,
            },
            destLoc: {
              ...destLoc,
              name: `${destLoc.name} (KMB gap end)`,
            },
          };
        })
        .filter(Boolean);
    })
    .slice(0, 3);
}

function estimateKmbSegmentMinutes(segment) {
  const board = segment?.boardTime ? new Date(segment.boardTime) : null;
  const arrival = segment?.arrivalTime ? new Date(segment.arrivalTime) : null;
  if (board && arrival && !Number.isNaN(board.getTime()) && !Number.isNaN(arrival.getTime())) {
    return Math.max(1, Math.round((arrival.getTime() - board.getTime()) / 60000));
  }
  return Math.max(1, ((segment?.stops || []).length - 1) * 2);
}

function getSegmentRideDisplay(segment) {
  const board = segment?.boardTime ? new Date(segment.boardTime) : null;
  const arrival = segment?.arrivalTime ? new Date(segment.arrivalTime) : null;
  if (board && arrival && !Number.isNaN(board.getTime()) && !Number.isNaN(arrival.getTime())) {
    const mins = Math.max(1, Math.round((arrival.getTime() - board.getTime()) / 60000));
    return { minutes: mins, source: segment?.rideDurationSource || 'timed' };
  }

  if (Number.isFinite(segment?.rideDurationMinutes)) {
    return {
      minutes: Math.max(1, Math.round(segment.rideDurationMinutes)),
      source: segment?.rideDurationSource || 'estimated',
    };
  }

  return {
    minutes: estimateKmbSegmentMinutes(segment),
    source: 'heuristic',
  };
}

function googleLocationFromStop(stop) {
  if (!stop) return null;
  const loc = stop.location || stop;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function googleStopName(stop) {
  return stop?.name || stop?.stop_name || null;
}

function normalizeGoogleStop(stop, fallbackLoc, fallbackName = 'Google transit stop') {
  const loc = googleLocationFromStop(stop) || fallbackLoc;
  return {
    id: stop?.place_id || googleStopName(stop) || fallbackName,
    stop_id: stop?.place_id || googleStopName(stop) || fallbackName,
    station_code: null,
    name: {
      tc: null,
      en: googleStopName(stop) || fallbackName,
      sc: null,
    },
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
    distance_km: 0,
    coordinate_source: 'Google Directions Transit',
  };
}

function normalizeKmbStopForLeg(stopMap, stopId) {
  const stop = stopMap?.[stopId];
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  return {
    id: stopId,
    stop_id: stopId,
    station_code: null,
    name: {
      tc: stop?.name_tc || null,
      en: stop?.name_en || stopId || 'KMB stop',
      sc: null,
    },
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    distance_km: 0,
    coordinate_source: 'KMB Open Data',
  };
}

function googleOperatorCode(step) {
  const details = step?.transit_details;
  const line = details?.line || {};
  const vehicleType = String(line.vehicle?.type || '').toUpperCase();
  const agencyName = String(line.agencies?.[0]?.name || '').toUpperCase();
  const shortName = String(line.short_name || line.name || '').trim().toUpperCase();

  if (agencyName.includes('MTR')) {
    if (vehicleType === 'BUS' || /^K\d/.test(shortName)) return 'MTR_BUS';
    if (vehicleType === 'TRAM' || vehicleType === 'LIGHT_RAIL' || /^\d{3}[A-Z]?$/.test(shortName)) return 'LRT';
    return 'MTR';
  }
  if (vehicleType === 'TRAM') return 'TRAM';
  if (agencyName.includes('CITYBUS') || agencyName.includes('CTB')) return 'CTB';
  if (agencyName.includes('KOWLOON MOTOR BUS') || agencyName.includes('KMB')) return 'KMB';
  if (vehicleType === 'BUS') return 'BUS';
  return vehicleType || 'OTHER';
}

function googleLineLabel(step) {
  const line = step?.transit_details?.line || {};
  return line.short_name || line.name || line.vehicle?.name || 'Transit';
}

function decodeGooglePolyline(encoded) {
  if (!encoded) return [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const coordinates = [];

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = null;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lng / 1e5, lat / 1e5]);
  }

  return coordinates;
}

function staticFareOperatorKey(operator) {
  const key = String(operator || '').trim().toUpperCase();
  if (key === 'CTB') return 'ctb';
  if (key === 'TRAM') return 'tram';
  if (key === 'MTR_BUS') return 'mtr-bus';
  return null;
}

function staticRailOperatorKey(operator) {
  const key = String(operator || '').trim().toUpperCase();
  if (key === 'MTR') return 'mtr';
  if (key === 'LRT') return 'lrt';
  return null;
}

async function lookupStaticOperatorFare(operator, route) {
  const operatorKey = staticFareOperatorKey(operator);
  const routeLabel = String(route || '').trim();
  if (!operatorKey || !routeLabel) return null;

  const cacheKey = `${operatorKey}:${routeLabel.toUpperCase()}`;
  return fetchGcpWithCache(staticOperatorFareCacheState, cacheKey, async () => {
    const query = new URLSearchParams({ operator: operatorKey, route: routeLabel });
    const response = await fetch(toApiUrl(`/api/operators/fare?${query.toString()}`));
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.fare || null;
  });
}

async function lookupStaticRailLeg(leg) {
  const operatorKey = staticRailOperatorKey(leg?.operator);
  const lineLabel = String(leg?.route || leg?.line || '').trim();
  const originLabel = getLegStopName(leg?.origin_stop);
  const destinationLabel = getLegStopName(leg?.destination_stop);
  if (!operatorKey || !originLabel || !destinationLabel) return null;

  const cacheKey = [
    'rail-leg',
    operatorKey,
    lineLabel.toUpperCase(),
    originLabel.toUpperCase(),
    destinationLabel.toUpperCase(),
  ].join(':');

  return fetchGcpWithCache(staticOperatorFareCacheState, cacheKey, async () => {
    const query = new URLSearchParams({
      operator: operatorKey,
      line: lineLabel,
      origin: originLabel,
      destination: destinationLabel,
    });
    const response = await fetch(toApiUrl(`/api/operators/rail-leg?${query.toString()}`));
    if (!response.ok) return null;
    return response.json();
  });
}

function googleFareFromRoute(route) {
  const fare = route?.fare;
  const amount = Number(fare?.value);
  if (!Number.isFinite(amount)) {
    return {
      status: 'unavailable',
      amount: null,
      currency: 'HKD',
      source: 'Google Directions Transit',
      note: 'Google did not provide a fare for this option.',
    };
  }
  return {
    status: 'available',
    amount,
    currency: fare.currency || 'HKD',
    source: 'Google Directions Transit fare',
  };
}

function googleReferenceTimestamp(gap, { timeMode, dateValue, timeValue } = {}) {
  const segmentTime = timeMode === 'arrive'
    ? gap?.segment?.arrivalTime
    : gap?.segment?.boardTime;
  const parsedSegmentTime = segmentTime ? new Date(segmentTime) : null;
  if (parsedSegmentTime && !Number.isNaN(parsedSegmentTime.getTime())) {
    return parsedSegmentTime;
  }
  if (timeMode !== 'now' && dateValue && timeValue) {
    const planned = new Date(`${dateValue}T${timeValue}:00`);
    if (!Number.isNaN(planned.getTime())) return planned;
  }
  return new Date();
}

function googleTransitLegsFromRoute(route, fallbackOrigin, fallbackDestination) {
  const steps = (route?.legs || []).flatMap((leg) => leg.steps || []);
  const transitSteps = steps.filter((step) => step?.travel_mode === 'TRANSIT');

  return transitSteps.map((step, index) => {
    const details = step.transit_details || {};
    const operator = googleOperatorCode(step);
    const routeLabel = googleLineLabel(step);
    const originStop = normalizeGoogleStop(
      details.departure_stop,
      index === 0 ? fallbackOrigin : null,
      'Google departure stop',
    );
    const destinationStop = normalizeGoogleStop(
      details.arrival_stop,
      index === transitSteps.length - 1 ? fallbackDestination : null,
      'Google arrival stop',
    );

    return {
      operator,
      mode: String(step?.transit_details?.line?.vehicle?.type || 'transit').toLowerCase(),
      route: routeLabel,
      line: routeLabel,
      route_id: routeLabel,
      route_variant_id: `google:${operator}:${routeLabel}:${index}`,
      direction: details.headsign || null,
      origin_stop: originStop,
      destination_stop: destinationStop,
      stop_count: details.num_stops != null ? Number(details.num_stops) + 1 : null,
      estimated_ride_time_min: Math.max(1, Math.round((step.duration?.value || 60) / 60)),
      ride_time_source: 'google_transit_step_duration',
      boardTime: details.departure_time?.value ? new Date(details.departure_time.value * 1000).toISOString() : null,
      arrivalTime: details.arrival_time?.value ? new Date(details.arrival_time.value * 1000).toISOString() : null,
      headsign: details.headsign || null,
      intermediate_stops: [],
      geometry: decodeGooglePolyline(step.polyline?.points),
      fare: {
        status: 'unavailable',
        amount: null,
        currency: 'HKD',
        source: 'Google Directions Transit',
      },
      data_source: 'Google Directions Transit',
    };
  });
}

async function enrichGoogleTransitLegFares(legs) {
  const enriched = await Promise.all((legs || []).map(async (leg) => {
    if (leg.operator === 'KMB') {
      return {
        ...leg,
        fare: {
          status: 'available',
          amount: 0,
          currency: 'HKD',
          source: 'KMB monthly pass user preference',
          note: 'KMB treated as zero fare for this user.',
        },
      };
    }

    if (leg.operator === 'MTR' || leg.operator === 'LRT') {
      const railLeg = await lookupStaticRailLeg(leg);
      if (railLeg) {
        return {
          ...leg,
          fare: railLeg.fare || leg.fare,
          intermediate_stops: railLeg.intermediate_stops?.length
            ? railLeg.intermediate_stops
            : leg.intermediate_stops,
          stop_count: railLeg.stop_count || leg.stop_count,
          data_source: `${leg.data_source}; ${railLeg.source || 'static rail data'}`,
        };
      }
    }

    const staticFare = await lookupStaticOperatorFare(leg.operator, leg.route || leg.line);
    if (!staticFare) return leg;
    return {
      ...leg,
      fare: {
        ...staticFare,
        source: staticFare.source || 'operator static fare data',
      },
    };
  }));
  return enriched;
}

function walkingDistanceFromGoogleRoute(route) {
  return (route?.legs || [])
    .flatMap((leg) => leg.steps || [])
    .filter((step) => step?.travel_mode === 'WALKING')
    .reduce((sum, step) => sum + Number(step?.distance?.value || 0), 0);
}

function kmbSegmentToGoogleGapLeg(segment, stopMap, index) {
  const rideInfo = getSegmentRideDisplay(segment);
  const intermediateStops = (segment?.stops || [])
    .slice(1, -1)
    .map((stopId) => normalizeKmbStopForLeg(stopMap, stopId));
  return {
    operator: 'KMB',
    mode: 'kmb',
    route: segment?.route || 'KMB',
    line: segment?.route || 'KMB',
    route_id: segment?.route || 'KMB',
    route_variant_id: `kmb:${segment?.route || 'unknown'}:${index}`,
    direction: segment?.routeInfo?.bound || null,
    origin_stop: normalizeKmbStopForLeg(stopMap, segment?.fromStop),
    destination_stop: normalizeKmbStopForLeg(stopMap, segment?.toStop),
    stop_count: Math.max(1, segment?.stops?.length || 1),
    estimated_ride_time_min: rideInfo.minutes,
    ride_time_source: rideInfo.source,
    boardTime: segment?.boardTime || segment?.nextEta || null,
    arrivalTime: segment?.arrivalTime || null,
    intermediate_stops: intermediateStops,
    source_segment: segment,
    fare: {
      status: 'available',
      amount: 0,
      currency: 'HKD',
      source: 'KMB monthly pass user preference',
      note: 'KMB treated as zero fare for this user.',
    },
    data_source: 'KMB Open Data',
    hasActiveEta: Boolean(segment?.hasActiveEta),
    nextEta: segment?.nextEta || null,
  };
}

function transferStopsForLegs(legs) {
  return legs.slice(0, -1).map((leg, index) => ({
    alight: leg.destination_stop,
    board: legs[index + 1]?.origin_stop,
    walk_distance_m: 0,
  }));
}

function combineGoogleGapFare(legs, googleFare) {
  const nonKmbFares = legs
    .map((leg) => leg.fare)
    .filter((fare, index) => legs[index]?.operator !== 'KMB');
  const knownNonKmb = nonKmbFares.filter((fare) => fare?.status === 'available' && fare.amount != null);
  if (nonKmbFares.length > 0 && knownNonKmb.length === nonKmbFares.length) {
    return {
      status: 'available',
      amount: Number(knownNonKmb.reduce((sum, fare) => sum + Number(fare.amount || 0), 0).toFixed(1)),
      currency: knownNonKmb[0]?.currency || 'HKD',
      source: knownNonKmb.map((fare) => fare.source).filter(Boolean).join('; '),
    };
  }
  if (googleFare?.status === 'available') return googleFare;
  return googleFare || {
    status: 'unavailable',
    amount: null,
    currency: 'HKD',
    source: 'Google Directions Transit',
  };
}

function applyGoogleFareToTransitLegs(legs, googleFare) {
  if (googleFare?.status !== 'available' || googleFare.amount == null) return legs;
  let applied = false;
  return legs.map((leg) => {
    if (applied || leg.operator === 'KMB' || leg.operator === 'WALK') return leg;
    if (leg.fare?.status === 'available' && leg.fare.amount != null) return leg;
    applied = true;
    return {
      ...leg,
      fare: {
        ...googleFare,
        note: 'Google provided this fare for the transit gap; per-leg split is not available.',
      },
    };
  });
}

async function buildGoogleGapCandidate(route, routeIndex, gap) {
  const googleLeg = route?.legs?.[0] || {};
  const durationMin = Math.max(1, Math.round((googleLeg.duration?.value || 60) / 60));
  const originStop = normalizeGoogleStop(null, gap.originLoc, gap.originLoc?.name || 'Gap start');
  const destinationStop = normalizeGoogleStop(null, gap.destLoc, gap.destLoc?.name || 'Gap end');
  const transitLegs = await enrichGoogleTransitLegFares(
    googleTransitLegsFromRoute(route, originStop, destinationStop),
  );
  const legs = transitLegs.length > 0
    ? transitLegs
    : [{
        operator: 'WALK',
        mode: 'walking',
        route: 'Walk',
        line: 'Walk',
        route_id: 'walk',
        route_variant_id: `google:walk:${routeIndex}`,
        direction: null,
        origin_stop: originStop,
        destination_stop: destinationStop,
        stop_count: null,
        estimated_ride_time_min: durationMin,
        ride_time_source: 'google_directions_duration',
        fare: {
          status: 'unavailable',
          amount: null,
          currency: 'HKD',
          source: 'Google Directions Transit',
        },
        data_source: 'Google Directions Transit',
      }];
  const routeText = legs.map((leg) => leg.route).filter(Boolean).join(' -> ') || 'Google Transit';
  const operators = Array.from(new Set(legs.map((leg) => leg.operator).filter(Boolean)));
  const fare = googleFareFromRoute(route);

  return {
    id: `google-gap-${gap.route?.id || 'whole-trip'}-${gap.segmentIndex ?? 0}-${routeIndex}`,
    type: 'fallback_candidate',
    operator: operators.join('+') || 'OTHER',
    mode: 'google_transit',
    route: routeText,
    line: routeText,
    journey_type: legs.length <= 1 ? 'google_transit' : 'google_transit_transfer',
    transfers: Math.max(0, legs.length - 1),
    origin: gap.originLoc,
    destination: gap.destLoc,
    origin_stop: originStop,
    destination_stop: destinationStop,
    transfer_stops: legs.slice(0, -1).map((leg, index) => ({
      alight: leg.destination_stop,
      board: legs[index + 1]?.origin_stop,
      walk_distance_m: 0,
    })),
    legs,
    walk_distance_m: walkingDistanceFromGoogleRoute(route),
    walk_time_min: null,
    ride_time_min: durationMin,
    boarding_buffer_min: 0,
    estimated_time_min: durationMin,
    fare,
    confidence: 0.86,
    data_source: ['Google Directions Transit'],
    notes: ['Generated by Google Directions Transit to fill a KMB unavailable/no-ETA gap.'],
  };
}

async function generateGoogleTransitGapCandidates(gap, options = {}) {
  if (!gap?.originLoc || !gap?.destLoc) return [];

  const referenceTime = googleReferenceTimestamp(gap, options);
  const query = new URLSearchParams({
    origin: `${gap.originLoc.lat},${gap.originLoc.lng}`,
    destination: `${gap.destLoc.lat},${gap.destLoc.lng}`,
    mode: 'transit',
    alternatives: 'true',
  });
  if (options.timeMode === 'arrive') {
    query.set('arrival_time', String(Math.floor(referenceTime.getTime() / 1000)));
  } else {
    query.set('departure_time', String(Math.floor(referenceTime.getTime() / 1000)));
  }

  const cacheKey = [
    'google-gap',
    gap.originLoc.lat.toFixed(5),
    gap.originLoc.lng.toFixed(5),
    gap.destLoc.lat.toFixed(5),
    gap.destLoc.lng.toFixed(5),
    options.timeMode || 'now',
    Math.floor(referenceTime.getTime() / GCP_TRANSIT_GAP_TTL_MS),
  ].join('|');

  const data = await fetchGcpWithCache(transitGapCacheState, cacheKey, async () => {
    const response = await fetch(toApiUrl(`/api/google/directions/json?${query.toString()}`));
    return response.json();
  });

  if (data?.status !== 'OK' || !Array.isArray(data.routes)) {
    console.warn('Google transit gap search failed:', data?.status, data?.error_message);
    return [];
  }

  return Promise.all(
    data.routes
      .slice(0, 3)
      .map((route, index) => buildGoogleGapCandidate(route, index, gap)),
  );
}

function annotateGapRepairCandidates(candidates, gap) {
  const originalSegmentMinutes = estimateKmbSegmentMinutes(gap.segment);
  const baseRouteTime = gap.route?.estimatedTime ?? 0;
  return (candidates || []).map((candidate) => {
    const kmbSegments = gap.route?.segments || [];
    const kmbBefore = gap.isWholeTrip
      ? []
      : kmbSegments
          .slice(0, gap.segmentIndex)
          .map((segment, index) => kmbSegmentToGoogleGapLeg(segment, gap.stopMap, index));
    const kmbAfter = gap.isWholeTrip
      ? []
      : kmbSegments
          .slice(gap.segmentIndex + 1)
          .map((segment, index) => kmbSegmentToGoogleGapLeg(
            segment,
            gap.stopMap,
            gap.segmentIndex + 1 + index,
          ));
    const fullLegs = applyGoogleFareToTransitLegs(
      [...kmbBefore, ...(candidate.legs || []), ...kmbAfter],
      candidate.fare,
    );
    const routeText = fullLegs.map((leg) => leg.route || leg.line).filter(Boolean).join(' -> ') || candidate.route;
    const operators = Array.from(new Set(fullLegs.map((leg) => leg.operator).filter(Boolean)));
    const hybridTime = !gap.isWholeTrip && baseRouteTime > 0
      ? Math.max(1, Math.round(baseRouteTime - originalSegmentMinutes + candidate.estimated_time_min))
      : candidate.estimated_time_min;
    return {
      ...candidate,
      id: `gap-repair-${gap.route?.id || gap.routeIndex}-${gap.segmentIndex}-${candidate.id}`,
      isFallback: true,
      operator: operators.join('+') || candidate.operator,
      route: routeText,
      line: routeText,
      optionLabel: gap.isWholeTrip ? 'Google transit option' : 'KMB + Google transit option',
      alternativeRole: gap.isWholeTrip ? 'google_transit_whole_trip' : 'google_transit_gap_repair',
      repairReason: gap.isWholeTrip
        ? 'KMB route is unavailable; Google Transit suggested this whole-trip option'
        : `Replaces KMB ${gap.segment.route} segment with no active ETA`,
      replacedKmbRoute: gap.segment?.route || null,
      replacedKmbSegmentIndex: gap.segmentIndex,
      baseKmbRouteId: gap.route?.id || null,
      original_gap_time_min: originalSegmentMinutes,
      alternative_gap_time_min: candidate.estimated_time_min,
      legs: fullLegs,
      transfer_stops: transferStopsForLegs(fullLegs),
      transfers: Math.max(0, fullLegs.length - 1),
      estimated_time_min: hybridTime,
      estimatedTime: hybridTime,
      origin: gap.isWholeTrip ? candidate.origin : (gap.searchOriginLoc || candidate.origin),
      destination: gap.isWholeTrip ? candidate.destination : (gap.searchDestLoc || candidate.destination),
      origin_stop: fullLegs[0]?.origin_stop || candidate.origin_stop,
      destination_stop: fullLegs[fullLegs.length - 1]?.destination_stop || candidate.destination_stop,
      ride_time_min: fullLegs.reduce((sum, leg) => sum + Number(leg.estimated_ride_time_min || 0), 0),
      fare: combineGoogleGapFare(fullLegs, candidate.fare),
      notes: [
        ...(candidate.notes || []),
        gap.isWholeTrip
          ? 'This option is fully supplied by Google Transit because KMB did not return a usable route.'
          : `Hybrid estimate keeps the rest of KMB route ${gap.routeIndex + 1} and replaces only the no-ETA KMB ${gap.segment.route} gap.`,
      ],
    };
  });
}

// Autocomplete Input Component
const AutocompleteInput = ({ value, onChange, placeholder, onClear }) => {
  const displayValue = typeof value === 'string' ? value : value?.name || '';
  const [suggestions, setSuggestions] = useState([]);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const trimmedValue = displayValue.trim();
      const hasSelectedPlace = Boolean(value && typeof value === 'object' && value.place_id);
      const parsedValue = trimmedValue ? parseLocationInput(trimmedValue) : null;

      if (trimmedValue.length < 2 || hasSelectedPlace || parsedValue?.type === 'coords') {
        setSuggestions([]);
        return;
      }
      try {
        const key = trimmedValue.toLowerCase();
        const predictions = await fetchGcpWithCache(
          autocompleteCacheState,
          key,
          async () => {
            try {
              const res = await fetch(
                toApiUrl(`/api/google/place/autocomplete/json?input=${encodeURIComponent(trimmedValue)}&components=country:hk`),
              );
              const data = await res.json();
              if (data?.status === 'OK' && Array.isArray(data.predictions)) {
                return data.predictions.slice(0, 5);
              }
            } catch {
              // Continue to fallback autocomplete below.
            }

            const rows = await searchNominatim(trimmedValue, 5);
            return rows.map(buildNominatimSuggestion).filter(Boolean).slice(0, 5);
          },
        );
        setSuggestions(predictions || []);
      } catch (e) {
        console.error('Fetch Error:', e);
        setSuggestions([]);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [value, displayValue]);

  return (
    <div className="relative w-full">
      <input
        className={`w-full p-4 bg-slate-50 rounded-2xl font-bold border border-slate-200 ${onClear ? 'pr-12' : ''}`}
        placeholder={placeholder}
        value={displayValue}
        onChange={(e) => {
          onChange(e.target.value);
          setShow(true);
        }}
        onFocus={() => setShow(true)}
        onBlur={() => setTimeout(() => setShow(false), 200)}
      />
      {onClear && displayValue && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onClear();
            setSuggestions([]);
            setShow(false);
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 font-black text-lg leading-none"
          aria-label={`Clear ${placeholder}`}
        >
          {'\u2715'}
        </button>
      )}
      {show && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-white border border-slate-200 rounded-xl shadow-xl mt-1 overflow-hidden">
          {suggestions.map((s) => (
            <div
              key={`${s.place_id}:${s.description}`}
              onMouseDown={() => {
                onChange({ name: s.description, place_id: s.place_id });
                setShow(false);
              }}
              className="px-4 py-3 hover:bg-slate-50 cursor-pointer text-sm border-b border-slate-100"
            >
              <span className="font-bold">{s.structured_formatting?.main_text}</span>
              <span className="text-slate-400 ml-1 text-xs">
                {s.structured_formatting?.secondary_text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Skeleton card
const SkeletonCard = () => (
  <div className="p-4 bg-slate-50 rounded-2xl border-2 border-slate-100 animate-pulse">
    <div className="flex justify-between">
      <div>
        <div className="w-24 h-6 bg-slate-200 rounded-lg mb-2" />
        <div className="w-40 h-4 bg-slate-100 rounded-lg" />
      </div>
      <div className="w-16 h-8 bg-slate-200 rounded-lg" />
    </div>
  </div>
);

const CurrentStopEtaList = ({
  options,
  fallbackStopId,
  etaMap,
  isLoading,
  getEtaText,
  getEtaChipClass,
}) => (
  <div className="flex flex-col gap-1">
    <div className="text-[10px] font-black uppercase tracking-wide text-slate-400">
      Current stop ETA
    </div>
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const etaKey = kmbEtaOptionKey(option, fallbackStopId);
        const currentEtas = etaMap.get(etaKey);
        const variantRemark = kmbVariantRemark(option);
        return (
          <div key={etaKey} className="flex flex-col items-start gap-0.5">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] font-black text-slate-600">{option.route}</span>
              {currentEtas?.length > 0 ? (
                currentEtas.slice(0, 3).map((eta, etaIndex) => (
                  <span
                    key={`${eta.eta}|${etaIndex}`}
                    className={`rounded-full border px-2 py-1 text-[11px] font-bold ${getEtaChipClass(eta.eta)}`}
                  >
                    {getEtaText(eta.eta)}
                  </span>
                ))
              ) : (
                <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-400">
                  {isLoading && !etaMap.has(etaKey) ? 'Loading...' : 'No current ETA'}
                </span>
              )}
            </div>
            {variantRemark && (
              <span className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold leading-tight text-amber-700">
                {variantRemark}
              </span>
            )}
          </div>
        );
      })}
    </div>
  </div>
);

function clampRouteDetailHeight(value) {
  return Math.min(82, Math.max(28, Math.round(value)));
}

const RouteDetailResizeHandle = ({ height, onPointerDown, onChange }) => (
  <div className="sticky top-0 z-20 -mx-4 -mt-4 mb-3 rounded-t-[2rem] border-b border-slate-100 bg-white/95 px-3 pb-2 pt-2 backdrop-blur">
    <div className="flex items-center justify-center">
      <div
        role="separator"
        aria-label="Resize map and route details"
        aria-orientation="horizontal"
        aria-valuemin={28}
        aria-valuemax={82}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') onChange(height + 5);
          if (event.key === 'ArrowDown') onChange(height - 5);
        }}
        className="flex min-w-0 flex-1 touch-none cursor-ns-resize flex-col items-center gap-1 py-1 outline-none"
      >
        <span className="h-1.5 w-14 rounded-full bg-slate-300 shadow-inner" />
      </div>
    </div>
  </div>
);

// Bookmark Panel Component
const BookmarkPanel = ({ stopMap, stopRoutes, onClose, bookmarks, setBookmarks }) => {
  const [etaMap, setEtaMap] = useState(new Map());
  const [editing, setEditing] = useState(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [isUpdatingEtas, setIsUpdatingEtas] = useState(false);
  const [lastEtaUpdateAt, setLastEtaUpdateAt] = useState(null);
  const [etaUpdateError, setEtaUpdateError] = useState(null);
  const didInitialEtaRefreshRef = useRef(false);
  const [expandedStopKey, setExpandedStopKey] = useState(null);

  const totalBookmarkedStops = useMemo(
    () => bookmarks.reduce((sum, group) => sum + (group.stops?.length || 0), 0),
    [bookmarks],
  );

  const update = (newBm) => setBookmarks(newBm);

  const refreshBookmarkEtas = useCallback(async () => {
    if (isUpdatingEtas || totalBookmarkedStops === 0) return;
    setIsUpdatingEtas(true);
    setEtaUpdateError(null);
    try {
      const updates = await window.bookmarkEngine.refreshBookmarkETAs(bookmarks);
      setEtaMap(new Map(updates));
      setLastEtaUpdateAt(new Date());
    } catch (error) {
      setEtaUpdateError(error?.message || 'Could not update bookmark ETAs.');
    } finally {
      setIsUpdatingEtas(false);
    }
  }, [bookmarks, isUpdatingEtas, totalBookmarkedStops]);

  useEffect(() => {
    if (didInitialEtaRefreshRef.current) return;
    didInitialEtaRefreshRef.current = true;
    if (totalBookmarkedStops > 0) {
      refreshBookmarkEtas();
    }
  }, [refreshBookmarkEtas, totalBookmarkedStops]);

  const handleUpdateEtas = () => {
    refreshBookmarkEtas();
  };

  const handleAddGroup = () => {
    if (!newGroupName.trim()) return;
    const updated = window.bookmarkEngine.createGroup(bookmarks, newGroupName.trim());
    update(updated);
    setNewGroupName('');
  };

  const getAvailableRoutesForStop = (stopId) => {
    const grouped = new Map();
    for (const item of stopRoutes?.[stopId] || []) {
      const route = String(item.route || '').trim();
      if (!route) continue;
      if (!grouped.has(route)) grouped.set(route, []);
      const variants = grouped.get(route);
      if (!variants.some((v) => v.service_type === item.service_type)) {
        variants.push({ route, service_type: item.service_type || '1' });
      }
    }
    return Array.from(grouped.entries())
      .map(([route, variants]) => ({ route, variants }))
      .sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }));
  };

  const normalizeBookmarkName = (value) => String(value || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\s*\([A-Z]{1,3}\d{2,4}(?:\s*[,/]\s*[A-Z]{1,3}\d{2,4})*\)\s*$/i, '')
      .toLocaleLowerCase('en-HK');

  const cleanBookmarkDisplayName = (value) => String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/\s*\([A-Z]{1,3}\d{2,4}(?:\s*[,/]\s*[A-Z]{1,3}\d{2,4})*\)\s*$/i, '');

  const getBookmarkStopNameAliases = (stopId) => {
    const stop = stopMap?.[stopId];
    return Array.from(new Set([
      normalizeBookmarkName(stop?.name_tc),
      normalizeBookmarkName(stop?.name_en),
    ].filter(Boolean)));
  };

  const sameNameStopIdsByStopId = useMemo(() => {
    const stopIds = Object.keys(stopMap || {});
    const parent = new Map(stopIds.map((stopId) => [stopId, stopId]));
    const find = (stopId) => {
      let root = stopId;
      while (parent.get(root) !== root) root = parent.get(root);
      let current = stopId;
      while (parent.get(current) !== current) {
        const next = parent.get(current);
        parent.set(current, root);
        current = next;
      }
      return root;
    };
    const union = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    const aliasOwner = new Map();
    stopIds.forEach((stopId) => {
      getBookmarkStopNameAliases(stopId).forEach((alias) => {
        const existingStopId = aliasOwner.get(alias);
        if (existingStopId) union(stopId, existingStopId);
        else aliasOwner.set(alias, stopId);
      });
    });
    const groups = new Map();
    stopIds.forEach((stopId) => {
      const root = find(stopId);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(stopId);
    });
    const index = new Map();
    groups.forEach((groupStopIds) => {
      const sortedStopIds = [...groupStopIds].sort();
      sortedStopIds.forEach((stopId) => index.set(stopId, sortedStopIds));
    });
    return index;
  }, [stopMap]);

  const getAvailableRoutesForNamedStation = (stopId) => {
    const matchingStopIds = sameNameStopIdsByStopId.get(stopId) || [stopId];
    const grouped = new Map();
    matchingStopIds.forEach((matchingStopId) => {
      getAvailableRoutesForStop(matchingStopId).forEach(({ route, variants }) => {
        if (!grouped.has(route)) grouped.set(route, []);
        grouped.get(route).push(...variants.map((variant) => ({
          ...variant,
          stopId: matchingStopId,
        })));
      });
    });
    return Array.from(grouped.entries())
      .map(([route, variants]) => ({ route, variants }))
      .sort((a, b) => a.route.localeCompare(b.route, undefined, { numeric: true }));
  };

  const groupBookmarkedStopsByName = (stops = []) => {
    const grouped = new Map();
    stops.forEach((stop) => {
      const sameNameStopIds = sameNameStopIdsByStopId.get(stop.stopId) || [stop.stopId];
      const groupKey = sameNameStopIds.join('|');
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, { key: groupKey, stops: [] });
      }
      grouped.get(groupKey).stops.push(stop);
    });
    return Array.from(grouped.values());
  };

  const toggleGroupedBookmarkRoute = (
    groupIndex,
    groupedStops,
    routeName,
    variants,
    selected,
  ) => {
    const groupedStopIds = new Set(groupedStops.map((stop) => stop.stopId));
    const primaryStopId = groupedStops[0]?.stopId;
    const updated = bookmarks.map((group, index) => {
      if (index !== groupIndex) return group;
      return {
        ...group,
        stops: group.stops.map((stop) => {
          if (!groupedStopIds.has(stop.stopId)) return stop;
          const currentRoutes = stop.routes || [];
          const nextRoutes = selected
            ? currentRoutes.filter((item) => item.route !== routeName)
            : stop.stopId === primaryStopId
              ? [...currentRoutes, ...variants]
              : currentRoutes;
          const deduped = Array.from(new Map(nextRoutes.map((item) => [
            `${item.route}|${item.service_type || '1'}|${item.stopId || stop.stopId}`,
            {
              route: item.route,
              service_type: item.service_type || '1',
              stopId: item.stopId || stop.stopId,
            },
          ])).values());
          return { ...stop, routes: deduped };
        }),
      };
    });
    window.bookmarkEngine.saveBookmarks(updated);
    update(updated);
    setEtaMap((previous) => {
      const next = new Map(previous);
      groupedStopIds.forEach((stopId) => next.delete(stopId));
      return next;
    });
  };

  const removeGroupedBookmarkStops = (groupIndex, groupedStops) => {
    const groupedStopIds = new Set(groupedStops.map((stop) => stop.stopId));
    const updated = bookmarks.map((group, index) => (
      index === groupIndex
        ? { ...group, stops: group.stops.filter((stop) => !groupedStopIds.has(stop.stopId)) }
        : group
    ));
    window.bookmarkEngine.saveBookmarks(updated);
    update(updated);
    setEtaMap((previous) => {
      const next = new Map(previous);
      groupedStopIds.forEach((stopId) => next.delete(stopId));
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="mb-4 rounded-2xl border border-slate-100 bg-slate-50/80 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h2 className="shrink-0 font-black text-lg">{'\u2B50'} Bookmarks</h2>
            <button
              onClick={handleUpdateEtas}
              disabled={isUpdatingEtas || totalBookmarkedStops === 0}
              className="shrink-0 rounded-full bg-gradient-to-r from-[#E1251B] to-[#FF7A1A] px-3 py-1.5 text-[10px] font-black uppercase tracking-wide text-white shadow-md shadow-red-200/60 ring-1 ring-white/70 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-500 disabled:shadow-none"
            >
              {isUpdatingEtas ? 'Updating' : 'Update ETA'}
            </button>
          </div>
          <button onClick={onClose} className="shrink-0 text-slate-400 text-xl font-bold">
            {'\u2715'}
          </button>
        </div>
      </div>
      {lastEtaUpdateAt && (
        <div className="mb-3 rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700">
          ETA updated at {lastEtaUpdateAt.toLocaleTimeString('en-HK', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          })}
        </div>
      )}
      {etaUpdateError && (
        <div className="mb-3 rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs font-bold text-red-600">
          {etaUpdateError}
        </div>
      )}

      {/* Add group */}
      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 p-2 bg-slate-100 rounded-xl text-sm font-bold border border-slate-200"
          placeholder="New group name..."
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddGroup()}
        />
        <button
          onClick={handleAddGroup}
          className="px-3 py-2 bg-[#E1251B] text-white rounded-xl text-sm font-black"
        >
          +
        </button>
      </div>

      {bookmarks.length === 0 && (
        <div className="text-center text-slate-400 text-sm mt-4">
          No bookmark groups yet.
          <br />
          Add a group to track your favourite stops!
        </div>
      )}

      <div className="space-y-4 overflow-y-auto flex-1 scrollbar-hide">
        {bookmarks.map((group, gi) => (
          <div key={gi} className="bg-slate-50 rounded-2xl border border-slate-100 p-3">
            {/* Group header */}
            <div className="flex items-center justify-between mb-2">
              {editing === gi ? (
                <input
                  className="font-black text-sm bg-white border border-slate-200 rounded-lg px-2 py-1 flex-1 mr-2"
                  value={group.groupName}
                  autoFocus
                  onChange={(e) => {
                    const updated = window.bookmarkEngine.renameGroup(
                      bookmarks,
                      gi,
                      e.target.value,
                    );
                    update(updated);
                  }}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
                />
              ) : (
                <span
                  className="font-black text-sm text-slate-700 cursor-pointer"
                  onClick={() => setEditing(gi)}
                >
                  {group.groupName} {'\u270F\uFE0F'}
                </span>
              )}
              <button
                onClick={() => {
                  const u = window.bookmarkEngine.deleteGroup(bookmarks, gi);
                  update(u);
                }}
                className="text-red-400 text-xs font-bold"
              >
                {'\u2715'}
              </button>
            </div>

            {group.stops.length === 0 && (
              <div className="text-xs text-slate-300 mb-1">
                No stops yet. Add stops from route results.
              </div>
            )}

            {groupBookmarkedStopsByName(group.stops).map((stopGroup, si) => {
              const s = stopGroup.stops[0];
              const stopInfo = stopMap[s.stopId];
              const groupedStopIds = stopGroup.stops.map((stop) => stop.stopId).sort();
              const stationName = cleanBookmarkDisplayName(
                stopInfo?.name_tc || s.stopName || stopInfo?.name_en,
              );
              const stationLabel = stationName;
              const hasEtaData = groupedStopIds.every((stopId) => etaMap.has(stopId));
              const etas = Array.from(new Map(
                groupedStopIds
                  .flatMap((stopId) => etaMap.get(stopId) || [])
                  .map((eta) => [`${eta.route}|${eta.eta}`, eta]),
              ).values()).sort((a, b) => a.waitMin - b.waitMin);
              const stopKey = `${gi}|${stopGroup.key}`;
              const isExpanded = expandedStopKey === stopKey;
              const routeOptions = getAvailableRoutesForNamedStation(s.stopId);
              const selectedRoutes = stopGroup.stops.flatMap((stop) => stop.routes || []);
              const selectedRouteNames = new Set(selectedRoutes.map((item) => item.route));
              return (
                <div
                  key={stopGroup.key || si}
                  className="border-b border-slate-100 py-2 last:border-none"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedStopKey(isExpanded ? null : stopKey)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setExpandedStopKey(isExpanded ? null : stopKey);
                      }
                    }}
                    className={`w-full rounded-2xl p-2 text-left transition ${
                      isExpanded ? 'bg-white shadow-sm ring-1 ring-[#E1251B]/15' : 'hover:bg-white/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-slate-700">
                          {stationLabel}
                        </div>
                        <div className="truncate text-xs text-slate-400">{stopInfo?.name_en}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {!hasEtaData && (
                            <span className="text-xs text-slate-300">Click Update ETA to refresh</span>
                          )}
                          {hasEtaData && etas.length === 0 && (
                            <span className="text-xs text-slate-400">No ETA available now</span>
                          )}
                          {etas.slice(0, 4).map((e, ei) => (
                            <span
                              key={ei}
                              className={`rounded-full border bg-white px-2 py-0.5 text-xs font-bold eta-${e.color}`}
                            >
                              {e.route} {'\u00B7'} {e.waitMin <= 0 ? 'Arriving' : `${e.waitMin}min`}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-400">
                          {isExpanded ? 'Hide' : 'Routes'}
                        </span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            removeGroupedBookmarkStops(gi, stopGroup.stops);
                          }}
                          className="text-sm text-slate-300 hover:text-red-400"
                        >
                          {'\u2715'}
                        </button>
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="mt-2 rounded-2xl border border-slate-100 bg-white p-3 shadow-sm">
                      <div className="mb-2 text-[11px] font-black uppercase tracking-wide text-slate-400">
                        ETA route review
                      </div>
                      {routeOptions.length === 0 ? (
                        <div className="text-xs font-bold text-slate-400">
                          No route list found for this stop.
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {routeOptions.map(({ route, variants }) => {
                            const selected = selectedRouteNames.has(route);
                            return (
                              <button
                                key={route}
                                type="button"
                                onClick={() =>
                                  toggleGroupedBookmarkRoute(
                                    gi,
                                    stopGroup.stops,
                                    route,
                                    variants,
                                    selected,
                                  )
                                }
                                className={`rounded-full px-3 py-1.5 text-xs font-black transition ${
                                  selected
                                    ? 'bg-[#E1251B] text-white shadow-md shadow-red-200'
                                    : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                                }`}
                                title={selected ? 'Included in ETA review. Tap to remove.' : 'Excluded from ETA review. Tap to add.'}
                              >
                                {route}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div className="mt-2 text-[10px] font-bold text-slate-400">
                        Bright routes are included in ETA refresh. Dim routes are ignored.
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

// Main App Component
const App = () => {
  const [mapLoaded, setMapLoaded] = useState(false);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [results, setResults] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [selectedCurrentEtas, setSelectedCurrentEtas] = useState(new Map());
  const [isLoadingSelectedEtas, setIsLoadingSelectedEtas] = useState(false);
  const [selectedEtaUpdatedAt, setSelectedEtaUpdatedAt] = useState(null);
  const [routeDetailHeight, setRouteDetailHeight] = useState(48);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(true);
  const [isFilterExpanded, setIsFilterExpanded] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('Initialising...');
  const [searchError, setSearchError] = useState(null);
  const [expandedSegments, setExpandedSegments] = useState(new Set());
  const [timeMode, setTimeMode] = useState('now');
  const [dateValue, setDateValue] = useState(
    new Date().toISOString().split('T')[0],
  );
  const [timeValue, setTimeValue] = useState(
    new Date().toTimeString().substring(0, 5),
  );
  const [excludedRoutesText, setExcludedRoutesText] = useState('');
  const [strictEtaOnly, setStrictEtaOnly] = useState(true);
  const [allowFallbackNonKmb, setAllowFallbackNonKmb] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [isResultsMinimized, setIsResultsMinimized] = useState(false);
  const [isRefreshingEta, setIsRefreshingEta] = useState(false);
  const [lastEtaRefreshAt, setLastEtaRefreshAt] = useState(null);
  const [refreshFeedback, setRefreshFeedback] = useState(null);
  const [overlayRouteNumber, setOverlayRouteNumber] = useState('');
  const [isOverlayLoading, setIsOverlayLoading] = useState(false);
  const [overlayFeedback, setOverlayFeedback] = useState(null);

  // Add-to-bookmark modal state
  const [addToBookmark, setAddToBookmark] = useState(null);
  const [bookmarks, setBookmarks] = useState(() =>
    window.bookmarkEngine?.loadBookmarks?.() || [],
  );

  const mapRef = useRef(null);
  const viewRef = useRef(null);
  const graphicsLayerRef = useRef(null);
  const routeOverlayLayerRef = useRef(null);
  const routeOverlayStopLayerRef = useRef(null);
  const stationLabelLayerRef = useRef(null);
  const currentLocationLayerRef = useRef(null);
  const currentLocationRef = useRef(null);
  const arcgisModulesRef = useRef(null);
  const stopMapRef = useRef({});
  const routeMapRef = useRef({});
  const routeStopsRef = useRef({});
  const stopRoutesRef = useRef({});
  const searchCacheRef = useRef(new Map());
  const kmbRouteGeometryCacheRef = useRef(new Map());
  const kmbRoadGeometryCacheRef = useRef(new Map());
  const selectedEtaRequestRef = useRef(0);

  const displayedResults = useMemo(() => {
    if (!strictEtaOnly || timeMode !== 'now') return results;
    return results.filter((route) =>
      isFallbackRoute(route) ||
      (route.segments || []).every((seg, index) => hasUsableNowTiming(seg, index)),
    );
  }, [results, strictEtaOnly, timeMode]);

  const displayedResultCards = useMemo(() => {
    const groups = new Map();
    const cardsByKey = new Map();
    const orderedKeys = [];
    for (const route of displayedResults) {
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
      const stopPattern = (route.segments || [])
        .map((seg) => `${seg.fromStop}->${seg.toStop}`)
        .join('|');
      const groupKey = `${route.transfers}|${stopPattern}`;
      const isNewGroup = !groups.has(groupKey);
      if (isNewGroup) groups.set(groupKey, []);
      groups.get(groupKey).push(route);
      if (isNewGroup) orderedKeys.push(groupKey);
    }

    Array.from(groups.entries()).forEach(([groupKey, groupRoutes]) => {
      const sortedRoutes = [...groupRoutes].sort(
        (a, b) => (a.estimatedTime || 9999) - (b.estimatedTime || 9999),
      );
      const representative = sortedRoutes[0];
      const segmentDisplay = (representative.segments || []).map((seg, si) => {
        const routeOptionMap = new Map();
        sortedRoutes.forEach((routeCandidate) => {
          const candidateSeg = (routeCandidate.segments || [])[si];
          if (!candidateSeg?.route) return;
          const optionKey = `${candidateSeg.route}|${candidateSeg.bound || ''}|${candidateSeg.service_type || '1'}`;
          const rawCandidateEta = candidateSeg.nextEta ? new Date(candidateSeg.nextEta) : null;
          const readyTime = candidateSeg.readyTime ? new Date(candidateSeg.readyTime) : null;
          const candidateEta = rawCandidateEta &&
            (!readyTime || Number.isNaN(readyTime.getTime()) || rawCandidateEta >= readyTime)
            ? rawCandidateEta
            : null;
          const previous = routeOptionMap.get(optionKey);
          const shouldReplace =
            !previous ||
            (candidateEta && (!previous.nextEta || candidateEta < previous.nextEta));
          if (shouldReplace) {
            routeOptionMap.set(optionKey, {
              route: candidateSeg.route,
              bound: candidateSeg.bound,
              service_type: candidateSeg.service_type || '1',
              fromStop: candidateSeg.fromStop,
              readyTime: candidateSeg.readyTime || null,
              nextEta: candidateEta,
              hasActiveEta: Boolean(candidateSeg.hasActiveEta ?? candidateSeg.nextEta),
              busInterval: candidateSeg.busInterval ?? null,
            });
          }
        });

        const routeOptions = Array.from(routeOptionMap.values()).sort((a, b) =>
          a.route.localeCompare(b.route, undefined, { numeric: true, sensitivity: 'base' }),
        );
        const routeNames = routeOptions.map((o) => o.route);
        const earliestEta = routeOptions
          .map((o) => o.nextEta)
          .filter(Boolean)
          .sort((a, b) => a - b)[0];

        return {
          ...seg,
          routeLabel: routeNames.join('/'),
          routeOptions,
          nextEta: earliestEta || seg.nextEta,
        };
      });

      cardsByKey.set(groupKey, {
        key: groupKey,
        representative,
        segmentDisplay,
      });
    });

    return orderedKeys.map((key) => cardsByKey.get(key)).filter(Boolean);
  }, [displayedResults]);

  const availableFilterRoutes = useMemo(() => {
    return Array.from(
      new Set(
        displayedResults
          .filter((route) => !isFallbackRoute(route))
          .flatMap((route) => (route.segments || []).map((seg) => seg.route)),
      ),
    ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  }, [displayedResults]);

  const getEtaText = useCallback((etaValue) => {
    if (!etaValue) return 'No ETA';
    const waitMin = Math.max(
      0,
      Math.round((new Date(etaValue) - new Date()) / 60000),
    );
    return waitMin <= 0 ? 'Arriving' : `${waitMin} min`;
  }, []);

  const getEtaChipClass = useCallback((etaValue) => {
    if (!etaValue) return 'bg-slate-100 text-slate-500 border-slate-200';
    const waitMin = Math.max(
      0,
      Math.round((new Date(etaValue) - new Date()) / 60000),
    );
    if (waitMin <= 3) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (waitMin <= 10) return 'bg-amber-50 text-amber-700 border-amber-200';
    return 'bg-rose-50 text-rose-700 border-rose-200';
  }, []);

  const formatClockTime = useCallback((timeValue) => {
    if (!timeValue) return null;
    const parsed = timeValue instanceof Date ? timeValue : new Date(timeValue);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleTimeString('en-HK', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }, []);

  const plannedJourneyClock = useCallback(
    (route) => {
      if (timeMode !== 'arrive' || !route) return null;
      const depart = formatClockTime(route.plannedDepartureTime);
      const arrive = formatClockTime(route.plannedArrivalTime);
      if (!depart && !arrive) return null;
      return { depart, arrive };
    },
    [formatClockTime, timeMode],
  );

  const refreshStatusClass = useMemo(() => {
    if (!refreshFeedback) return '';
    if (refreshFeedback.type === 'success')
      return 'bg-emerald-50 border-emerald-200 text-emerald-700';
    if (refreshFeedback.type === 'error')
      return 'bg-red-50 border-red-200 text-red-600';
    return 'bg-slate-100 border-slate-200 text-slate-600';
  }, [refreshFeedback]);

  const formatRefreshTime = useCallback((time) => {
    if (!time) return '';
    return time.toLocaleTimeString('en-HK', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, []);

  const refreshRouteTiming = useCallback(
    async (route) => {
      if (isFallbackRoute(route)) return route;
      const clonedRoute = {
        ...route,
        segments: (route.segments || []).map((seg) => ({ ...seg })),
      };
      const isValid = await window.routeEngine.applyRouteTiming(clonedRoute, {
        timeMode,
        dateValue,
        timeValue,
        now: new Date(),
        allowNoEtaNow: !strictEtaOnly,
      });
      return isValid ? clonedRoute : null;
    },
    [dateValue, strictEtaOnly, timeMode, timeValue],
  );

  // Load KMB data
  useEffect(() => {
    loadKMBData();
  }, []);

  useEffect(() => {
    initArcGIS();
  }, []);

  const loadKMBData = async () => {
    try {
      setLoadingStatus('Connecting to KMB Open Data...');

      const proxyEndpoints = [
        toApiUrl('/api/kmb/stop'),
        toApiUrl('/api/kmb/route'),
        toApiUrl('/api/kmb/route-stop'),
      ];
      const directEndpoints = [
        'https://data.etabus.gov.hk/v1/transport/kmb/stop',
        'https://data.etabus.gov.hk/v1/transport/kmb/route',
        'https://data.etabus.gov.hk/v1/transport/kmb/route-stop',
      ];

      let payloads = null;
      let proxyError = null;
      try {
        payloads = await loadKmbPayloads(proxyEndpoints, 'primary API');
      } catch (err) {
        proxyError = err;
        console.warn('Primary KMB API unavailable, falling back to direct feed:', err);
      }

      if (!payloads) {
        setLoadingStatus('Primary API unavailable, trying direct KMB feed...');
        try {
          payloads = await loadKmbPayloads(directEndpoints, 'direct KMB');
        } catch (directError) {
          throw new Error(
            `Primary API failed: ${proxyError?.message || 'unknown error'}; direct KMB failed: ${directError?.message || 'unknown error'}`,
          );
        }
      }

      setLoadingStatus('Processing Map Data...');
      const { stopsData, routesData, routeStopsData } = payloads;

      // 1. Process Stops (ID -> Name/Lat/Long)
      const sm = {};
      stopsData.data.forEach(s => {
        sm[s.stop] = {
          name_en: s.name_en,
          name_tc: s.name_tc,
          lat: parseFloat(s.lat),
          lng: parseFloat(s.long),
        };
      });
      stopMapRef.current = sm;

      // 2. Process Routes
      const rm = {};
      routesData.data.forEach(r => {
        // Create a unique key for each route direction
        rm[`${r.route}|${r.bound}|${r.service_type}`] = r;
      });
      routeMapRef.current = rm;

      // 3. Process Route-Stop Relationships (The sequences)
      const rs = {};
      const sr = {};
      routeStopsData.data.forEach(item => {
        const key = `${item.route}|${item.bound}|${item.service_type}`;
        if (!rs[key]) rs[key] = [];
        rs[key].push(item.stop);
        
        if (!sr[item.stop]) sr[item.stop] = [];
        sr[item.stop].push({
          route: item.route,
          bound: item.bound,
          service_type: item.service_type,
          seq: parseInt(item.seq),
        });
      });
      routeStopsRef.current = rs;
      stopRoutesRef.current = sr;

      setLoadingStatus('Ready');
      setDataLoaded(true);
    } catch (err) {
      console.error("Data Load Error:", err);
      const details = err?.message ? ` (${err.message})` : '';
      setLoadingStatus(`Connection failed${details}. Please refresh or verify your API host settings.`);
    }
  };

  const initArcGIS = async () => {
    try {
      const arcgisRequire = await loadArcGISApi();
      arcgisRequire(
        [
          'esri/Map',
          'esri/Basemap',
          'esri/layers/VectorTileLayer',
          'esri/views/MapView',
          'esri/geometry/Point',
          'esri/layers/GraphicsLayer',
          'esri/Graphic',
          'esri/geometry/Polyline',
          'esri/geometry/Extent',
        ],
        (Map, Basemap, VectorTileLayer, MapView, Point, GraphicsLayer, Graphic, Polyline, Extent) => {
          if (!mapRef.current) return;
          arcgisModulesRef.current = { Point, Graphic, Polyline, Extent };
          const vtLayer = new VectorTileLayer({
            url: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/basemap/HK80',
          });
          const labelLayer = new VectorTileLayer({
            url: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/label/hk/tc/HK80',
          });
          const map = new Map({ basemap: new Basemap({ baseLayers: [vtLayer] }) });
          map.add(labelLayer);
          const view = new MapView({
            container: mapRef.current,
            map,
            center: new Point({
              x: 833359.88,
              y: 822961.98,
              spatialReference: { wkid: 2326 },
            }),
            zoom: 12,
          });
          view.popupEnabled = false;
          const layer = new GraphicsLayer();
          const routeOverlayLayer = new GraphicsLayer();
          const routeOverlayStopLayer = new GraphicsLayer();
          const stationLabelLayer = new GraphicsLayer();
          const currentLocationLayer = new GraphicsLayer();
          map.add(layer);
          map.add(routeOverlayLayer);
          map.add(routeOverlayStopLayer);
          map.add(stationLabelLayer);
          map.add(currentLocationLayer);
          graphicsLayerRef.current = layer;
          routeOverlayLayerRef.current = routeOverlayLayer;
          routeOverlayStopLayerRef.current = routeOverlayStopLayer;
          stationLabelLayerRef.current = stationLabelLayer;
          currentLocationLayerRef.current = currentLocationLayer;
          viewRef.current = view;
          view.ui.padding = { top: 80 };
          const currentLocation = currentLocationRef.current;
          if (currentLocation) {
            renderCurrentLocationMarker(currentLocation.lat, currentLocation.lng);
          }
          view.on('click', async (event) => {
            const stationLayers = [layer, routeOverlayStopLayer, routeOverlayLayer];
            const hit = await view.hitTest(event, { include: stationLayers });
            let stopGraphic = hit.results
              .map((result) => result.graphic)
              .find((graphic) => graphic?.attributes?.type === 'station-stop');

            // Small overlay stops are difficult to hit precisely on touch screens.
            // Accept the closest station marker, with a wider target for full-route overlays.
            if (!stopGraphic) {
              const tapPoint = { x: event.x, y: event.y };
              let closest = null;
              stationLayers.forEach((stationLayer) => {
                stationLayer.graphics
                  .filter((graphic) => graphic?.attributes?.type === 'station-stop')
                  .forEach((graphic) => {
                    const screenPoint = view.toScreen(graphic.geometry);
                    if (!screenPoint) return;
                    const distance = Math.hypot(
                      screenPoint.x - tapPoint.x,
                      screenPoint.y - tapPoint.y,
                    );
                    const hitRadius = graphic?.attributes?.source === 'route-overlay' ? 36 : 22;
                    if (distance <= hitRadius && (!closest || distance < closest.distance)) {
                      closest = { graphic, distance };
                    }
                  });
              });
              stopGraphic = closest?.graphic;
            }

            if (stopGraphic) showStationNameOnMap(stopGraphic);
          });
          view.when(() => setMapLoaded(true));
        },
        (error) => {
          console.error('ArcGIS module load error:', error);
          setLoadingStatus('Map failed to load. Please refresh.');
        },
      );
    } catch (error) {
      console.error('ArcGIS load error:', error);
      setLoadingStatus('Map failed to load. Please refresh.');
    }
  };

  const clearMapGraphics = () => graphicsLayerRef.current?.removeAll();
  const clearRouteOverlay = () => {
    routeOverlayLayerRef.current?.removeAll();
    routeOverlayStopLayerRef.current?.removeAll();
    setOverlayFeedback(null);
  };
  const clearStationLabel = () => stationLabelLayerRef.current?.removeAll();

  const getStopDisplayName = (stop) =>
    stop?.name_tc || stop?.name_en || stop?.name?.tc || stop?.name?.en || stop?.stop_id || stop?.id || 'Station';

  const showStationNameOnMap = (graphic) => {
    const { Point, Graphic } = arcgisModulesRef.current || {};
    const layer = stationLabelLayerRef.current;
    const geometry = graphic?.geometry;
    const stationName = graphic?.attributes?.stationName;
    if (!layer || !Point || !Graphic || !geometry || !stationName) return;
    layer.removeAll();
    layer.add(
      new Graphic({
        geometry: new Point({
          x: geometry.longitude ?? geometry.x,
          y: geometry.latitude ?? geometry.y,
          spatialReference: { wkid: 4326 },
        }),
        symbol: {
          type: 'text',
          text: stationName,
          color: '#ffffff',
          backgroundColor: [15, 23, 42, 0.88],
          borderLineColor: [255, 255, 255, 0.92],
          borderLineSize: 1,
          haloColor: [15, 23, 42, 0.88],
          haloSize: 1,
          font: { size: 10, weight: 'bold' },
          yoffset: 20,
          horizontalAlignment: 'center',
          verticalAlignment: 'bottom',
        },
        attributes: { type: 'station-label' },
      }),
    );
  };

  const renderCurrentLocationMarker = useCallback((lat, lng) => {
    const { Point, Graphic } = arcgisModulesRef.current || {};
    const layer = currentLocationLayerRef.current;
    if (!layer || !Point || !Graphic) return;
    layer.removeAll();
    layer.add(
      new Graphic({
        geometry: new Point({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
        symbol: {
          type: 'simple-marker',
          style: 'circle',
          color: [37, 99, 235, 0.9],
          size: 12,
          outline: { color: [255, 255, 255, 1], width: 2 },
        },
      }),
    );
  }, []);

  const colorStringToRgba = (colorString, alpha = 0.9) => {
    if (!colorString || !String(colorString).startsWith('#')) return [37, 99, 235, alpha];
    const value = String(colorString).replace('#', '');
    if (value.length !== 6) return [37, 99, 235, alpha];
    return [
      parseInt(value.slice(0, 2), 16),
      parseInt(value.slice(2, 4), 16),
      parseInt(value.slice(4, 6), 16),
      alpha,
    ];
  };

  const mapPointFromStop = (point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { ...point, lat, lng };
  };

  const getKmbStopSequenceGeometry = (stopIds = [], cacheKey = '') => {
    const key = cacheKey || stopIds.join('>');
    const cached = kmbRouteGeometryCacheRef.current.get(key);
    if (cached) return cached;

    const stops = stopIds
      .map((stopId) => ({ id: stopId, ...stopMapRef.current[stopId] }))
      .filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lng));
    const geometry = stops.map((stop) => [stop.lng, stop.lat]);
    const value = { stops, geometry };
    if (geometry.length >= 2 && key) {
      kmbRouteGeometryCacheRef.current.set(key, value);
    }
    return value;
  };

  const getKmbRoadGeometry = async (
    stopIds = [],
    cacheKey = '',
    routeNumber = '',
    operator = 'KMB',
    options = {},
  ) => {
    const fullRoute = options.fullRoute === true;
    const baseKey = cacheKey || stopIds.join('>');
    const key = `${fullRoute ? 'full' : 'segment'}|${baseKey}`;
    const cached = kmbRoadGeometryCacheRef.current.get(key);
    if (cached) return cached;

    const local = getKmbStopSequenceGeometry(stopIds, baseKey);
    if (local.stops.length < 2) return local.geometry;

    try {
      const features = await fetchCsdiRouteFeatures(routeNumber || baseKey.split('|')[0]);
      const csdiGeometry = fullRoute
        ? selectFullCsdiRouteGeometry(features, local.stops, operator)
        : selectCsdiRouteGeometry(
          features,
          local.stops[0],
          local.stops[local.stops.length - 1],
          operator,
        );
      if (csdiGeometry?.length >= 2) {
        kmbRoadGeometryCacheRef.current.set(key, csdiGeometry);
        return csdiGeometry;
      }
    } catch (err) {
      console.warn('CSDI bus route geometry unavailable:', err);
    }

    if (!window.routeEngine?.fetchGCPRoute) return local.geometry;

    try {
      const start = local.stops[0];
      const end = local.stops[local.stops.length - 1];
      const intermediates = local.stops.slice(1, -1);
      const roadInfo = await window.routeEngine.fetchGCPRoute(
        start.lat,
        start.lng,
        end.lat,
        end.lng,
        'driving',
        intermediates,
      );
      const geometry = roadInfo?.geometry?.length >= 2 ? roadInfo.geometry : local.geometry;
      kmbRoadGeometryCacheRef.current.set(key, geometry);
      return geometry;
    } catch (err) {
      console.warn('Google fallback route geometry failed:', err);
      return local.geometry;
    }
  };

  const fallbackLegStopPath = (leg) => [
    leg.origin_stop,
    ...(leg.intermediate_stops || []),
    leg.destination_stop,
  ].map(mapPointFromStop).filter(Boolean);

  const drawFallbackRouteOnMap = async (route) => {
    clearMapGraphics();
    const { Graphic, Polyline, Point, Extent } = arcgisModulesRef.current || {};
    const layer = graphicsLayerRef.current;
    const view = viewRef.current;
    if (!layer || !view || !Graphic || !Polyline || !Point || !Extent) return;

    const allPoints = [];
    const drawPoly = (geometry, color, width = 5, style = 'solid') => {
      if (!geometry || geometry.length < 2) return;
      layer.add(
        new Graphic({
          geometry: new Polyline({
            paths: [geometry],
            spatialReference: { wkid: 4326 },
          }),
          symbol: { type: 'simple-line', color, width, style },
        }),
      );
      geometry.forEach(([lng, lat]) => {
        if (Number.isFinite(lat) && Number.isFinite(lng)) allPoints.push({ lat, lng });
      });
    };

    const addMarker = (point, color, size = 9, isTerminal = false) => {
      const normalized = mapPointFromStop(point);
      if (!normalized) return;
      allPoints.push(normalized);
      layer.add(
        new Graphic({
          geometry: new Point({ x: normalized.lng, y: normalized.lat, spatialReference: { wkid: 4326 } }),
          symbol: {
            type: 'simple-marker',
            style: 'circle',
            color: isTerminal ? color : [255, 255, 255, 0.95],
            size,
            outline: { color, width: isTerminal ? 3 : 2 },
          },
          popupTemplate: { title: getLegStopName(normalized), content: normalized.coordinate_source || normalized.data_source || '' },
          attributes: {
            type: 'station-stop',
            stationName: getLegStopName(normalized),
          },
        }),
      );
    };

    const searchOrigin = mapPointFromStop(route.origin || route.originLoc);
    const searchDestination = mapPointFromStop(route.destination || route.destLoc);
    if (searchOrigin) addMarker(searchOrigin, [34, 197, 94, 0.95], 14, true);

    for (const leg of route.legs || []) {
      const color = colorStringToRgba(getOperatorColor(leg.operator, '#2563EB'));
      const stopPath = fallbackLegStopPath(leg);
      const stationGeometry = stopPath.map((point) => [point.lng, point.lat]);
      let geometry = Array.isArray(leg.geometry) && leg.geometry.length >= 2
        ? leg.geometry
        : stationGeometry;

      if (leg.operator === 'KMB' && leg.source_segment?.stops?.length >= 2) {
        geometry = await getKmbRoadGeometry(
          leg.source_segment.stops,
          leg.source_segment.routeKey || leg.source_segment.stops.join('>'),
          leg.source_segment.route,
          leg.source_segment.routeInfo?.co || leg.operator,
        );
      }

      const isWalking = leg.operator === 'WALK' || leg.mode === 'walking';
      drawPoly(geometry, isWalking ? [100, 116, 139, 0.8] : color, isWalking ? 4 : 6, isWalking ? 'short-dot' : 'solid');
      stopPath.forEach((point, index) => {
        const isTerminal = index === 0 || index === stopPath.length - 1;
        addMarker(point, color, isTerminal ? 11 : 7, isTerminal);
      });
    }

    if (searchDestination) addMarker(searchDestination, [239, 68, 68, 0.95], 14, true);

    if (allPoints.length < 2) return;

    const lats = allPoints.map((point) => point.lat);
    const lngs = allPoints.map((point) => point.lng);
    view.goTo(
      new Extent({
        xmin: Math.min(...lngs) - 0.005,
        ymin: Math.min(...lats) - 0.005,
        xmax: Math.max(...lngs) + 0.005,
        ymax: Math.max(...lats) + 0.005,
        spatialReference: { wkid: 4326 },
      }).expand(1.15),
    ).catch(() => {});
  };

  // Search handler
  const handleSearch = async (e, overrides = {}) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!dataLoaded) return;
    const searchAllowFallback = overrides.allowFallbackNonKmb ?? allowFallbackNonKmb;
    const searchStrictEtaOnly = overrides.strictEtaOnly ?? strictEtaOnly;
    const preserveExistingResults = Boolean(overrides.preserveExistingResults);
    window.routeEngine?.clearEtaCallLog?.();
    setIsLoading(true);
    setSearchError(null);
    setRefreshFeedback(null);
    if (!preserveExistingResults) setResults([]);
    setSelectedRoute(null);
    clearMapGraphics();
    clearRouteOverlay();
    clearStationLabel();

    try {
      let kmbSearchError = null;
      const [originLoc, destLoc] = await Promise.all([
        resolveLocation(origin),
        resolveLocation(destination),
      ]);
      const searchCacheKey = buildSearchCacheKey({
        originLoc,
        destLoc,
        timeMode,
        dateValue,
        timeValue,
        excludedRoutesText,
        allowFallbackNonKmb: searchAllowFallback,
        strictEtaOnly: searchStrictEtaOnly,
      });
      const canReusePlannedSearch = timeMode !== 'now';
      const cachedSearch = canReusePlannedSearch
        ? searchCacheRef.current.get(searchCacheKey)
        : null;

      if (cachedSearch) {
        setResults(cloneRouteResults(cachedSearch));
        setIsSearchOpen(false);
        return;
      }

      setLoadingStatus('Searching routes...');
      let filteredCandidates = [];
      try {
        const routeSearch = await window.routeEngine.findRoutes({
          originLoc,
          destLoc,
          stopMap: stopMapRef.current,
          routeMap: routeMapRef.current,
          routeStops: routeStopsRef.current,
          stopRoutes: stopRoutesRef.current,
          timeMode,
          dateValue,
          timeValue,
          excludedRoutesText,
          strictEtaOnly: searchAllowFallback ? false : searchStrictEtaOnly,
          onProgress: (msg) => setLoadingStatus(msg),
        });
        filteredCandidates = routeSearch.filteredCandidates || [];
      } catch (err) {
        kmbSearchError = err;
        if (!searchAllowFallback) throw err;
      }

      if (filteredCandidates.length === 0 && !searchAllowFallback)
        throw new Error(
          'No routes found. Try different locations or check if bus services are running.',
        );

      let finalResults = filteredCandidates;
      if (searchAllowFallback) {
        const hasValidKmb = filteredCandidates.length > 0;
        const kmbGaps = hasValidKmb
          ? findKmbEtaGaps(filteredCandidates, stopMapRef.current, 3).map((gap) => ({
              ...gap,
              stopMap: stopMapRef.current,
              searchOriginLoc: originLoc,
              searchDestLoc: destLoc,
            }))
          : [{
              isWholeTrip: true,
              route: null,
              routeIndex: 0,
              segment: null,
              segmentIndex: 0,
              originLoc,
              destLoc,
              stopMap: stopMapRef.current,
              searchOriginLoc: originLoc,
              searchDestLoc: destLoc,
            }];

        try {
          let googleAlternatives = [];
          if (kmbGaps.length > 0) {
            setLoadingStatus(hasValidKmb
              ? 'Checking Google Transit for KMB no-ETA gaps...'
              : 'Checking Google Transit because no KMB route is available...');
            const gapRows = await Promise.all(kmbGaps.map(async (gap) => {
              const candidates = await generateGoogleTransitGapCandidates(gap, {
                originLoc,
                destLoc,
                timeMode,
                dateValue,
                timeValue,
              });
              return annotateGapRepairCandidates(candidates, gap);
            }));
            googleAlternatives = gapRows.flat();
          }

          finalResults = rankCombinedTransportOptions([...filteredCandidates, ...googleAlternatives]);
          if (filteredCandidates.length === 0 && googleAlternatives.length === 0) {
            throw new Error(
              'No KMB route found, and Google Transit did not return a usable alternative.',
            );
          }

          if (finalResults.length === 0) {
            throw kmbSearchError || new Error(
              'No routes found. Try different locations or check if services are running.',
            );
          }

          if (canReusePlannedSearch) {
            searchCacheRef.current.set(searchCacheKey, cloneRouteResults(finalResults));
            if (searchCacheRef.current.size > 8) {
              const oldestKey = searchCacheRef.current.keys().next().value;
              searchCacheRef.current.delete(oldestKey);
            }
          }

          setResults(finalResults);
          setIsSearchOpen(false);

          return;
        } catch (fallbackError) {
          if (!hasValidKmb) throw fallbackError;
          const previousAlternatives = preserveExistingResults
            ? (results || []).filter((route) => isFallbackRoute(route))
            : [];
          finalResults = rankCombinedTransportOptions([
            ...filteredCandidates,
            ...previousAlternatives,
          ]);
          console.warn('Google Transit gap repair could not load:', fallbackError);
        }
      }

      if (finalResults.length === 0) {
        throw kmbSearchError || new Error(
          'No routes found. Try different locations or check if services are running.',
        );
      }

      if (canReusePlannedSearch) {
        searchCacheRef.current.set(searchCacheKey, cloneRouteResults(finalResults));
        if (searchCacheRef.current.size > 8) {
          const oldestKey = searchCacheRef.current.keys().next().value;
          searchCacheRef.current.delete(oldestKey);
        }
      }

      setResults(finalResults);
      setIsSearchOpen(false);
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setIsLoading(false);
      setLoadingStatus('');
    }
  };

  // Draw route on map
  const drawRouteOnMap = async (route) => {
    if (isFallbackRoute(route)) {
      await drawFallbackRouteOnMap(route);
      return;
    }
    clearMapGraphics();
    const { Graphic, Polyline, Point, Extent } = arcgisModulesRef.current || {};
    const layer = graphicsLayerRef.current;
    const view = viewRef.current;
    if (!layer || !view || !Graphic) return;

    let allLats = [];
    let allLngs = [];

    const drawPoly = (geometry, color, width = 6, style = 'solid') => {
      if (!geometry || geometry.length < 2) return;
      const paths = geometry.map(([ln, la]) => [ln, la]);
      layer.add(
        new Graphic({
          geometry: new Polyline({
            paths: [paths],
            spatialReference: { wkid: 4326 },
          }),
          symbol: { type: 'simple-line', color, width, style },
        }),
      );
    };

    const addMarker = (lat, lng, color, nameEn, nameTc, size = 10, isTerminal = false) => {
      layer.add(
        new Graphic({
          geometry: new Point({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
          symbol: {
            type: 'simple-marker',
            style: 'circle',
            color: isTerminal ? color : [255, 255, 255],
            size,
            outline: { color, width: isTerminal ? 3 : 2 },
          },
          popupTemplate: { title: nameEn, content: nameTc },
          attributes: {
            type: 'station-stop',
            stationName: nameTc || nameEn || 'Station',
          },
        }),
      );
      allLats.push(lat);
      allLngs.push(lng);
    };

    if (route.walkInfoOrigin?.geometry) {
      drawPoly(route.walkInfoOrigin.geometry, [100, 100, 100, 0.8], 4, 'short-dot');
      allLats.push(route.originLoc.lat);
      allLngs.push(route.originLoc.lng);
      layer.add(
        new Graphic({
          geometry: new Point({
            x: route.originLoc.lng,
            y: route.originLoc.lat,
            spatialReference: { wkid: 4326 },
          }),
          symbol: {
            type: 'simple-marker',
            color: [34, 197, 94],
            size: 14,
            outline: { color: [255, 255, 255], width: 3 },
          },
        }),
      );
    }

    const routeSegments = route.segments || [];
    for (let si = 0; si < routeSegments.length; si++) {
      const seg = routeSegments[si];
      const color = ROUTE_COLORS[si % ROUTE_COLORS.length];
      const { stops: segStops } = getKmbStopSequenceGeometry(
        seg.stops || [],
        seg.routeKey || (seg.stops || []).join('>'),
      );
      const routeGeometry = await getKmbRoadGeometry(
        seg.stops || [],
        seg.routeKey || (seg.stops || []).join('>'),
        seg.route,
        seg.routeInfo?.co || 'KMB',
      );

      if (routeGeometry.length >= 2) drawPoly(routeGeometry, color, 6, 'solid');
      segStops.forEach((s, idx) => {
        const isTerm = idx === 0 || idx === segStops.length - 1;
        addMarker(s.lat, s.lng, color, s.name_en, s.name_tc, isTerm ? 12 : 8, isTerm);
      });
      if (si < routeSegments.length - 1 && route.walkInfoTransfer?.geometry)
        drawPoly(route.walkInfoTransfer.geometry, [100, 100, 100, 0.8], 4, 'short-dot');
    }

    if (route.walkInfoDest?.geometry) {
      drawPoly(route.walkInfoDest.geometry, [100, 100, 100, 0.8], 4, 'short-dot');
      allLats.push(route.destLoc.lat);
      allLngs.push(route.destLoc.lng);
      layer.add(
        new Graphic({
          geometry: new Point({
            x: route.destLoc.lng,
            y: route.destLoc.lat,
            spatialReference: { wkid: 4326 },
          }),
          symbol: {
            type: 'simple-marker',
            color: [239, 68, 68],
            size: 14,
            outline: { color: [255, 255, 255], width: 3 },
          },
        }),
      );
    }

    if (allLats.length > 0) {
      const minLat = Math.min(...allLats);
      const maxLat = Math.max(...allLats);
      const minLng = Math.min(...allLngs);
      const maxLng = Math.max(...allLngs);
      const { Extent: ExtentClass } = arcgisModulesRef.current;
      view.goTo(
        new ExtentClass({
          xmin: minLng - 0.005,
          ymin: minLat - 0.005,
          xmax: maxLng + 0.005,
          ymax: maxLat + 0.005,
          spatialReference: { wkid: 4326 },
        }).expand(1.1),
      );
    }
  };

  const routeNumberFromRoute = (route) => {
    if (!route) return '';
    if (isFallbackRoute(route)) return route.route || route.line || '';
    return (route.segments || [])[0]?.route || '';
  };

  const getOverlayVariantScore = (key, routeNumber) => {
    const stops = routeStopsRef.current[key] || [];
    const selectedSegments = selectedRoute && !isFallbackRoute(selectedRoute)
      ? selectedRoute.segments || []
      : [];
    const sameRouteSegment = selectedSegments.find(
      (seg) => String(seg.route || '').toUpperCase() === routeNumber,
    );
    if (sameRouteSegment?.routeKey === key) return 100000;

    let score = 0;
    if (sameRouteSegment) {
      const fromIndex = stops.indexOf(sameRouteSegment.fromStop);
      const toIndex = stops.indexOf(sameRouteSegment.toStop);
      if (fromIndex !== -1) score += 500;
      if (toIndex !== -1) score += 500;
      if (fromIndex !== -1 && toIndex !== -1 && fromIndex < toIndex) score += 5000;
    }

    const selectedDestinationStop = selectedSegments[selectedSegments.length - 1]?.toStop;
    const destinationIndex = selectedDestinationStop
      ? stops.indexOf(selectedDestinationStop)
      : -1;
    if (destinationIndex !== -1) {
      score += 250 + destinationIndex;
    }

    const originPoint = mapPointFromStop(
      selectedRoute?.searchOriginLoc || selectedRoute?.originLoc || selectedRoute?.origin || originLoc,
    );
    const destinationPoint = mapPointFromStop(
      selectedRoute?.searchDestLoc || selectedRoute?.destLoc || selectedRoute?.destination || destLoc,
    );
    const nearestStop = (point) => {
      if (!point || stops.length === 0) return null;
      return stops.reduce((best, stopId, index) => {
        const stop = stopMapRef.current[stopId];
        if (!Number.isFinite(stop?.lat) || !Number.isFinite(stop?.lng)) return best;
        const distance = haversine(point.lat, point.lng, stop.lat, stop.lng);
        return !best || distance < best.distance ? { index, distance } : best;
      }, null);
    };
    const originMatch = nearestStop(originPoint);
    const destinationMatch = nearestStop(destinationPoint);
    if (originMatch) score += Math.max(0, 2500 - originMatch.distance * 800);
    if (destinationMatch) score += Math.max(0, 5000 - destinationMatch.distance * 1500);
    if (originMatch && destinationMatch) {
      score += originMatch.index < destinationMatch.index ? 6000 : -6000;
    }
    if (destinationPoint && stops.length > 0) {
      const terminal = stopMapRef.current[stops[stops.length - 1]];
      if (Number.isFinite(terminal?.lat) && Number.isFinite(terminal?.lng)) {
        const terminalDistance = haversine(
          destinationPoint.lat,
          destinationPoint.lng,
          terminal.lat,
          terminal.lng,
        );
        score += Math.max(0, 3000 - terminalDistance * 500);
      }
    }

    const selectedRouteNumber = routeNumberFromRoute(selectedRoute).toUpperCase();
    if (selectedRouteNumber === routeNumber) score += 100;
    return score;
  };

  const selectBestOverlayVariant = (variantKeys, routeNumber) => {
    const ranked = variantKeys
      .map((key) => ({ key, score: getOverlayVariantScore(key, routeNumber) }))
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.key || variantKeys[0];
  };

  const drawFullKmbRouteOverlay = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    const routeNumber = (overlayRouteNumber || routeNumberFromRoute(selectedRoute)).trim().toUpperCase();
    const { Graphic, Polyline, Point, Extent } = arcgisModulesRef.current || {};
    const layer = routeOverlayLayerRef.current;
    const stopLayer = routeOverlayStopLayerRef.current;
    const view = viewRef.current;
    if (!routeNumber || !layer || !stopLayer || !view || !Graphic || !Polyline || !Point || !Extent) return;

    setIsOverlayLoading(true);
    setOverlayFeedback(null);
    layer.removeAll();
    stopLayer.removeAll();

    try {
      const variantKeys = Object.keys(routeStopsRef.current || {})
        .filter((key) => key.split('|')[0]?.toUpperCase() === routeNumber);
      const seenPatterns = new Set();
      const uniqueVariants = variantKeys.filter((key) => {
        const pattern = (routeStopsRef.current[key] || []).join('>');
        if (!pattern || seenPatterns.has(pattern)) return false;
        seenPatterns.add(pattern);
        return true;
      });

      if (uniqueVariants.length === 0) {
        setOverlayFeedback(`No KMB route found for ${routeNumber}`);
        return;
      }

      const selectedVariant = selectBestOverlayVariant(uniqueVariants, routeNumber);
      const pointsForExtent = [];
      for (const key of [selectedVariant]) {
        const stopIds = routeStopsRef.current[key] || [];
        const { stops } = getKmbStopSequenceGeometry(stopIds, key);
        const geometry = await getKmbRoadGeometry(
          stopIds,
          key,
          routeNumber,
          routeMapRef.current[key]?.co || 'KMB',
          { fullRoute: true },
        );
        if (stops.length < 2 || geometry.length < 2) continue;

        layer.add(
          new Graphic({
            geometry: new Polyline({
              paths: [geometry],
              spatialReference: { wkid: 4326 },
            }),
            symbol: {
              type: 'simple-line',
              color: [124, 58, 237, 0.32],
              width: 7,
              style: 'solid',
            },
            attributes: { type: 'route-overlay', route: routeNumber, routeKey: key },
          }),
        );

        stops.forEach((stop, index) => {
          pointsForExtent.push(stop);
          const isTerminal = index === 0 || index === stops.length - 1;
          const stationName = getStopDisplayName(stop);
          stopLayer.add(
            new Graphic({
              geometry: new Point({ x: stop.lng, y: stop.lat, spatialReference: { wkid: 4326 } }),
              symbol: {
                type: 'simple-marker',
                style: 'circle',
                color: [124, 58, 237, 0.01],
                size: 32,
                outline: { color: [124, 58, 237, 0.01], width: 1 },
              },
              attributes: {
                type: 'station-stop',
                source: 'route-overlay',
                stationName,
              },
            }),
          );
          stopLayer.add(
            new Graphic({
              geometry: new Point({ x: stop.lng, y: stop.lat, spatialReference: { wkid: 4326 } }),
              symbol: {
                type: 'simple-marker',
                style: 'circle',
                color: isTerminal
                  ? [124, 58, 237, 0.95]
                  : [124, 58, 237, 0.9],
                size: isTerminal ? 14 : 10,
                outline: { color: [255, 255, 255, 0.96], width: 2.5 },
              },
              attributes: {
                type: 'station-stop',
                source: 'route-overlay',
                stationName,
              },
              popupTemplate: { title: stationName },
            }),
          );
        });
      }

      if (pointsForExtent.length > 1) {
        const lats = pointsForExtent.map((point) => point.lat);
        const lngs = pointsForExtent.map((point) => point.lng);
        view.goTo(
          new Extent({
            xmin: Math.min(...lngs) - 0.005,
            ymin: Math.min(...lats) - 0.005,
            xmax: Math.max(...lngs) + 0.005,
            ymax: Math.max(...lats) + 0.005,
            spatialReference: { wkid: 4326 },
          }).expand(1.15),
        ).catch(() => {});
      }
      const direction = selectedVariant.split('|')[1] || '';
      const destination = routeMapRef.current[selectedVariant]?.dest_en
        || routeMapRef.current[selectedVariant]?.dest_tc
        || '';
      setOverlayFeedback(
        `Showing ${routeNumber} ${direction}${destination ? ` toward ${destination}` : ''}`.trim(),
      );
    } catch (error) {
      console.error('Unable to draw full KMB route overlay:', error);
      setOverlayFeedback(`Could not show the full route for ${routeNumber}`);
    } finally {
      setIsOverlayLoading(false);
    }
  };

  const loadSelectedCurrentEtas = useCallback(async (segments) => {
    const requestId = selectedEtaRequestRef.current + 1;
    selectedEtaRequestRef.current = requestId;
    setIsLoadingSelectedEtas(true);
    setSelectedCurrentEtas(new Map());
    setSelectedEtaUpdatedAt(null);

    const optionMap = new Map();
    for (const segment of segments || []) {
      const options = segment?.routeOptions?.length > 0
        ? segment.routeOptions
        : [segment];
      for (const option of options) {
        const normalized = {
          ...option,
          fromStop: option?.fromStop || segment?.fromStop,
        };
        if (!normalized.fromStop || !normalized.route) continue;
        optionMap.set(kmbEtaOptionKey(normalized), normalized);
      }
    }

    try {
      window.routeEngine?.clearETACache?.();
      const entries = await Promise.all(
        Array.from(optionMap.entries()).map(async ([key, option]) => {
          const rows = await window.routeEngine.fetchETA(
            option.fromStop,
            option.route,
            option.service_type || '1',
          );
          const currentRows = (rows || [])
            .filter((row) => row?.eta)
            .sort((a, b) => new Date(a.eta) - new Date(b.eta));
          return [key, currentRows];
        }),
      );
      if (selectedEtaRequestRef.current === requestId) {
        setSelectedCurrentEtas(new Map(entries));
        setSelectedEtaUpdatedAt(new Date());
      }
    } finally {
      if (selectedEtaRequestRef.current === requestId) {
        setIsLoadingSelectedEtas(false);
      }
    }
  }, []);

  // Select route handler
  const handleSelectRoute = (cardOrRoute) => {
    const isCard = Boolean(cardOrRoute?.representative && cardOrRoute?.segmentDisplay);
    const baseRoute = isCard ? cardOrRoute.representative : cardOrRoute;
    if (!baseRoute) return;
    const initialSegmentDisplay = isCard ? cardOrRoute.segmentDisplay : baseRoute.segments || [];

    setSelectedRoute({ ...baseRoute, segmentDisplay: initialSegmentDisplay });
    setOverlayRouteNumber(routeNumberFromRoute(baseRoute));
    setOverlayFeedback(null);
    setExpandedSegments(new Set());
    drawRouteOnMap(baseRoute);
    if (!isFallbackRoute(baseRoute)) {
      loadSelectedCurrentEtas(initialSegmentDisplay);
    }
  };

  const handleRefreshEtaSession = useCallback(async () => {
    if (isLoading || isRefreshingEta || results.length === 0) return;

    setIsRefreshingEta(true);
    setRefreshFeedback({
      type: 'loading',
      message: 'Refreshing arrival times...',
    });

    try {
      window.routeEngine?.clearETACache?.();
      const refreshedResults = (
        await Promise.all(results.map((route) => refreshRouteTiming(route)))
      ).filter(Boolean);

      setResults(refreshedResults);

      if (refreshedResults.length === 0) {
        setSelectedRoute(null);
        clearMapGraphics();
        setRefreshFeedback({
          type: 'error',
          message: 'No catchable routes are available right now.',
        });
        return;
      }

      if (selectedRoute) {
        const latestBaseRoute =
          refreshedResults.find((route) => route.id === selectedRoute.id) || selectedRoute;
        const refreshedSelectedRoute = refreshedResults.find(
          (route) => route.id === selectedRoute.id,
        );

        if (!refreshedSelectedRoute) {
          setSelectedRoute(null);
          clearMapGraphics();
        } else {
          setSelectedRoute({
            ...selectedRoute,
            ...latestBaseRoute,
            segmentDisplay: isFallbackRoute(latestBaseRoute)
              ? selectedRoute.segmentDisplay || []
              : latestBaseRoute.segments || [],
          });
        }
      }

      const refreshedAt = new Date();
      setLastEtaRefreshAt(refreshedAt);
      setRefreshFeedback({
        type: 'success',
        message: `Updated at ${formatRefreshTime(refreshedAt)}`,
      });
    } catch {
      setRefreshFeedback({
        type: 'error',
        message: 'Refresh failed. Please try again.',
      });
    } finally {
      setIsRefreshingEta(false);
    }
  }, [
    formatRefreshTime,
    isLoading,
    isRefreshingEta,
    refreshRouteTiming,
    results,
    selectedRoute,
  ]);

  // Add to bookmark
  const handleAddToBookmark = (stopId, stopName, routesAtStop) => {
    setAddToBookmark({ stopId, stopName, routes: routesAtStop });
  };

  const confirmAddBookmark = (groupIndex) => {
    const updated = window.bookmarkEngine.addStop(bookmarks, groupIndex, addToBookmark);
    setBookmarks(updated);
    setAddToBookmark(null);
  };

  const downloadEtaCallLog = useCallback(() => {
    const text =
      window.routeEngine?.formatEtaCallLogTxt?.() ||
      'No ETA calls captured in this session.';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kmb-eta-call-log.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleSwapLocations = () => {
    const fromValue = origin;
    const toValue = destination;
    setOrigin(toValue);
    setDestination(fromValue);
  };

  const zoomToLocation = useCallback((lat, lng) => {
    const view = viewRef.current;
    if (!view) return;
    const Point = arcgisModulesRef.current?.Point;
    const target = Point
      ? new Point({ x: lng, y: lat, spatialReference: { wkid: 4326 } })
      : { longitude: lng, latitude: lat };
    view.goTo({ target, scale: 1000 }).catch(() => {});
  }, []);

  const handleUseCurrentLocation = async () => {
    if (!navigator.geolocation) {
      setSearchError('GPS is not supported on this device/browser.');
      return;
    }
    setIsLocating(true);
    setSearchError(null);
    try {
      const position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 30000,
        }),
      );
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      setOrigin(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
      currentLocationRef.current = { lat, lng };
      renderCurrentLocationMarker(lat, lng);
      zoomToLocation(lat, lng);
    } catch (err) {
      const msg =
        err?.code === 1
          ? 'Location permission denied. Please allow GPS permission.'
          : err?.code === 2
            ? 'Unable to get current location.'
            : err?.code === 3
              ? 'GPS request timed out. Please try again.'
              : 'Failed to get current location.';
      setSearchError(msg);
    } finally {
      setIsLocating(false);
    }
  };

  const startRouteDetailResize = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = routeDetailHeight;

    const handlePointerMove = (moveEvent) => {
      moveEvent.preventDefault();
      const viewportHeight = window.innerHeight || 1;
      const deltaVh = ((startY - moveEvent.clientY) / viewportHeight) * 100;
      setRouteDetailHeight(clampRouteDetailHeight(startHeight + deltaVh));
    };
    const stopResize = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, [routeDetailHeight]);

  const changeRouteDetailHeight = useCallback((height) => {
    setRouteDetailHeight(clampRouteDetailHeight(height));
  }, []);

  const detailSegments = selectedRoute?.segmentDisplay || selectedRoute?.segments || [];

  useEffect(() => {
    if (results.length === 0) setIsResultsMinimized(false);
  }, [results.length]);

  useEffect(() => {
    if (isSearchOpen && results.length > 0 && !selectedRoute && !showBookmarks) {
      setIsResultsMinimized(true);
    }
  }, [isSearchOpen, results.length, selectedRoute, showBookmarks]);

  useEffect(() => {
    if (!refreshFeedback) return;
    const timeout = setTimeout(() => setRefreshFeedback(null), 5000);
    return () => clearTimeout(timeout);
  }, [refreshFeedback]);

  // RENDER
  return (
    <div className="relative h-full w-full bg-slate-100 flex flex-col font-sans">
      <div ref={mapRef} className="absolute inset-0 z-0" />

      {/* Header */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 p-4 transition-all ${
          isSearchOpen ? 'bg-white shadow-xl' : ''
        }`}
      >
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 bg-white/80 backdrop-blur p-2 rounded-2xl border border-white/50 shadow-sm">
            {/* Replaced CSS Icon with PWA Image */}
            <img src="/pwa-192x192.png" alt="KMB Bus" className="w-10 h-10 rounded-xl shadow-sm object-contain" />
            
            <h1 className="text-xl font-black italic uppercase tracking-tighter">
              KMB <span className="text-[#E1251B]">Route Master</span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowBookmarks((v) => !v);
                setIsSearchOpen(false);
              }}
              className="p-3 bg-white rounded-2xl shadow-md text-xl"
              title="Bookmarks"
            >
              {'\u2B50'}
            </button>
            <button
              onClick={() => {
                setIsSearchOpen((v) => {
                  const next = !v;
                  if (next && results.length > 0 && !selectedRoute && !showBookmarks) {
                    setIsResultsMinimized(true);
                  }
                  return next;
                });
                setShowBookmarks(false);
              }}
              className="p-3 bg-white rounded-2xl shadow-md text-xl"
            >
              {isSearchOpen ? '\u2715' : '\uD83D\uDD0D'}
            </button>
          </div>
        </div>

        {isSearchOpen && (
          <form onSubmit={handleSearch} className="max-w-xl mx-auto mt-4 space-y-3">
            <div className="bg-slate-50 p-2 rounded-2xl flex items-center justify-between border border-slate-200">
              <div className="flex gap-2">
                {['now', 'leave', 'arrive'].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setTimeMode(mode)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
                      timeMode === mode
                        ? 'bg-[#E1251B] text-white'
                        : 'bg-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {mode === 'now' ? 'Now' : mode === 'leave' ? 'Leave At' : 'Arrive By'}
                  </button>
                ))}
              </div>
              {timeMode !== 'now' && (
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={timeValue}
                    onChange={(e) => setTimeValue(e.target.value)}
                    className="bg-transparent text-sm font-bold text-slate-700 outline-none cursor-pointer"
                  />
                  <input
                    type="date"
                    value={dateValue}
                    onChange={(e) => setDateValue(e.target.value)}
                    className="bg-transparent text-sm font-bold text-slate-700 outline-none w-5 cursor-pointer"
                    style={{ color: 'transparent', textShadow: '0 0 0 #334155' }}
                  />
                </div>
              )}
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-start">
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <AutocompleteInput
                    placeholder="From... (e.g. Mong Kok)"
                    value={origin}
                    onChange={setOrigin}
                    onClear={() => setOrigin('')}
                  />
                  <button
                    type="button"
                    onClick={handleUseCurrentLocation}
                    disabled={isLocating}
                    className="h-[52px] px-3 rounded-xl bg-white border border-slate-200 text-xs font-bold text-slate-600 hover:text-[#E1251B] hover:border-[#E1251B] transition disabled:opacity-50"
                    title="Use current GPS location"
                  >
                    {isLocating ? 'Locating...' : 'Use GPS'}
                  </button>
                </div>
                <AutocompleteInput
                  placeholder="To... (e.g. Tsim Sha Tsui)"
                  value={destination}
                  onChange={setDestination}
                  onClear={() => setDestination('')}
                />
              </div>
              <button
                type="button"
                onClick={handleSwapLocations}
                className="h-[52px] px-3 rounded-xl bg-white border border-slate-200 text-xs font-bold text-slate-600 hover:text-[#E1251B] hover:border-[#E1251B] transition"
                title="Swap From and To"
              >
                Swap
              </button>
            </div>
            <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white/90 p-3 text-xs font-bold text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allowFallbackNonKmb}
                onChange={(e) => setAllowFallbackNonKmb(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#E1251B] focus:ring-[#E1251B]"
              />
              <span className="leading-snug">
                Use Google Transit for KMB unavailable gaps
                <span className="block text-[11px] font-semibold text-slate-400">
                  Keeps KMB results, then asks Google for segments with no ETA or no KMB route.
                </span>
              </span>
            </label>
            <button
              type="submit"
              disabled={isLoading || !dataLoaded}
              className="w-full py-4 bg-[#E1251B] text-white rounded-2xl font-black italic uppercase shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <span className="animate-spin">{'\u23F3'}</span> {loadingStatus || 'Searching...'}
                </>
              ) : !dataLoaded ? (
                <>
                  <span className="animate-pulse">{'\u{1F4E1}'}</span> {loadingStatus}
                </>
              ) : (
                'Search Routes'
              )}
            </button>
            {searchError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm font-bold">
                {'\u26A0\uFE0F'} {searchError}
              </div>
            )}
          </form>
        )}
      </div>

      {/* Loading overlay */}
      {!dataLoaded && !isSearchOpen && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 bg-white/90 backdrop-blur px-6 py-4 rounded-2xl shadow-xl text-sm font-bold text-slate-600">
          {'\u{1F5FA}\uFE0F'} {loadingStatus}
        </div>
      )}

      {selectedRoute && !showBookmarks && (
        <form
          onSubmit={drawFullKmbRouteOverlay}
          className="absolute top-[88px] right-3 z-30 w-[min(92vw,300px)] rounded-2xl border border-slate-200 bg-white/90 backdrop-blur p-2 shadow-xl"
        >
          <div className="flex items-center gap-2">
            <input
              value={overlayRouteNumber}
              onChange={(e) => setOverlayRouteNumber(e.target.value.toUpperCase())}
              placeholder="Bus route"
              className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-black uppercase text-slate-700 outline-none focus:border-[#E1251B]"
            />
            <button
              type="submit"
              disabled={isOverlayLoading || !overlayRouteNumber.trim()}
              className="shrink-0 rounded-xl bg-[#E1251B] px-3 py-2 text-xs font-black text-white shadow-sm disabled:opacity-50"
              title="Show full route transparently on map"
            >
              {isOverlayLoading ? '...' : 'View'}
            </button>
            <button
              type="button"
              onClick={clearRouteOverlay}
              className="shrink-0 rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs font-black text-slate-500"
              title="Clear full-route overlay"
            >
              Clear
            </button>
          </div>
          {overlayFeedback && (
            <div className="mt-1 truncate px-1 text-[10px] font-bold text-slate-500">
              {overlayFeedback}
            </div>
          )}
        </form>
      )}

      {/* Bookmark panel */}
      {showBookmarks && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl max-h-[60vh] overflow-y-auto scrollbar-hide slide-up">
          <BookmarkPanel
            stopMap={stopMapRef.current}
            stopRoutes={stopRoutesRef.current}
            onClose={() => setShowBookmarks(false)}
            bookmarks={bookmarks}
            setBookmarks={setBookmarks}
          />
        </div>
      )}

      {/* Results panel */}
      {results.length > 0 && !selectedRoute && !showBookmarks && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl scrollbar-hide slide-up flex flex-col ${
            isResultsMinimized ? 'max-h-[110px] overflow-hidden' : 'max-h-[70vh] md:max-h-[60vh] overflow-y-auto'
          }`}
        >
          <div className="mb-3 shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">
                {displayedResultCards.length} Route{displayedResultCards.length > 1 ? 's' : ''}{' '}
                Found
              </h2>
              {lastEtaRefreshAt && (
                <div className="text-[11px] text-slate-500 font-semibold mt-1">
                  Last refreshed: {formatRefreshTime(lastEtaRefreshAt)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRefreshEtaSession}
                disabled={isRefreshingEta || isLoading}
                className="text-[11px] font-bold text-[#E1251B] border border-[#E1251B]/30 rounded-lg px-2 py-1 hover:bg-[#E1251B]/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isRefreshingEta ? 'Refreshing...' : 'Refresh ETA'}
              </button>
              <button
                type="button"
                onClick={() => setIsResultsMinimized((v) => !v)}
                className="text-[11px] font-bold text-slate-500 hover:text-[#E1251B] border border-slate-200 rounded-lg px-2 py-1"
              >
                {isResultsMinimized ? 'Expand' : 'Minimize'}
              </button>
            </div>
          </div>
          {refreshFeedback && (
            <div
              aria-live="polite"
              className={`mb-3 p-2 border rounded-xl text-xs font-bold ${refreshStatusClass}`}
            >
              {refreshFeedback.message}
            </div>
          )}
          {!isResultsMinimized && (
            <>
          <label className="mb-3 shrink-0 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-bold text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowFallbackNonKmb}
              onChange={(e) => {
                const next = e.target.checked;
                setAllowFallbackNonKmb(next);
                if (!isLoading) {
                  setTimeout(
                    () => handleSearch(null, {
                      allowFallbackNonKmb: next,
                      preserveExistingResults: next,
                    }),
                    0,
                  );
                }
              }}
              disabled={isLoading}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#E1251B] focus:ring-[#E1251B] disabled:opacity-50"
            />
            <span className="leading-snug">
              Use Google Transit for KMB unavailable gaps
              <span className="block text-[11px] font-semibold text-slate-400">
                Re-runs this search and asks Google Transit only for missing/no-ETA KMB gaps.
              </span>
            </span>
          </label>
          <label className="mb-3 shrink-0 flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={strictEtaOnly}
              onChange={(e) => {
                const next = e.target.checked;
                setStrictEtaOnly(next);
                if (!isLoading) {
                  setTimeout(
                    () => handleSearch(null, {
                      strictEtaOnly: next,
                      allowFallbackNonKmb,
                      preserveExistingResults: true,
                    }),
                    0,
                  );
                }
              }}
              disabled={timeMode !== 'now'}
              className="h-4 w-4 rounded border-slate-300 text-[#E1251B] focus:ring-[#E1251B]"
            />
            {timeMode === 'now'
              ? 'Strict ETA filter (show only routes where every segment has active ETA now)'
              : 'Strict ETA filter is available only for Now mode'}
          </label>
          <div className="mb-3 shrink-0">
            <button
              onClick={downloadEtaCallLog}
              className="text-[11px] font-bold text-[#E1251B] hover:underline"
            >
              Download KMB ETA call log (.txt)
            </button>
          </div>

          {/* Filter Section */}
          {/* <div className="mb-4 shrink-0 bg-slate-50 p-3 rounded-2xl border border-slate-200">
            <div className="text-xs font-bold text-slate-500 mb-2 flex justify-between items-center">
              <span>FILTER ROUTES</span>
              {excludedRoutesText && (
                <button
                  onClick={() => {
                    setExcludedRoutesText('');
                    setTimeout(() => handleSearch(), 0);
                  }}
                  className="text-[#E1251B] hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mb-2">
              {availableFilterRoutes
                .map((r) => {
                  const isExcluded = excludedRoutesText
                    .toUpperCase()
                    .split(/[\s,]+/)
                    .includes(r.toUpperCase());
                  return (
                    <button
                      key={r}
                      onClick={() => {
                        let current = excludedRoutesText
                          .toUpperCase()
                          .split(/[\s,]+/)
                          .filter(Boolean);
                        if (isExcluded) current = current.filter((x) => x !== r);
                        else current.push(r.toUpperCase());
                        const newText = current.join(', ');
                        setExcludedRoutesText(newText);
                      }}
                      className={`px-3 py-1 rounded-lg text-sm font-bold transition-all border ${
                        isExcluded
                          ? 'bg-slate-200 text-slate-400 border-slate-300'
                          : 'bg-white text-slate-700 border-slate-300 hover:border-[#E1251B] hover:text-[#E1251B]'
                      }`}
                    >
                      {r} {isExcluded && '\u2715'}
                    </button>
                  );
                })}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Or type routes to hide..."
                value={excludedRoutesText}
                onChange={(e) => setExcludedRoutesText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 p-3 bg-white rounded-xl font-bold border border-slate-200 uppercase placeholder:normal-case focus:ring-2 focus:ring-[#E1251B]/50 outline-none text-sm"
              />
              <button
                onClick={() => handleSearch()}
                disabled={isLoading}
                className="px-4 bg-[#E1251B] text-white rounded-xl font-bold text-sm hover:bg-red-700 transition"
              >
                Apply
              </button>
            </div>
          </div> */}
        {/* Filter Section - Expandable */}
        <div className="mb-4 shrink-0 bg-white/80 backdrop-blur rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Accordion Header */}
        <button 
            onClick={() => setIsFilterExpanded(!isFilterExpanded)}
            className="w-full flex items-center justify-between p-3 hover:bg-slate-50 transition-colors"
        >
            <div className="flex items-center gap-2">
            <span className="text-sm">{'\u{1F9EA}'}</span>
            <span className="text-xs font-black italic uppercase tracking-tighter text-slate-800">Filter Routes</span>
            </div>
            <div className="flex items-center gap-3">
            {excludedRoutesText && !isFilterExpanded && (
                <span className="text-[10px] bg-red-50 text-[#E1251B] px-2 py-0.5 rounded-full font-bold border border-red-100">
                Active Filters
                </span>
            )}
            <span className={`text-[#E1251B] text-xs font-bold transform transition-transform duration-300 ${isFilterExpanded ? 'rotate-180' : ''}`}>
                {isFilterExpanded ? '\u25B2' : '\u25BC'}
            </span>
            </div>
        </button>

        {/* Expandable Content */}
        {isFilterExpanded && (
            <div className="p-3 pt-0 border-t border-slate-100 bg-slate-50/50">
            <div className="text-[10px] font-bold text-slate-400 mt-2 mb-2 flex justify-between items-center uppercase tracking-widest">
                <span>Quick Select to Hide</span>
                {excludedRoutesText && (
                <button
                    onClick={() => {
                    setExcludedRoutesText('');
                    // Optional: auto-search after clear
                    setTimeout(() => handleSearch(), 0);
                    }}
                    className="text-[#E1251B] hover:underline normal-case"
                >
                    Clear All
                </button>
                )}
            </div>

            <div className="flex flex-wrap gap-2 mb-3">
                {availableFilterRoutes
                .map((r) => {
                    const isExcluded = excludedRoutesText
                    .toUpperCase()
                    .split(/[\s,]+/)
                    .includes(r.toUpperCase());
                    return (
                    <button
                        key={r}
                        onClick={() => {
                        let current = excludedRoutesText
                            .toUpperCase()
                            .split(/[\s,]+/)
                            .filter(Boolean);
                        if (isExcluded) current = current.filter((x) => x !== r);
                        else current.push(r.toUpperCase());
                        setExcludedRoutesText(current.join(', '));
                        }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border shadow-sm ${
                        isExcluded
                            ? 'bg-slate-200 text-slate-400 border-slate-300'
                            : 'bg-white text-slate-700 border-slate-200 hover:border-[#E1251B] hover:text-[#E1251B]'
                        }`}
                    >
                        {r} {isExcluded ? '\u2715' : '+'}
                    </button>
                    );
                })}
            </div>

            <div className="flex gap-2">
                <input
                type="text"
                placeholder="Or type routes (e.g. 960, 968)..."
                value={excludedRoutesText}
                onChange={(e) => setExcludedRoutesText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 p-2.5 bg-white rounded-xl font-bold border border-slate-200 uppercase placeholder:normal-case focus:ring-2 focus:ring-[#E1251B]/50 outline-none text-xs"
                />
                <button
                onClick={() => {
                    setIsFilterExpanded(false); // Auto-collapse on apply
                    handleSearch();
                }}
                disabled={isLoading}
                className="px-4 bg-[#E1251B] text-white rounded-xl font-bold text-xs hover:bg-red-700 transition shadow-md active:scale-95"
                >
                Apply
                </button>
            </div>
            </div>
        )}
        </div>

          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-hide">
            {displayedResultCards.length === 0 && strictEtaOnly && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-xs font-bold text-amber-700">
                No routes match strict ETA filter right now. Try turning off strict ETA filter.
              </div>
            )}
            {displayedResultCards.map((card) => (
              card.type === 'fallback' ? (
                <div
                  key={card.key}
                  className="p-4 bg-blue-50 rounded-2xl border-2 border-blue-100 cursor-pointer hover:border-blue-500 transition-colors"
                  onClick={() => handleSelectRoute(card)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-2 text-[11px] font-black uppercase tracking-wide text-blue-700">
                        {card.representative.optionLabel || 'Alternative transport option'}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-black text-lg text-slate-800">
                          {card.representative.route || card.representative.line}
                        </span>
                        {parseOperatorCodes(card.representative.operator).map((operatorCode) => (
                          <span
                            key={operatorCode}
                            className={`px-1 py-[1px] rounded text-[9px] leading-none font-black ${getOperatorBadgeClass(operatorCode)}`}
                          >
                            {getOperatorDisplayName(operatorCode)}
                          </span>
                        ))}
                      </div>
                      <div className="text-xs text-slate-500 mt-2 flex flex-wrap gap-2">
                        <span>
                          {card.representative.transfers === 0
                            ? 'Direct'
                            : `${card.representative.transfers} transfer${card.representative.transfers > 1 ? 's' : ''}`}
                        </span>
                        <span>{'\u00B7'} Walk {card.representative.walk_distance_m}m</span>
                        <span>{'\u00B7'} {formatHybridFare(card.representative)}</span>
                      </div>
                      {card.representative.repairReason && (
                        <div className="mt-2 text-[11px] font-bold text-blue-600">
                          {card.representative.repairReason}
                        </div>
                      )}
                      {(() => {
                        const plannedClock = plannedJourneyClock(card.representative);
                        if (!plannedClock) return null;
                        return (
                          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-black text-blue-700">
                            {plannedClock.depart && (
                              <span className="rounded-full border border-blue-200 bg-white px-2 py-1">
                                Depart by {plannedClock.depart}
                              </span>
                            )}
                            {plannedClock.arrive && (
                              <span className="rounded-full border border-blue-200 bg-white px-2 py-1">
                                Arrive {plannedClock.arrive}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-blue-700 font-bold text-lg">
                        ~{card.representative.estimated_time_min}min
                      </div>
                      <div className="text-[11px] text-slate-400 font-bold">
                        confidence {Math.round((card.representative.confidence || 0) * 100)}%
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key={card.key}
                  className="p-4 bg-slate-50 rounded-2xl border-2 border-slate-100 cursor-pointer hover:border-[#E1251B] transition-colors"
                  onClick={() => handleSelectRoute(card)}
                >
                  {(() => {
                    const validity = plannedTimeValidity(card.representative, timeMode);
                    if (!validity) return null;
                    return (
                      <div className="mb-2">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${validity.className}`}
                        >
                          {validity.label}
                        </span>
                      </div>
                    );
                  })()}
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-black text-lg flex items-center gap-2 flex-wrap">
                        {card.segmentDisplay.map((seg, si) => (
                          <React.Fragment key={si}>
                            {si > 0 && <span className="text-slate-300 text-sm">{'\u2192'}</span>}
                            <div className="flex flex-col items-start gap-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="px-2 py-0.5 rounded-lg text-white text-sm"
                                  style={{
                                    backgroundColor: ROUTE_COLORS[si % ROUTE_COLORS.length],
                                  }}
                                >
                                  {seg.routeLabel || seg.route}
                                </span>
                              </div>
                              {seg.routeOptions && seg.routeOptions.length > 0 ? (
                                <div className="flex flex-wrap gap-1 max-w-full sm:max-w-[220px]">
                                  {seg.routeOptions.map((option) => {
                                    const variantRemark = kmbVariantRemark(option);
                                    return (
                                      <div
                                        key={`${option.route}|${option.bound || ''}|${option.service_type || '1'}`}
                                        className="flex flex-col items-start gap-0.5"
                                      >
                                        <span
                                          className={`text-[10px] leading-none whitespace-nowrap px-2 py-1 rounded-full border ${getEtaChipClass(option.nextEta)}`}
                                        >
                                          {option.route}: {getEtaText(option.nextEta)}
                                        </span>
                                        {variantRemark && (
                                          <span className="max-w-[220px] rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-bold leading-tight text-amber-700">
                                            {variantRemark}
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : seg.nextEta ? (
                                <span className="text-[10px] text-[#E1251B] leading-none whitespace-nowrap">
                                  Next bus: {getEtaText(seg.nextEta)}
                                </span>
                              ) : seg.busInterval ? (
                                <span className="text-[10px] text-slate-400 leading-none whitespace-nowrap">
                                  Next bus: ~{seg.busInterval} mins
                                </span>
                              ) : null}
                            </div>
                          </React.Fragment>
                        ))}
                      </div>
                      <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-2">
                        <span>
                          {card.representative.transfers === 0
                            ? 'Direct'
                            : `${card.representative.transfers} transfer${card.representative.transfers > 1 ? 's' : ''}`}
                        </span>
                        <span>{'\u00B7'} {card.representative.totalStops} stops</span>
                        {card.representative.walkTimeOrigin > 0 && (
                          <span>{'\u00B7'} {'\u{1F6B6}'} {card.representative.walkTimeOrigin}min walk</span>
                        )}
                        {card.representative.originWaitTime > 0 && (
                          <span>{'\u00B7'} {'\u23F1'} {card.representative.originWaitTime}min wait</span>
                        )}
                      </div>
                      {(() => {
                        const plannedClock = plannedJourneyClock(card.representative);
                        if (!plannedClock) return null;
                        return (
                          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-black text-slate-600">
                            {plannedClock.depart && (
                              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">
                                Depart by {plannedClock.depart}
                              </span>
                            )}
                            {plannedClock.arrive && (
                              <span className="rounded-full border border-slate-200 bg-white px-2 py-1">
                                Arrive {plannedClock.arrive}
                              </span>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="text-right">
                      <div className="text-[#E1251B] font-bold text-lg">
                        ~{card.representative.estimatedTime}min
                      </div>
                    </div>
                  </div>
                </div>
              )
            ))}
          </div>
            </>
          )}
        </div>
      )}

      {/* Selected fallback detail */}
      {selectedRoute && isFallbackRoute(selectedRoute) && !showBookmarks && (
        <div
          className="absolute bottom-0 left-0 right-0 z-20 overflow-y-auto rounded-t-[2rem] bg-white p-4 shadow-2xl scrollbar-hide slide-up"
          style={{ height: `${routeDetailHeight}vh` }}
        >
          <RouteDetailResizeHandle
            height={routeDetailHeight}
            onPointerDown={startRouteDetailResize}
            onChange={changeRouteDetailHeight}
          />
          <div className="flex items-center justify-between gap-3 mb-3">
            <button
              onClick={() => {
                selectedEtaRequestRef.current += 1;
                setSelectedCurrentEtas(new Map());
                setIsLoadingSelectedEtas(false);
                setSelectedEtaUpdatedAt(null);
                setSelectedRoute(null);
                clearMapGraphics();
                clearRouteOverlay();
                clearStationLabel();
              }}
              className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"
            >
              {'\u2190'} Back
            </button>
            <span className="text-[11px] font-black uppercase tracking-wide text-blue-700">
              {selectedRoute.optionLabel || 'Alternative transport option'}
            </span>
          </div>

          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                {parseOperatorCodes(selectedRoute.operator).map((operatorCode) => (
                  <span
                    key={operatorCode}
                    className={`px-3 py-1 rounded-xl font-black text-sm ${getOperatorBadgeClass(operatorCode)}`}
                  >
                    {getOperatorDisplayName(operatorCode)}
                  </span>
                ))}
                <span className="font-black text-xl text-slate-800">
                  {selectedRoute.route || selectedRoute.line}
                </span>
              </div>
              <div className="text-xs text-slate-500 font-semibold">
                {selectedRoute.transfers === 0 ? 'Google Transit gap option' : 'Google Transit option with transfer'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-blue-700 font-bold text-xl">~{selectedRoute.estimated_time_min}min</div>
              <div className="text-sm font-black text-slate-700">{formatHybridFare(selectedRoute)}</div>
            </div>
          </div>

          {(() => {
            const plannedClock = plannedJourneyClock(selectedRoute);
            if (!plannedClock) return null;
            return (
              <div className="mb-4 grid grid-cols-2 gap-2 rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs font-black text-blue-800">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-blue-500">Depart by</div>
                  <div className="text-base">{plannedClock.depart || '-'}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-blue-500">Arrive by</div>
                  <div className="text-base">{plannedClock.arrive || '-'}</div>
                </div>
              </div>
            );
          })()}

          <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs font-bold text-blue-800">
            {selectedRoute.repairReason
              ? selectedRoute.alternativeRole === 'google_transit_whole_trip'
                ? selectedRoute.repairReason
                : `${selectedRoute.repairReason}. The time shown is a hybrid estimate using the original KMB route plus this replacement gap.`
              : 'Shown because Google Transit found a possible way to cover the missing KMB segment.'}
          </div>

          <div className="space-y-3">
            {(selectedRoute.legs || []).map((leg, index) => {
              const color = getOperatorColor(leg.operator, ROUTE_COLORS[index % ROUTE_COLORS.length]);
              const isExpanded = expandedSegments.has(`fallback-${index}`);
              const boardClock = formatClockTime(leg.boardTime);
              const arrivalClock = formatClockTime(leg.arrivalTime);
              const intermediateStops = leg.intermediate_stops || [];
              const canExpand = intermediateStops.length > 0;
              return (
              <div key={`${leg.route_variant_id}-${index}`} className="pl-3 border-l-4 py-2" style={{ borderColor: color }}>
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded-lg text-white text-xs font-black" style={{ backgroundColor: color }}>
                    {getOperatorDisplayName(leg.operator)}
                  </span>
                  <span className="text-sm font-black text-slate-800">{leg.route || leg.line}</span>
                  <span className="text-xs font-bold text-slate-500">{formatFare(leg.fare)}</span>
                </div>
                <div className="text-sm font-bold text-slate-700">
                  {getLegStopName(leg.origin_stop)}
                  <span className="mx-2 text-slate-300">{'\u2192'}</span>
                  {getLegStopName(leg.destination_stop)}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {leg.stop_count != null ? `${leg.stop_count} stops` : 'Google segment'} {'\u00B7'} ride estimate {leg.estimated_ride_time_min} min
                  {String(leg.ride_time_source || '').startsWith('google_transit_')
                    ? ' (Google transit)'
                    : ''}
                </div>
                {(boardClock || arrivalClock || leg.headsign) && (
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-slate-600">
                    {boardClock && (
                      <span className="px-2 py-1 rounded-full border border-slate-200 bg-slate-50">
                        Board {boardClock}
                      </span>
                    )}
                    {arrivalClock && (
                      <span className="px-2 py-1 rounded-full border border-red-100 bg-red-50 text-[#E1251B]">
                        Arrive {arrivalClock}
                      </span>
                    )}
                    {leg.headsign && (
                      <span className="px-2 py-1 rounded-full border border-slate-200 bg-slate-50">
                        To {leg.headsign}
                      </span>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  disabled={!canExpand}
                  onClick={() => {
                    if (!canExpand) return;
                    const key = `fallback-${index}`;
                    const next = new Set(expandedSegments);
                    next.has(key) ? next.delete(key) : next.add(key);
                    setExpandedSegments(next);
                  }}
                  className={`mt-2 text-xs font-bold ${canExpand ? 'text-slate-500 hover:text-slate-700' : 'text-slate-300 cursor-default'}`}
                >
                  {canExpand
                    ? `${isExpanded ? '\u25B2' : '\u25BC'} ${intermediateStops.length} intermediate stops`
                    : 'No intermediate stop list from this data source'}
                </button>
                {isExpanded && (
                  <div className="mt-2 py-2 border-l-2 border-dashed border-slate-200 pl-3 ml-1 space-y-2">
                    {intermediateStops.map((stop, stopIdx) => (
                      <div key={`${stop.stop_id}-${stopIdx}`} className="flex items-center justify-between text-sm text-slate-600">
                        <span>
                          <span className="text-slate-300 mr-2">{'\u2022'}</span>
                          {getLegStopName(stop)}
                        </span>
                        {leg.operator === 'KMB' && (
                          <button
                            onClick={() =>
                              handleAddToBookmark(
                                stop.stop_id,
                                getLegStopName(stop),
                                (stopRoutesRef.current[stop.stop_id] || []).map((r) => ({
                                  route: r.route,
                                  service_type: r.service_type,
                                })),
                              )
                            }
                            className="text-xs text-slate-300 hover:text-yellow-500"
                          >
                            {'\u2B50'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {index < (selectedRoute.transfer_stops || []).length && (
                  <div className="mt-2 text-xs font-bold text-slate-500">
                    Transfer walk: {selectedRoute.transfer_stops[index].walk_distance_m}m
                  </div>
                )}
              </div>
              );
            })}
          </div>

          <div className="mt-4 text-xs text-slate-500 font-semibold">
            Access walking: {selectedRoute.walk_distance_m}m {'\u00B7'} Confidence {Math.round((selectedRoute.confidence || 0) * 100)}%
          </div>
        </div>
      )}

      {/* Selected route detail */}
      {selectedRoute && !isFallbackRoute(selectedRoute) && !showBookmarks && (
        <div
          className="absolute bottom-0 left-0 right-0 z-20 overflow-y-auto rounded-t-[2rem] bg-white p-4 shadow-2xl scrollbar-hide slide-up"
          style={{ height: `${routeDetailHeight}vh` }}
        >
          <RouteDetailResizeHandle
            height={routeDetailHeight}
            onPointerDown={startRouteDetailResize}
            onChange={changeRouteDetailHeight}
          />
          <div className="flex items-center justify-between gap-3 mb-3">
            <button
              onClick={() => {
                selectedEtaRequestRef.current += 1;
                setSelectedCurrentEtas(new Map());
                setIsLoadingSelectedEtas(false);
                setSelectedEtaUpdatedAt(null);
                setSelectedRoute(null);
                clearMapGraphics();
                clearRouteOverlay();
                clearStationLabel();
              }}
              className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"
            >
              {'\u2190'} Back
            </button>
            <button
              type="button"
              onClick={() => loadSelectedCurrentEtas(detailSegments)}
              disabled={isLoadingSelectedEtas}
              className="text-[11px] font-bold text-[#E1251B] border border-[#E1251B]/30 rounded-lg px-2 py-1 hover:bg-[#E1251B]/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoadingSelectedEtas ? 'Refreshing...' : 'Refresh current ETA'}
            </button>
          </div>
          {selectedEtaUpdatedAt && (
            <div className="text-[11px] text-slate-500 font-semibold mb-2">
              Current ETA updated: {formatRefreshTime(selectedEtaUpdatedAt)}
            </div>
          )}
          {refreshFeedback && (
            <div
              aria-live="polite"
              className={`mb-3 p-2 border rounded-xl text-xs font-bold ${refreshStatusClass}`}
            >
              {refreshFeedback.message}
            </div>
          )}

          <div className="flex items-center gap-3 mb-3">
            {detailSegments.map((seg, si) => (
              <React.Fragment key={si}>
                {si > 0 && <span className="text-slate-300">{'\u2192'}</span>}
                <span
                  className="px-3 py-1 rounded-xl text-white font-black text-lg"
                  style={{ backgroundColor: ROUTE_COLORS[si % ROUTE_COLORS.length] }}
                >
                  {seg.routeLabel || seg.route}
                </span>
              </React.Fragment>
            ))}
            <span className="ml-auto text-[#E1251B] font-bold text-xl">
              ~{selectedRoute.estimatedTime}min
            </span>
          </div>
          {(() => {
            const plannedClock = plannedJourneyClock(selectedRoute);
            if (!plannedClock) return null;
            return (
              <div className="mb-3 grid grid-cols-2 gap-2 rounded-2xl border border-emerald-100 bg-emerald-50 p-3 text-xs font-black text-emerald-800">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-emerald-600">Depart by</div>
                  <div className="text-base">{plannedClock.depart || '-'}</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wide text-emerald-600">Arrive by</div>
                  <div className="text-base">{plannedClock.arrive || '-'}</div>
                </div>
              </div>
            );
          })()}
          {(() => {
            const validity = plannedTimeValidity(selectedRoute, timeMode);
            if (!validity) return null;
            return (
              <div className="mb-3">
                <span
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-bold ${validity.className}`}
                >
                  {validity.label}
                </span>
              </div>
            );
          })()}

          {selectedRoute.walkTimeOrigin > 0 && (
            <div className="flex items-center gap-2 text-sm text-slate-500 mb-2 pl-2 border-l-2 border-dashed border-slate-300">
              {'\u{1F6B6}'} Walk {selectedRoute.walkTimeOrigin} min to stop
            </div>
          )}

          {(selectedRoute.segments || []).map((seg, si) => {
            const displaySeg = detailSegments[si] || seg;
            const fromStop = stopMapRef.current[seg.fromStop];
            const toStop = stopMapRef.current[seg.toStop];
            const rideInfo = getSegmentRideDisplay(displaySeg);
            const nextSegment = detailSegments[si + 1] || (selectedRoute.segments || [])[si + 1];
            const transferWalkMinutes = si === 0
              ? selectedRoute.walkTimeTransfer
              : selectedRoute.walkTimeTransfer2;
            const transferArrivalClock = formatClockTime(displaySeg.arrivalTime || seg.arrivalTime);
            const nextBoardClock = formatClockTime(
              nextSegment?.boardTime || nextSegment?.nextEta,
            );
            const color = ROUTE_COLORS[si % ROUTE_COLORS.length];
            const scheduleText = timeMode === 'now' ? null : formatHistoricalSchedule(displaySeg.historicalSchedule || seg.historicalSchedule);
            const scheduleClass = historicalScheduleClass(displaySeg.historicalSchedule || seg.historicalSchedule);
            const routesAtFromStop = (stopRoutesRef.current[seg.fromStop] || []).map((r) => ({
              route: r.route,
              service_type: r.service_type,
            }));
            const currentEtaOptions = (
              displaySeg.routeOptions && displaySeg.routeOptions.length > 0
                ? displaySeg.routeOptions
                : [displaySeg]
            ).map((option) => ({
              ...option,
              fromStop: option?.fromStop || seg.fromStop,
            }));
            return (
              <div key={si} className="mb-2">
                <div className="pl-2 border-l-4 py-2" style={{ borderColor: color }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-2 py-0.5 rounded-lg text-white text-xs font-bold" style={{ backgroundColor: color }}>
                      {displaySeg.routeLabel || seg.route}
                    </span>
                    <span className="text-xs text-slate-500">
                      {seg.routeInfo?.orig_tc} {'\u2192'} {seg.routeInfo?.dest_tc}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold">{'\u{1F4CD}'} {fromStop?.name_tc || fromStop?.name_en}</div>
                    <button
                      onClick={() =>
                        handleAddToBookmark(seg.fromStop, fromStop?.name_tc || fromStop?.name_en, routesAtFromStop)
                      }
                      className="text-xs text-slate-400 hover:text-yellow-500"
                      title="Bookmark this stop"
                    >
                      {'\u2B50'}
                    </button>
                  </div>
                  {scheduleText && (
                    <div className={`mt-1 inline-flex max-w-full rounded-full border px-2 py-1 text-[11px] font-bold ${scheduleClass}`}>
                      {scheduleText}
                    </div>
                  )}
                  <div className="text-xs font-semibold text-slate-500 mt-1">
                    Ride time: ~{rideInfo.minutes} min
                    {rideInfo.source === 'google_transit_bus_duration' ? ' (Google transit)' : ''}
                  </div>
                  <div
                    className="text-xs text-slate-400 my-1 cursor-pointer hover:text-slate-600 flex flex-col gap-1"
                    onClick={() => {
                      const newExp = new Set(expandedSegments);
                      newExp.has(si) ? newExp.delete(si) : newExp.add(si);
                      setExpandedSegments(newExp);
                    }}
                  >
                    <div className="flex items-center gap-1 font-bold">
                      {expandedSegments.has(si) ? '\u25B2' : '\u25BC'} {seg.stops.length - 2} intermediate
                      stops
                    </div>
                    <CurrentStopEtaList
                      options={currentEtaOptions}
                      fallbackStopId={seg.fromStop}
                      etaMap={selectedCurrentEtas}
                      isLoading={isLoadingSelectedEtas}
                      getEtaText={getEtaText}
                      getEtaChipClass={getEtaChipClass}
                    />
                    {expandedSegments.has(si) && (
                      <div className="mt-2 py-2 border-l-2 border-dashed border-slate-200 pl-3 ml-1 space-y-2">
                        {seg.stops.slice(1, -1).map((stopId, stopIdx) => {
                          const stp = stopMapRef.current[stopId];
                          const rts = (stopRoutesRef.current[stopId] || []).map((r) => ({
                            route: r.route,
                            service_type: r.service_type,
                          }));
                          return (
                            <div
                              key={stopIdx}
                              className="flex items-center justify-between text-sm text-slate-600"
                            >
                              <span>
                                <span className="text-slate-300 mr-2">{'\u2022'}</span>
                                {stp?.name_tc || stp?.name_en}
                              </span>
                              <button
                                onClick={() =>
                                  handleAddToBookmark(
                                    stopId,
                                    stp?.name_tc || stp?.name_en,
                                    rts,
                                  )
                                }
                                className="text-xs text-slate-300 hover:text-yellow-500"
                              >
                                {'\u2B50'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-bold flex items-center gap-2 flex-wrap">
                    <span>{'\u{1F3C1}'} {toStop?.name_tc || toStop?.name_en}</span>
                    {si < detailSegments.length - 1 && transferArrivalClock && (
                      <span className="text-[11px] font-bold px-2 py-1 rounded-full border border-red-100 bg-red-50 text-[#E1251B]">
                        Arrive {transferArrivalClock}
                      </span>
                    )}
                  </div>
                </div>
                {si < detailSegments.length - 1 && (
                  <div className="flex items-center gap-2 text-sm text-slate-500 my-2 pl-2 border-l-2 border-dashed border-slate-300">
                    {'\u{1F6B6}'} Transfer ({transferWalkMinutes || '?'} min walk)
                    {nextBoardClock && (
                      <span className="text-[11px] font-semibold text-slate-600">
                        {'\u00B7'} Next board {nextBoardClock}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {selectedRoute.walkTimeDest > 0 && (
            <div className="flex items-center gap-2 text-sm text-slate-500 mt-2 pl-2 border-l-2 border-dashed border-slate-300">
              {'\u{1F6B6}'} Walk {selectedRoute.walkTimeDest} min to destination
            </div>
          )}
        </div>
      )}

      {/* Add to Bookmark modal */}
      {addToBookmark && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-3xl p-6 mx-4 w-full max-w-xs shadow-2xl">
            <h3 className="font-black text-lg mb-1">{'\u2B50'} Add to Bookmark</h3>
            <p className="text-sm text-slate-500 mb-4">{addToBookmark.stopName}</p>
            {bookmarks.length === 0 && (
              <p className="text-sm text-slate-400 mb-3">
                No groups yet. Create one in the Bookmarks panel first.
              </p>
            )}
            <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-hide">
              {bookmarks.map((g, gi) => (
                <button
                  key={gi}
                  onClick={() => confirmAddBookmark(gi)}
                  className="w-full text-left px-4 py-3 bg-slate-50 rounded-xl hover:bg-slate-100 font-bold text-sm"
                >
                  {g.groupName}
                </button>
              ))}
            </div>
            <button
              onClick={() => setAddToBookmark(null)}
              className="mt-4 w-full py-2 text-sm text-slate-400 font-bold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
