import { loadExternalOperatorDatasets } from './operatorAdapters.js';

const DEFAULT_WALK_RADIUS_KM = 0.75;
const DEFAULT_TRANSFER_RADIUS_KM = 0.25;
const MAX_NEARBY_STOPS = 18;
const MAX_ROUTE_ENTRIES = 80;
const MAX_DIRECT_PER_OPERATOR = 8;
const MAX_TRANSFER_PER_OPERATOR = 4;
const MAX_TRANSFER_ROUTE_ENTRIES = 24;
const MAX_TRANSFER_STOPS_PER_LEG = 32;
const TRANSFER_GRID_DEG = 0.003;
const WALK_KMH = 4.5;
const BOARDING_BUFFER_MIN = 2;
const INDEX_CACHE = new WeakMap();

const MODE_CONFIG = {
  citybus: {
    operator: 'CTB',
    mode: 'citybus',
    label: 'Citybus',
    minutesPerStop: 1.5,
    confidenceBase: 0.7,
  },
  tram: {
    operator: 'TRAM',
    mode: 'tram',
    label: 'Tram',
    minutesPerStop: 1.25,
    confidenceBase: 0.68,
  },
  mtr: {
    operator: 'MTR',
    mode: 'mtr',
    label: 'MTR',
    minutesPerStop: 2.4,
    confidenceBase: 0.78,
  },
};

function toNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasWgs84(record) {
  const lat = toNumber(record?.lat);
  const lng = toNumber(record?.lng);
  return lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const radiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function walkMinutes(distanceKm) {
  return Math.max(1, Math.ceil((distanceKm / WALK_KMH) * 60));
}

function normalizeName(name) {
  return {
    tc: name?.tc || null,
    en: name?.en || null,
    sc: name?.sc || null,
  };
}

function normalizeStop(stop, distanceKm = 0) {
  return {
    id: stop.id,
    stop_id: stop.stop_id,
    station_code: stop.station_code || null,
    name: normalizeName(stop.name),
    lat: toNumber(stop.lat),
    lng: toNumber(stop.lng),
    distance_km: Number(distanceKm.toFixed(4)),
    coordinate_source: stop.coordinate_source || null,
  };
}

function routeKeyFor(routeStop) {
  return routeStop.route_variant_id || `${routeStop.operator}:${routeStop.route_id}:${routeStop.direction || ''}`;
}

function gridKey(lat, lng) {
  return `${Math.floor(lat / TRANSFER_GRID_DEG)},${Math.floor(lng / TRANSFER_GRID_DEG)}`;
}

function buildStopGrid(stopsById) {
  const grid = new Map();
  for (const stop of stopsById.values()) {
    const key = gridKey(stop.lat, stop.lng);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(stop);
  }
  return grid;
}

function nearbyStopsFromGrid(index, stop, radiusKm) {
  const cells = Math.ceil(radiusKm / (TRANSFER_GRID_DEG * 111)) + 1;
  const gx = Math.floor(stop.lat / TRANSFER_GRID_DEG);
  const gy = Math.floor(stop.lng / TRANSFER_GRID_DEG);
  const out = [];
  for (let dx = -cells; dx <= cells; dx++) {
    for (let dy = -cells; dy <= cells; dy++) {
      for (const candidate of index.stopGrid.get(`${gx + dx},${gy + dy}`) || []) {
        const distanceKm = haversineKm(stop.lat, stop.lng, candidate.lat, candidate.lng);
        if (distanceKm <= radiusKm) out.push({ stop: candidate, distanceKm });
      }
    }
  }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}

function buildOperatorIndex(dataset, config) {
  const stopsById = new Map();
  for (const stop of dataset?.stops || []) {
    if (hasWgs84(stop)) {
      stopsById.set(stop.stop_id, stop);
    }
  }

  const routesById = new Map();
  for (const route of dataset?.routes || []) {
    routesById.set(route.id, route);
    routesById.set(route.route_id, route);
  }

  const routeVariants = new Map();
  const stopRouteEntries = new Map();
  for (const routeStop of dataset?.route_stops || []) {
    if (!routeStop?.stop_id || !stopsById.has(routeStop.stop_id)) continue;
    const variantKey = routeKeyFor(routeStop);
    if (!routeVariants.has(variantKey)) {
      routeVariants.set(variantKey, {
        routeKey: variantKey,
        route_id: routeStop.route_id,
        direction: routeStop.direction || null,
        route: routesById.get(variantKey) || routesById.get(routeStop.route_id) || null,
        stops: [],
      });
    }
    routeVariants.get(variantKey).stops.push({
      stop_id: routeStop.stop_id,
      sequence: toNumber(routeStop.sequence) ?? 0,
      routeStop,
    });
  }

  for (const variant of routeVariants.values()) {
    variant.stops.sort((a, b) => a.sequence - b.sequence);
    variant.stops.forEach((item, index) => {
      item.index = index;
      const entry = {
        ...item,
        routeKey: variant.routeKey,
        route_id: variant.route_id,
        direction: variant.direction,
        route: variant.route,
        variant,
      };
      if (!stopRouteEntries.has(item.stop_id)) stopRouteEntries.set(item.stop_id, []);
      stopRouteEntries.get(item.stop_id).push(entry);
    });
  }

  return {
    config,
    dataset,
    stopsById,
    stopGrid: buildStopGrid(stopsById),
    routeVariants,
    stopRouteEntries,
    fareIndex: buildFareIndex(dataset, config),
  };
}

function getOperatorIndex(dataset, config) {
  if (!dataset || typeof dataset !== 'object') return buildOperatorIndex(dataset, config);
  const cachedByMode = INDEX_CACHE.get(dataset);
  const cached = cachedByMode?.get(config.mode);
  if (cached) return cached;
  const index = buildOperatorIndex(dataset, config);
  const nextByMode = cachedByMode || new Map();
  nextByMode.set(config.mode, index);
  INDEX_CACHE.set(dataset, nextByMode);
  return index;
}

function buildFareIndex(dataset, config) {
  if (config.mode === 'mtr') {
    return new Map((dataset?.fares || []).map((fare) => [`${fare.src_stop_id}->${fare.dest_stop_id}`, fare]));
  }

  const faresByRoute = new Map();
  for (const fare of dataset?.fares || []) {
    const key = `${fare.route_id}|${fare.route_variant_id || ''}|${fare.direction || ''}`;
    if (!faresByRoute.has(key)) faresByRoute.set(key, []);
    faresByRoute.get(key).push(fare);
  }
  return faresByRoute;
}

function findNearbyStops(index, loc, radiusKm) {
  return nearbyStopsFromGrid(index, loc, radiusKm).slice(0, MAX_NEARBY_STOPS);
}

function entriesForNearbyStops(index, nearbyStops) {
  const out = [];
  for (const nearby of nearbyStops) {
    for (const entry of index.stopRouteEntries.get(nearby.stop.stop_id) || []) {
      out.push({ ...entry, nearbyStop: nearby });
    }
  }
  return out
    .sort((a, b) => a.nearbyStop.distanceKm - b.nearbyStop.distanceKm)
    .slice(0, MAX_ROUTE_ENTRIES);
}

function getRouteLabel(route, fallbackRouteId) {
  return route?.display_route || route?.route || route?.line || route?.route_name?.en || fallbackRouteId;
}

function getFare(index, fromStopId, toStopId, routeId, routeKey, direction, fromSequence, toSequence, route) {
  if (index.config.mode === 'mtr') {
    const fare = index.fareIndex.get(`${fromStopId}->${toStopId}`);
    return fare?.fare_rule?.octopus_adult != null
      ? {
          status: 'available',
          amount: fare.fare_rule.octopus_adult,
          currency: fare.currency || 'HKD',
          source: fare.source || 'MTR fares CSV',
          note: 'Adult Octopus fare',
        }
      : { status: 'unavailable', amount: null, currency: 'HKD', source: 'MTR fares CSV' };
  }

  const fareRows = [
    ...(index.fareIndex.get(`${routeId}|${routeKey}|${direction || ''}`) || []),
    ...(index.fareIndex.get(`${routeId}|${routeKey}|`) || []),
    ...(index.fareIndex.get(`${routeId}||${direction || ''}`) || []),
    ...(index.fareIndex.get(`${routeId}||`) || []),
  ];
  const matchingSection = fareRows.find((fare) => {
    const on = toNumber(fare.on_sequence);
    const off = toNumber(fare.off_sequence);
    return on != null && off != null && on <= fromSequence && off >= toSequence;
  });
  const amount = matchingSection?.amount ?? route?.full_fare ?? route?.fare ?? null;
  return amount != null
    ? {
        status: 'available',
        amount,
        currency: matchingSection?.currency || route?.fare_currency || 'HKD',
        source: matchingSection?.source || route?.source || 'TD fare data',
      }
    : { status: 'unavailable', amount: null, currency: 'HKD', source: 'operator dataset' };
}

function combineFares(fares) {
  const unavailable = fares.find((fare) => fare.status !== 'available');
  if (unavailable) {
    return {
      status: 'unavailable',
      amount: null,
      currency: 'HKD',
      source: fares.map((fare) => fare.source).filter(Boolean).join('; ') || 'operator dataset',
      note: 'One or more leg fares are unavailable.',
    };
  }
  return {
    status: 'available',
    amount: Number(fares.reduce((sum, fare) => sum + Number(fare.amount || 0), 0).toFixed(1)),
    currency: fares[0]?.currency || 'HKD',
    source: fares.map((fare) => fare.source).filter(Boolean).join('; '),
  };
}

function buildLeg(index, fromEntry, toEntry) {
  const route = fromEntry.route || toEntry.route;
  const routeLabel = getRouteLabel(route, fromEntry.route_id);
  const stopCount = Math.max(1, toEntry.index - fromEntry.index + 1);
  const fare = getFare(
    index,
    fromEntry.stop_id,
    toEntry.stop_id,
    fromEntry.route_id,
    fromEntry.routeKey,
    fromEntry.direction,
    fromEntry.sequence,
    toEntry.sequence,
    route,
  );

  return {
    operator: index.config.operator,
    mode: index.config.mode,
    route: routeLabel,
    line: index.config.mode === 'mtr' ? routeLabel : null,
    route_id: fromEntry.route_id,
    route_variant_id: fromEntry.routeKey,
    direction: fromEntry.direction,
    origin_stop: normalizeStop(index.stopsById.get(fromEntry.stop_id)),
    destination_stop: normalizeStop(index.stopsById.get(toEntry.stop_id)),
    stop_count: stopCount,
    estimated_ride_time_min: Math.ceil(Math.max(0, stopCount - 1) * index.config.minutesPerStop),
    fare,
    data_source: route?.source || 'operator dataset',
  };
}

function candidateConfidence(index, walkKm, transfers) {
  const walkPenalty = Math.min(0.25, walkKm * 0.08);
  const transferPenalty = transfers * 0.08;
  return Number(Math.max(0.35, index.config.confidenceBase - walkPenalty - transferPenalty).toFixed(2));
}

function buildCandidate(index, originLoc, destLoc, legs, originNearby, destNearby, transfers, transferWalkKm = 0) {
  const walkDistanceKm = originNearby.distanceKm + destNearby.distanceKm + transferWalkKm;
  const walkTime = walkMinutes(originNearby.distanceKm) + walkMinutes(destNearby.distanceKm) + walkMinutes(transferWalkKm);
  const rideTime = legs.reduce((sum, leg) => sum + leg.estimated_ride_time_min, 0);
  const fare = combineFares(legs.map((leg) => leg.fare));
  const routeText = legs.map((leg) => leg.route).join(' -> ');
  const lastLeg = legs[legs.length - 1];

  return {
    id: `fallback-${index.config.mode}-${transfers}-${legs.map((leg) => leg.route_variant_id).join('__')}-${legs[0].origin_stop.stop_id}-${lastLeg.destination_stop.stop_id}`,
    type: 'fallback_candidate',
    operator: transfers === 0 ? index.config.operator : legs.map((leg) => leg.operator).join('+'),
    mode: index.config.mode,
    route: routeText,
    line: index.config.mode === 'mtr' ? routeText : null,
    journey_type: transfers === 0 ? 'direct' : 'one_transfer',
    transfers,
    origin: originLoc,
    destination: destLoc,
    origin_stop: normalizeStop(originNearby.stop, originNearby.distanceKm),
    destination_stop: normalizeStop(destNearby.stop, destNearby.distanceKm),
    transfer_stops: legs.length > 1
      ? [
          {
            alight: legs[0].destination_stop,
            board: legs[1].origin_stop,
            walk_distance_m: Math.round(transferWalkKm * 1000),
          },
        ]
      : [],
    legs,
    walk_distance_m: Math.round(walkDistanceKm * 1000),
    estimated_time_min: walkTime + rideTime + BOARDING_BUFFER_MIN * legs.length,
    fare,
    confidence: candidateConfidence(index, walkDistanceKm, transfers),
    data_source: Array.from(new Set(legs.map((leg) => leg.data_source).filter(Boolean))),
    notes: ['Generated from cached enriched operator datasets using straight-line walking estimates.'],
  };
}

function generateDirectCandidates(index, originLoc, destLoc, originEntries, destEntries) {
  const bestByRoute = new Map();
  for (const originEntry of originEntries) {
    for (const destEntry of destEntries) {
      if (originEntry.routeKey !== destEntry.routeKey) continue;
      if (originEntry.index >= destEntry.index) continue;

      const leg = buildLeg(index, originEntry, destEntry);
      const candidate = buildCandidate(
        index,
        originLoc,
        destLoc,
        [leg],
        originEntry.nearbyStop,
        destEntry.nearbyStop,
        0,
      );
      const score = candidate.estimated_time_min + candidate.walk_distance_m / 120;
      const current = bestByRoute.get(originEntry.routeKey);
      if (!current || score < current.score) bestByRoute.set(originEntry.routeKey, { score, candidate });
    }
  }
  return Array.from(bestByRoute.values())
    .map((row) => row.candidate)
    .sort((a, b) => a.estimated_time_min - b.estimated_time_min)
    .slice(0, MAX_DIRECT_PER_OPERATOR);
}

function generateTransferCandidates(index, originLoc, destLoc, originEntries, destEntries, transferRadiusKm) {
  const bestByPair = new Map();
  const destBoardEntryByStop = new Map();
  for (const destEntry of destEntries.slice(0, MAX_TRANSFER_ROUTE_ENTRIES)) {
    for (const secondStopEntry of destEntry.variant.stops.slice(0, destEntry.index).slice(-MAX_TRANSFER_STOPS_PER_LEG)) {
      const existing = destBoardEntryByStop.get(secondStopEntry.stop_id);
      if (!existing || destEntry.nearbyStop.distanceKm < existing.destEntry.nearbyStop.distanceKm) {
        destBoardEntryByStop.set(secondStopEntry.stop_id, { secondStopEntry, destEntry });
      }
    }
  }

  for (const originEntry of originEntries.slice(0, MAX_TRANSFER_ROUTE_ENTRIES)) {
    const firstLegStops = originEntry.variant.stops
      .slice(originEntry.index + 1)
      .slice(0, MAX_TRANSFER_STOPS_PER_LEG);
    for (const firstStopEntry of firstLegStops) {
        const firstStop = index.stopsById.get(firstStopEntry.stop_id);
        if (!firstStop) continue;
      for (const nearby of nearbyStopsFromGrid(index, firstStop, transferRadiusKm)) {
        const match = destBoardEntryByStop.get(nearby.stop.stop_id);
        if (!match) continue;
        const { secondStopEntry, destEntry } = match;
        if (originEntry.routeKey === destEntry.routeKey) continue;

          const leg1 = buildLeg(index, originEntry, {
            ...firstStopEntry,
            routeKey: originEntry.routeKey,
            route_id: originEntry.route_id,
            route: originEntry.route,
            direction: originEntry.direction,
          });
          const leg2 = buildLeg(
            index,
            {
              ...secondStopEntry,
              routeKey: destEntry.routeKey,
              route_id: destEntry.route_id,
              route: destEntry.route,
              direction: destEntry.direction,
            },
            destEntry,
          );
          const candidate = buildCandidate(
            index,
            originLoc,
            destLoc,
            [leg1, leg2],
            originEntry.nearbyStop,
            destEntry.nearbyStop,
            1,
            nearby.distanceKm,
          );
          const pairKey = `${originEntry.routeKey}->${destEntry.routeKey}`;
          const score = candidate.estimated_time_min + candidate.walk_distance_m / 100;
          const current = bestByPair.get(pairKey);
          if (!current || score < current.score) bestByPair.set(pairKey, { score, candidate });
      }
    }
  }

  return Array.from(bestByPair.values())
    .map((row) => row.candidate)
    .sort((a, b) => a.estimated_time_min - b.estimated_time_min)
    .slice(0, MAX_TRANSFER_PER_OPERATOR);
}

function generateForOperator({ dataset, config, originLoc, destLoc, options }) {
  const index = getOperatorIndex(dataset, config);
  const walkRadiusKm = options.walkRadiusKm ?? DEFAULT_WALK_RADIUS_KM;
  const transferRadiusKm = options.transferRadiusKm ?? DEFAULT_TRANSFER_RADIUS_KM;

  const originNearby = findNearbyStops(index, originLoc, walkRadiusKm);
  const destNearby = findNearbyStops(index, destLoc, walkRadiusKm);
  const originEntries = entriesForNearbyStops(index, originNearby);
  const destEntries = entriesForNearbyStops(index, destNearby);
  const direct = generateDirectCandidates(index, originLoc, destLoc, originEntries, destEntries);
  const transfers = options.includeTransfers === false
    ? []
    : generateTransferCandidates(index, originLoc, destLoc, originEntries, destEntries, transferRadiusKm);

  return {
    candidates: [...direct, ...transfers],
    debug: {
      operator: config.operator,
      nearby_origin_count: originNearby.length,
      nearby_destination_count: destNearby.length,
      direct_count: direct.length,
      transfer_count: transfers.length,
    },
  };
}

export function generateFallbackCandidatesFromDatasets({
  originLoc,
  destLoc,
  datasets,
  maxCandidates = 24,
  includeTransfers = true,
  walkRadiusKm = DEFAULT_WALK_RADIUS_KM,
  transferRadiusKm = DEFAULT_TRANSFER_RADIUS_KM,
} = {}) {
  if (!hasWgs84(originLoc) || !hasWgs84(destLoc)) {
    throw new Error('Fallback candidate generation requires WGS84 origin and destination coordinates.');
  }

  const options = { includeTransfers, walkRadiusKm, transferRadiusKm };
  const rows = [
    generateForOperator({ dataset: datasets?.citybus, config: MODE_CONFIG.citybus, originLoc, destLoc, options }),
    generateForOperator({ dataset: datasets?.tram, config: MODE_CONFIG.tram, originLoc, destLoc, options }),
    generateForOperator({ dataset: datasets?.mtr, config: MODE_CONFIG.mtr, originLoc, destLoc, options }),
  ];

  const candidates = rows
    .flatMap((row) => row.candidates)
    .sort((a, b) => {
      if (a.transfers !== b.transfers) return a.transfers - b.transfers;
      if (a.estimated_time_min !== b.estimated_time_min) return a.estimated_time_min - b.estimated_time_min;
      return b.confidence - a.confidence;
    })
    .slice(0, maxCandidates);

  return {
    candidates,
    debug: rows.map((row) => row.debug),
    generated_at: new Date().toISOString(),
    source: 'cached enriched operator datasets',
  };
}

export async function generateFallbackCandidates(params) {
  const datasets = params?.datasets || await loadExternalOperatorDatasets();
  return generateFallbackCandidatesFromDatasets({
    ...params,
    datasets,
  });
}

export const fallbackRouteGenerator = {
  generateFallbackCandidates,
  generateFallbackCandidatesFromDatasets,
  haversineKm,
};
