import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  clearKmbStaticInflightForTests,
  createLatestRequestTracker,
  filterRouteOptionsByGoogleTransitPermission,
  loadKmbPayloads,
} from '../src/utils/routePlanningRequests.js';
import {
  buildKmbGeometryCacheKey,
  filterKmbOverlayVariantsByDirection,
} from '../src/utils/kmbGeometryCache.js';

const engineSource = await readFile(new URL('../public/routeEngine.js', import.meta.url), 'utf8');

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function loadEngine(fetchImpl) {
  const storage = new Map();
  const context = {
    console,
    fetch: fetchImpl,
    URLSearchParams,
    window: {
      location: { hostname: 'example.test' },
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(engineSource, context, { filename: 'routeEngine.js' });
  return context.window.routeEngine;
}

function schedule(start = '06:00', end = '23:00') {
  const station = { s: start, e: end, n: 50, d: 10, a: ['08:00'] };
  return {
    route_stops: { '1|I|1|A': { weekday: station } },
    routes: { '1|I|1': { weekday: { ...station, n: 200 } } },
  };
}

function directFixture() {
  const route = { route: '1', bound: 'I', service_type: '1' };
  return {
    originLoc: { lat: 22.3000, lng: 114.1700 },
    destLoc: { lat: 22.3100, lng: 114.1800 },
    stopMap: {
      A: { lat: 22.3000, lng: 114.1700, name_en: 'A' },
      B: { lat: 22.3100, lng: 114.1800, name_en: 'B' },
    },
    routeMap: { '1|I|1': { ...route, co: 'KMB', freq: '10' } },
    routeStops: { '1|I|1': ['A', 'B'] },
    stopRoutes: { A: [route, { ...route }], B: [route, { ...route }] },
    excludedRoutesText: '',
    strictEtaOnly: true,
    allowSparseHistoricalFallback: false,
  };
}

test('deduplicates concurrent and fresh sequential ETA requests for 30 seconds', async () => {
  let etaRequests = 0;
  const engine = loadEngine(async (url) => {
    assert.match(String(url), /\/eta\/A\/1\/1$/);
    etaRequests += 1;
    return jsonResponse({ data: [{ eta: new Date(Date.now() + 10 * 60_000).toISOString() }] });
  });

  const [first, second] = await Promise.all([
    engine.fetchETA('A', '1', '1'),
    engine.fetchETA('A', '1', '1'),
  ]);
  const third = await engine.fetchETA('A', '1', '1');

  assert.equal(etaRequests, 1);
  assert.equal(first.length, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
});

test('Now timing uses live ETA while leave-at and arrive-at timing never request ETA', async () => {
  let etaRequests = 0;
  const operationSchedule = schedule();
  const now = new Date(2026, 6, 15, 7, 50, 0);
  const engine = loadEngine(async (url) => {
    if (String(url).includes('/eta/')) {
      etaRequests += 1;
      return jsonResponse({ data: [{ eta: new Date(now.getTime() + 10 * 60_000).toISOString() }] });
    }
    return jsonResponse(operationSchedule);
  });
  const makeRoute = () => ({
    walkTimeOrigin: 0,
    walkTimeDest: 0,
    segments: [{
      route: '1', bound: 'I', service_type: '1', fromStop: 'A', toStop: 'B',
      stops: ['A', 'B'], routeInfo: { co: 'KMB', freq: '10' },
      routeStopRecordExists: true, boardingStopSequence: 1, isLoopOrAmbiguousRoute: false,
    }],
  });

  const liveRoute = makeRoute();
  assert.equal(await engine.applyRouteTiming(liveRoute, { timeMode: 'now', now }), true);
  assert.equal(liveRoute.segments[0].hasActiveEta, true);
  assert.equal(etaRequests, 1);

  const plannedRoute = makeRoute();
  assert.equal(await engine.applyRouteTiming(plannedRoute, {
    timeMode: 'leave', dateValue: '2026-07-15', timeValue: '08:00', now,
  }), true);
  assert.equal(plannedRoute.segments[0].hasActiveEta, false);
  assert.equal(etaRequests, 1);

  const arriveRoute = makeRoute();
  assert.equal(await engine.applyRouteTiming(arriveRoute, {
    timeMode: 'arrive', dateValue: '2026-07-15', timeValue: '09:00', now,
  }), true);
  assert.equal(arriveRoute.segments[0].hasActiveEta, false);
  assert.equal(etaRequests, 1);
});

test('Now timing keeps a future transfer outside the live ETA horizon when its stop is operating', async () => {
  const now = new Date(2026, 6, 15, 7, 50, 0);
  const operationSchedule = {
    route_stops: {
      '2|I|1|B': {
        weekday: { s: '06:00', e: '23:00', n: 20, d: 10, a: ['06:00'] },
      },
    },
    routes: {
      '2|I|1': {
        weekday: { s: '06:00', e: '23:00', n: 100, d: 10, a: ['06:00'] },
      },
    },
  };
  const engine = loadEngine(async (url) => {
    const value = String(url);
    if (value.includes('/eta/A/1/1')) {
      return jsonResponse({
        data: [{ eta: new Date(now.getTime() + 10 * 60_000).toISOString() }],
      });
    }
    if (value.includes('/eta/B/2/1')) return jsonResponse({ data: [] });
    if (value.includes('kmb_operation_time_slots')) return jsonResponse(operationSchedule);
    throw new Error('Unexpected network request: ' + url);
  });
  const makeSegment = (route, fromStop, toStop) => ({
    route,
    bound: 'I',
    service_type: '1',
    fromStop,
    toStop,
    stops: [fromStop, toStop],
    routeInfo: { co: 'KMB', freq: '10' },
    routeStopRecordExists: true,
    boardingStopSequence: 1,
    isLoopOrAmbiguousRoute: false,
  });
  const route = {
    walkTimeOrigin: 0,
    walkTimeDest: 0,
    transferWalkTimes: [0],
    segments: [
      makeSegment('1', 'A', 'B'),
      makeSegment('2', 'B', 'C'),
    ],
  };

  assert.equal(await engine.applyRouteTiming(route, { timeMode: 'now', now }), true);
  assert.equal(route.segments[0].hasActiveEta, true);
  assert.equal(route.segments[1].hasActiveEta, false);
  assert.equal(
    route.segments[1].timingFallbackReason,
    'transfer_eta_unavailable_historical_schedule',
  );
  assert.equal(route.segments[1].historicalSchedule.status, 'operating_station_level');
});

test('Now shortlist prioritizes an operating transfer over faster inactive route pairs', async () => {
  const period = { s: '00:00', e: '23:59', n: 50, d: 10, a: ['12:00'] };
  const activeEveryDay = {
    weekday: period,
    saturday: period,
    sunday_public_holiday: period,
  };
  const inactiveEveryDay = {
    weekday: null,
    saturday: null,
    sunday_public_holiday: null,
  };
  const operationSchedule = { route_stops: {}, routes: {} };
  for (let i = 0; i < 7; i++) {
    const profile = i === 6 ? activeEveryDay : inactiveEveryDay;
    operationSchedule.route_stops[`D${i}|I|1|T${i}`] = profile;
    operationSchedule.routes[`D${i}|I|1`] = profile;
  }

  const nowMs = Date.now();
  const engine = loadEngine(async (url) => {
    const value = String(url);
    if (value.includes('kmb_operation_time_slots')) return jsonResponse(operationSchedule);
    if (value.includes('/eta/O/R/1')) {
      return jsonResponse({
        data: [{ eta: new Date(nowMs + 5 * 60_000).toISOString() }],
      });
    }
    if (value.includes('/eta/')) return jsonResponse({ data: [] });
    if (value.includes('/api/google/')) {
      return jsonResponse({ status: 'ZERO_RESULTS', routes: [] });
    }
    throw new Error('Unexpected network request: ' + url);
  });

  const originRoute = { route: 'R', bound: 'O', service_type: '1' };
  const stopMap = {
    O: { lat: 22.2000, lng: 114.1000, name_en: 'Origin' },
    D: { lat: 22.2800, lng: 114.1000, name_en: 'Destination' },
  };
  const routeMap = {
    'R|O|1': { ...originRoute, co: 'KMB', freq: '10' },
  };
  const routeStops = { 'R|O|1': ['O'] };
  const stopRoutes = { O: [originRoute], D: [] };

  for (let i = 0; i < 7; i++) {
    const stopId = `T${i}`;
    const destRoute = { route: `D${i}`, bound: 'I', service_type: '1' };
    stopMap[stopId] = {
      lat: 22.2100 + i * 0.0100,
      lng: 114.1000,
      name_en: stopId,
    };
    routeStops['R|O|1'].push(stopId);
    routeMap[`D${i}|I|1`] = { ...destRoute, co: 'KMB', freq: '10' };
    routeStops[`D${i}|I|1`] = [stopId, 'D'];
    stopRoutes[stopId] = [originRoute, destRoute];
    stopRoutes.D.push(destRoute);
  }

  const result = await engine.findRoutes({
    originLoc: { lat: stopMap.O.lat, lng: stopMap.O.lng },
    destLoc: { lat: stopMap.D.lat, lng: stopMap.D.lng },
    stopMap,
    routeMap,
    routeStops,
    stopRoutes,
    timeMode: 'now',
    dateValue: '',
    timeValue: '',
    excludedRoutesText: '',
    strictEtaOnly: true,
    allowSparseHistoricalFallback: false,
  });

  assert.ok(result.filteredCandidates.length > 0);
  assert.equal(
    result.filteredCandidates[0].segments.map((segment) => segment.route).join(' -> '),
    'R -> D6',
  );
});

test('planned search rejects a clearly inactive route before Google enrichment', async () => {
  const urls = [];
  const engine = loadEngine(async (url) => {
    urls.push(String(url));
    if (String(url).includes('kmb_operation_time_slots')) return jsonResponse(schedule('12:00', '13:00'));
    throw new Error(`Unexpected network request: ${url}`);
  });

  const result = await engine.findRoutes({
    ...directFixture(),
    timeMode: 'leave',
    dateValue: '2026-07-15',
    timeValue: '08:00',
  });

  assert.equal(result.filteredCandidates.length, 0);
  assert.equal(result.debugSummary.earlyHistoricalRejected, 1);
  assert.equal(result.debugSummary.externalRequestCount, 1);
  assert.equal(urls.some((url) => url.includes('/api/google/')), false);
  assert.equal(urls.some((url) => url.includes('/eta/')), false);
});

test('Now search rejects a route with no live ETA before Google enrichment', async () => {
  const urls = [];
  const engine = loadEngine(async (url) => {
    urls.push(String(url));
    if (String(url).includes('/eta/')) return jsonResponse({ data: [] });
    throw new Error(`Unexpected network request: ${url}`);
  });

  const result = await engine.findRoutes({
    ...directFixture(),
    timeMode: 'now',
    dateValue: '',
    timeValue: '',
  });

  assert.equal(result.filteredCandidates.length, 0);
  assert.equal(result.debugSummary.earlyLiveEtaRejected, 1);
  assert.equal(urls.filter((url) => url.includes('/eta/')).length, 1);
  assert.equal(urls.some((url) => url.includes('/api/google/')), false);
});

test('does not create meaningless same-number transfers such as 116 to 116', async () => {
  const urls = [];
  const engine = loadEngine(async (url) => {
    urls.push(String(url));
    throw new Error(`Unexpected network request: ${url}`);
  });
  const inbound116 = { route: '116', bound: 'I', service_type: '1' };
  const outbound116 = { route: '116', bound: 'O', service_type: '1' };
  const stopMap = {
    O: { lat: 22.3000, lng: 114.1000, name_en: 'Origin' },
    T: { lat: 22.3100, lng: 114.1100, name_en: 'Alight' },
    B: { lat: 22.3101, lng: 114.1101, name_en: 'Board' },
    D: { lat: 22.3200, lng: 114.1200, name_en: 'Destination' },
  };

  const result = await engine.findRoutes({
    originLoc: { lat: stopMap.O.lat, lng: stopMap.O.lng },
    destLoc: { lat: stopMap.D.lat, lng: stopMap.D.lng },
    stopMap,
    routeMap: {
      '116|I|1': { ...inbound116, co: 'KMB', freq: '10' },
      '116|O|1': { ...outbound116, co: 'KMB', freq: '10' },
    },
    routeStops: {
      '116|I|1': ['O', 'T'],
      '116|O|1': ['B', 'D'],
    },
    stopRoutes: {
      O: [inbound116], T: [inbound116], B: [outbound116], D: [outbound116],
    },
    timeMode: 'now',
    dateValue: '',
    timeValue: '',
    excludedRoutesText: '',
    strictEtaOnly: true,
    allowSparseHistoricalFallback: false,
  });

  assert.equal(result.filteredCandidates.length, 0);
  assert.equal(result.debugSummary.candidatesGenerated, 0);
  assert.equal(urls.length, 0);
});

test('shared-corridor transfers keep KT609-like early options until live ranking', async () => {
  const nowMs = Date.now();
  const etaAt = (minutes) => new Date(nowMs + minutes * 60_000).toISOString();
  const engine = loadEngine(async (url) => {
    const value = String(url);
    if (value.includes('kmb_operation_time_slots')) return jsonResponse({});
    if (value.includes('/eta/O/671/1')) return jsonResponse({ data: [{ eta: etaAt(5) }] });
    if (value.includes('/eta/B1/269C/1')) return jsonResponse({ data: [{ eta: etaAt(15) }] });
    if (value.includes('/eta/B2/269C/1')) return jsonResponse({ data: [{ eta: etaAt(18) }] });
    if (value.includes('/api/google/')) return jsonResponse({ status: 'ZERO_RESULTS', routes: [] });
    throw new Error(`Unexpected network request: ${url}`);
  });
  const route671 = { route: '671', bound: 'I', service_type: '1' };
  const route269c = { route: '269C', bound: 'I', service_type: '1' };
  const stopMap = {
    O: { lat: 22.291733, lng: 114.202568, name_en: 'Island Place' },
    K1: { lat: 22.309933, lng: 114.229647, name_en: 'Kwun Tong Law Courts (KT609)' },
    B1: { lat: 22.309291, lng: 114.228462, name_en: 'Shing Yip Street Rest Garden (KT446)' },
    K2: { lat: 22.328563, lng: 114.212227, name_en: 'Kai Tai Court (KT677)' },
    B2: { lat: 22.328468, lng: 114.212309, name_en: 'Kai Tai Court (KT676)' },
    D: { lat: 22.4467, lng: 114.0030, name_en: 'Tin Shing' },
  };

  const result = await engine.findRoutes({
    originLoc: { lat: stopMap.O.lat, lng: stopMap.O.lng },
    destLoc: { lat: stopMap.D.lat, lng: stopMap.D.lng },
    stopMap,
    routeMap: {
      '671|I|1': { ...route671, co: 'KMB', freq: '10' },
      '269C|I|1': { ...route269c, co: 'KMB', freq: '10' },
    },
    routeStops: {
      '671|I|1': ['O', 'K1', 'K2'],
      '269C|I|1': ['B1', 'B2', 'D'],
    },
    stopRoutes: {
      O: [route671], K1: [route671], K2: [route671],
      B1: [route269c], B2: [route269c], D: [route269c],
    },
    timeMode: 'now',
    dateValue: '',
    timeValue: '',
    excludedRoutesText: '',
    strictEtaOnly: true,
    allowSparseHistoricalFallback: false,
  });

  assert.equal(result.debugSummary.candidatesGenerated, 2);
  assert.equal(result.debugSummary.candidatesAfterServiceValidation, 2);
  assert.equal(result.filteredCandidates.length, 1);
  assert.equal(result.filteredCandidates[0].segments[0].toStop, 'K1');
  assert.equal(result.filteredCandidates[0].segments[1].fromStop, 'B1');
});

test('duplicate route records produce one candidate and reuse enrichment requests', async () => {
  const operationSchedule = schedule();
  const urls = [];
  const engine = loadEngine(async (url) => {
    urls.push(String(url));
    if (String(url).includes('kmb_operation_time_slots')) return jsonResponse(operationSchedule);
    if (String(url).includes('/api/google/')) return jsonResponse({ status: 'ZERO_RESULTS', routes: [] });
    throw new Error(`Unexpected network request: ${url}`);
  });

  const result = await engine.findRoutes({
    ...directFixture(),
    timeMode: 'leave',
    dateValue: '2026-07-15',
    timeValue: '08:00',
  });
  const repeated = await engine.findRoutes({
    ...directFixture(),
    timeMode: 'leave',
    dateValue: '2026-07-15',
    timeValue: '08:00',
  });

  assert.equal(result.debugSummary.candidatesGenerated, 1);
  assert.equal(result.filteredCandidates.length, 1);
  assert.equal(urls.some((url) => url.includes('/eta/')), false);
  assert.equal(repeated.debugSummary.candidatesGenerated, 1);
  assert.ok(repeated.debugSummary.requests.gcpCacheHits >= 3);
  assert.equal(repeated.debugSummary.requests.gcpNetworkRequests, 0);
});

test('static KMB loader shares concurrent payload downloads', async () => {
  clearKmbStaticInflightForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await Promise.resolve();
    return jsonResponse({ data: [] });
  };
  const endpoints = ['/stop', '/route', '/route-stop'];

  const [first, second] = await Promise.all([
    loadKmbPayloads(endpoints, 'test', fetchImpl),
    loadKmbPayloads(endpoints, 'test', fetchImpl),
  ]);

  assert.equal(calls, 3);
  assert.equal(first, second);
});

test('latest-request tracker marks an earlier result stale', () => {
  const tracker = createLatestRequestTracker();
  const first = tracker.start();
  const second = tracker.start();

  assert.equal(tracker.isCurrent(first), false);
  assert.equal(tracker.isCurrent(second), true);
  tracker.invalidate();
  assert.equal(tracker.isCurrent(second), false);
});

test('KMB geometry cache separates partial and full stop sequences for one route variant', () => {
  const routeKey = '269B|I|1';
  const selectedSegment = buildKmbGeometryCacheKey(
    ['YT673', 'YT674B', 'YL232', 'YL234', 'TN201', 'TN206'],
    routeKey,
  );
  const fullInboundRoute = buildKmbGeometryCacheKey(
    ['HH902', 'HH321', 'HH978', 'YT629', 'YT632', 'YT102', 'YT109', 'YT112',
      'YT114', 'YT133', 'YT673', 'YT674B', 'YL232', 'YL234', 'TN201', 'TN206',
      'TN212', 'TN220', 'TN223', 'TN225', 'TN550', 'TN552', 'TN537', 'TN942'],
    routeKey,
  );

  assert.notEqual(selectedSegment, fullInboundRoute);
  assert.equal(
    selectedSegment,
    buildKmbGeometryCacheKey(
      ['YT673', 'YT674B', 'YL232', 'YL234', 'TN201', 'TN206'],
      routeKey,
    ),
  );
});

test('KMB overlay direction switch keeps only the requested I or O variants', () => {
  const variants = ['269B|I|1', '269B|I|2', '269B|O|1'];

  assert.deepEqual(
    filterKmbOverlayVariantsByDirection(variants, 'I'),
    ['269B|I|1', '269B|I|2'],
  );
  assert.deepEqual(
    filterKmbOverlayVariantsByDirection(variants, 'o'),
    ['269B|O|1'],
  );
});

test('non-KMB route options require explicit Google Transit permission', () => {
  const kmb = { id: 'kmb', segments: [{ route: '1' }] };
  const citybusFallback = {
    id: 'ctb-google',
    type: 'fallback_candidate',
    operator: 'CTB',
    legs: [{ operator: 'CTB' }],
  };
  const hybridFallback = {
    id: 'hybrid-google',
    isFallback: true,
    operator: 'KMB+CTB',
    legs: [{ operator: 'KMB' }, { operator: 'CTB' }],
  };
  const undeclaredCitybus = {
    id: 'unexpected-ctb',
    operator: 'CTB',
    legs: [{ operator: 'CTB' }],
  };
  const options = [kmb, citybusFallback, hybridFallback, undeclaredCitybus];

  assert.deepEqual(
    filterRouteOptionsByGoogleTransitPermission(options, false),
    [kmb],
  );
  assert.deepEqual(
    filterRouteOptionsByGoogleTransitPermission(options, true),
    options,
  );
});
