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

test('shared-corridor transfers keep KT609-like early options until live ranking', async () => {
  const nowMs = Date.now();
  const etaAt = (minutes) => new Date(nowMs + minutes * 60_000).toISOString();
  const engine = loadEngine(async (url) => {
    const value = String(url);
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
