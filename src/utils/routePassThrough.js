const DEFAULT_OPERATOR = 'KMB';

export const PASS_THROUGH_STATIONS = Object.freeze([
  Object.freeze({
    id: 'shek-po-tsuen',
    operator: DEFAULT_OPERATOR,
    // KMB's public stop code is stable in the stop display name. It is resolved
    // to the current 16-character KMB stop ID when the network data is loaded.
    stopCodes: Object.freeze(['YL130']),
    nameAliases: Object.freeze(['SHEK PO TSUEN', '石埗村']),
    label: 'Passes Shek Po Tsuen · 途經石埗村',
  }),
]);

function normalizedValue(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizedStopName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/\s*\([A-Z]{1,4}\d{2,4}\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .toLocaleUpperCase('en-HK');
}

function stopCodeFromName(value) {
  const match = String(value || '').trim().match(/\(([A-Z]{1,4}\d{2,4})\)\s*$/i);
  return match ? match[1].toUpperCase() : '';
}

function exactRouteKey(candidate) {
  const route = normalizedValue(candidate?.route);
  const bound = normalizedValue(candidate?.bound);
  const serviceType = normalizedValue(candidate?.service_type || '1');
  if (!route || !bound || !serviceType) return null;
  return `${route}|${bound}|${serviceType}`;
}

function matchingStopIndex(stopIds, stopId, sequenceNumber, startIndex = 0) {
  const expectedIndex = Number(sequenceNumber) - 1;
  if (
    Number.isInteger(expectedIndex)
    && expectedIndex >= startIndex
    && stopIds[expectedIndex] === stopId
  ) {
    return expectedIndex;
  }
  return stopIds.indexOf(stopId, Math.max(0, startIndex));
}

function travelledStopIds(candidate, fullStopIds) {
  if (Array.isArray(candidate?.stops) && candidate.stops.length >= 2) {
    return candidate.stops.map((stopId) => String(stopId || '').trim()).filter(Boolean);
  }

  const fromStop = String(candidate?.fromStop || '').trim();
  const toStop = String(candidate?.toStop || '').trim();
  let fromIndex = 0;
  let toIndex = fullStopIds.length - 1;

  if (fromStop) {
    fromIndex = matchingStopIndex(fullStopIds, fromStop, candidate?.fromSequence);
    if (fromIndex < 0) return [];
  }
  if (toStop) {
    toIndex = matchingStopIndex(fullStopIds, toStop, candidate?.toSequence, fromIndex);
    if (toIndex < 0) return [];
  }
  if (fromIndex >= toIndex) return [];
  return fullStopIds.slice(fromIndex, toIndex + 1);
}

function resolveStationStopIds(stopMap, station) {
  const entries = Object.entries(stopMap || {});
  const stopCodes = new Set((station.stopCodes || []).map(normalizedValue).filter(Boolean));
  const codeMatches = entries
    .filter(([, stop]) => (
      stopCodes.has(stopCodeFromName(stop?.name_en))
      || stopCodes.has(stopCodeFromName(stop?.name_tc))
    ))
    .map(([stopId]) => stopId);

  // The public stop code is preferred. Name aliases are only a compatibility
  // fallback for older/cached stop payloads that omitted the code suffix.
  if (codeMatches.length > 0) return new Set(codeMatches);

  const aliases = new Set((station.nameAliases || []).map(normalizedStopName).filter(Boolean));
  return new Set(entries
    .filter(([, stop]) => (
      aliases.has(normalizedStopName(stop?.name_en))
      || aliases.has(normalizedStopName(stop?.name_tc))
    ))
    .map(([stopId]) => stopId));
}

export function createRoutePassThroughDetector({
  routeStops = {},
  stopMap = {},
  stations = PASS_THROUGH_STATIONS,
} = {}) {
  const resolvedStations = (stations || []).map((station) => ({
    ...station,
    operator: normalizedValue(station.operator || DEFAULT_OPERATOR),
    stopIds: resolveStationStopIds(stopMap, station),
  }));

  return {
    getRoutePassThroughInfo(candidate) {
      const operator = normalizedValue(candidate?.operator || candidate?.co || DEFAULT_OPERATOR);
      const routeKey = exactRouteKey(candidate);
      if (!routeKey) return null;

      const fullStopIds = routeStops[routeKey];
      if (!Array.isArray(fullStopIds) || fullStopIds.length < 3) return null;
      const legStopIds = travelledStopIds(candidate, fullStopIds);
      if (legStopIds.length < 3) return null;

      // Boarding and alighting stops are intentionally excluded: the badge says
      // that the vehicle passes through an intermediate station.
      const intermediateStopIds = legStopIds.slice(1, -1);
      for (const station of resolvedStations) {
        if (station.operator !== operator || station.stopIds.size === 0) continue;
        const targetStopId = intermediateStopIds.find((stopId) => station.stopIds.has(stopId));
        if (!targetStopId) continue;
        return {
          stationId: station.id,
          targetStopId,
          routeKey,
          label: station.label,
        };
      }
      return null;
    },
  };
}

export function annotateRoutePassThrough(candidate, detector) {
  return {
    ...candidate,
    passThroughInfo: detector?.getRoutePassThroughInfo?.(candidate) || null,
  };
}

export function resolveBookmarkRouteCandidates(bookmarkRoute, {
  bookmarkStopId = '',
  stopRoutes = {},
} = {}) {
  const route = normalizedValue(bookmarkRoute?.route);
  const serviceType = normalizedValue(bookmarkRoute?.service_type || '1');
  const storedBound = normalizedValue(bookmarkRoute?.bound);
  const storedSequence = Number(bookmarkRoute?.seq);
  const hasStoredSequence = Number.isInteger(storedSequence) && storedSequence > 0;
  const fromStop = String(bookmarkRoute?.stopId || bookmarkStopId || '').trim();
  if (!route || !serviceType || !fromStop) return [];

  const matches = (stopRoutes[fromStop] || []).filter((candidate) => (
    normalizedValue(candidate?.route) === route
    && normalizedValue(candidate?.service_type || '1') === serviceType
    && (!storedBound || normalizedValue(candidate?.bound) === storedBound)
    && (!hasStoredSequence || Number(candidate?.seq) === storedSequence)
  ));
  const candidates = matches.length > 0
    ? matches
    : storedBound
      ? [{
          route,
          bound: storedBound,
          service_type: serviceType,
          seq: bookmarkRoute?.seq,
        }]
      : [];

  return Array.from(new Map(candidates.map((candidate) => {
    const bound = normalizedValue(candidate?.bound);
    const sequence = bookmarkRoute?.seq || candidate?.seq;
    const key = `${route}|${bound}|${serviceType}|${fromStop}|${sequence || ''}`;
    return [key, {
      operator: normalizedValue(bookmarkRoute?.operator || DEFAULT_OPERATOR),
      route,
      bound,
      service_type: serviceType,
      fromStop,
      fromSequence: sequence,
    }];
  })).values()).filter((candidate) => candidate.bound);
}

export function getBookmarkRoutePassThroughInfo(bookmarkRoute, context = {}) {
  const candidates = resolveBookmarkRouteCandidates(bookmarkRoute, context);
  if (candidates.length === 0) return null;
  const infos = candidates.map((candidate) => (
    context.detector?.getRoutePassThroughInfo?.(candidate) || null
  ));

  if (normalizedValue(bookmarkRoute?.bound) && candidates.length === 1) {
    return infos[0] || null;
  }

  // A legacy bookmark has no direction. Only infer a notice when every exact
  // route variant serving that saved stop agrees, preventing direction-based
  // false positives while keeping old records compatible.
  if (infos.some((info) => !info)) return null;
  const firstStationId = infos[0]?.stationId;
  return firstStationId && infos.every((info) => info.stationId === firstStationId)
    ? infos[0]
    : null;
}
