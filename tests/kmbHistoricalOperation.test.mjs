import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const engineSource = await readFile(new URL('../public/routeEngine.js', import.meta.url), 'utf8');

function loadEngine(schedule = null) {
  const context = {
    console,
    fetch: async () => ({ ok: true, json: async () => schedule }),
    URLSearchParams,
    window: {
      location: { hostname: 'example.test' },
      localStorage: { getItem: () => null },
    },
  };
  vm.createContext(context);
  vm.runInContext(engineSource, context, { filename: 'routeEngine.js' });
  return context.window.routeEngine;
}

function stationPeriod({ start = '06:00', end = '22:00', samples = 50, days = 10, slots = ['08:00'] } = {}) {
  return { s: start, e: end, n: samples, d: days, a: slots };
}

function routePeriod({ start = '05:30', end = '23:00', samples = 200, slots = ['08:00'] } = {}) {
  return { s: start, e: end, n: samples, a: slots };
}

function scheduleFor({ route = '1', stop = 'STOP', station = stationPeriod(), routeLevel = routePeriod() } = {}) {
  const routeKey = `${route}|I|1`;
  return {
    route_stops: station === false ? {} : {
      [`${routeKey}|${stop}`]: station === null ? { saturday: stationPeriod() } : { weekday: station },
    },
    routes: routeLevel === false ? {} : {
      [routeKey]: routeLevel === null ? { saturday: routePeriod() } : { weekday: routeLevel },
    },
  };
}

function segment(overrides = {}) {
  return {
    route: '1',
    bound: 'I',
    service_type: '1',
    fromStop: 'STOP',
    boardingStopName: 'Test Stop',
    boardingStopSequence: 4,
    routeStopRecordExists: true,
    isLoopOrAmbiguousRoute: false,
    ...overrides,
  };
}

function plannedDate(hours = 8, minutes = 0) {
  return new Date(2026, 6, 15, hours, minutes, 0);
}

test('keeps an active station-level route with high confidence and complete diagnostics', () => {
  const engine = loadEngine();
  const result = engine.validateSegmentHistoricalSchedule(
    segment(), plannedDate(), scheduleFor(),
    { requestedDateTime: plannedDate(7, 45), allowSparseDataFallback: true },
  );

  assert.equal(result.valid, true);
  assert.equal(result.status, 'operating_station_level');
  assert.equal(result.confidence, 'high');
  assert.equal(result.debug.stationLevelKey, '1|I|1|STOP');
  assert.equal(result.debug.routeLevelKey, '1|I|1');
  assert.equal(result.debug.stopSequence, 4);
  assert.equal(result.debug.stationWindow, '06:00-22:00');
  assert.equal(result.debug.stationSampleCount, 50);
  assert.equal(result.debug.stationSampleDays, 10);
  assert.equal(result.debug.fallbackUsed, false);
});

test('uses medium confidence when station samples or sample days are limited', () => {
  const engine = loadEngine();
  const schedule = scheduleFor({ station: stationPeriod({ samples: 8, days: 2 }) });
  const result = engine.validateSegmentHistoricalSchedule(segment(), plannedDate(), schedule);

  assert.equal(result.valid, true);
  assert.equal(result.status, 'operating_station_level');
  assert.equal(result.confidence, 'medium');
});

test('reads the production compact v3 station profile shape', () => {
  const engine = loadEngine();
  const slotMask = (1n << 32n).toString(16);
  const schedule = {
    v: 3,
    d: ['weekday', 'saturday', 'sunday_public_holiday'],
    sm: 15,
    r: { '1|I|1': [[360, 1320, 100, slotMask], null, null] },
    rs: { '1|I|1|STOP': [[360, 1320, 50, 10, slotMask], null, null] },
  };
  const result = engine.validateSegmentHistoricalSchedule(segment(), plannedDate(), schedule);

  assert.equal(result.valid, true);
  assert.equal(result.status, 'operating_station_level');
  assert.equal(result.confidence, 'high');
  assert.equal(result.stationWindow, '06:00-22:00');
});

test('a negative station-level result is never overridden by an active route profile', () => {
  const engine = loadEngine();
  const schedule = scheduleFor({
    station: stationPeriod({ start: '09:00', end: '10:00', slots: ['09:00'] }),
    routeLevel: routePeriod({ start: '05:00', end: '23:30' }),
  });
  const result = engine.validateSegmentHistoricalSchedule(
    segment(), plannedDate(), schedule, { allowSparseDataFallback: true },
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, 'not_operating_station_level');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.confidence, 'unsupported');
});

test('a station key with no requested-day period cannot fall back to route level', () => {
  const engine = loadEngine();
  const result = engine.validateSegmentHistoricalSchedule(
    segment(), plannedDate(), scheduleFor({ station: null }),
    { allowSparseDataFallback: true },
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, 'not_supported_by_historical_data');
  assert.equal(result.reason, 'station_profile_missing_for_day_class');
  assert.equal(result.fallbackUsed, false);
});

test('allows an explicitly enabled route-level fallback only as low confidence', () => {
  const engine = loadEngine();
  const result = engine.validateSegmentHistoricalSchedule(
    segment(), plannedDate(), scheduleFor({ station: false }),
    { allowSparseDataFallback: true },
  );

  assert.equal(result.valid, true);
  assert.equal(result.status, 'likely_operating_route_level_fallback');
  assert.equal(result.confidence, 'low');
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.reason, 'likely operating, but station-level historical data is missing');
});

test('candidate ranking prefers station-level confidence over a faster route fallback', () => {
  const engine = loadEngine();
  const highConfidence = { historicalConfidenceScore: 3, estimatedTime: 45, transfers: 0 };
  const lowConfidence = { historicalConfidenceScore: 1, estimatedTime: 25, transfers: 0 };
  const ranked = [lowConfidence, highConfidence].sort(engine.compareRouteCandidates);

  assert.equal(ranked[0], highConfidence);
  assert.equal(ranked[1], lowConfidence);
});

test('does not use route fallback without explicit caller permission', () => {
  const engine = loadEngine();
  const result = engine.validateSegmentHistoricalSchedule(
    segment(), plannedDate(), scheduleFor({ station: false }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, 'station_profile_missing');
  assert.equal(result.fallbackBlocked, true);
});

test('blocks route-level fallback when the exact route-stop record is absent', () => {
  const engine = loadEngine();
  const result = engine.validateSegmentHistoricalSchedule(
    segment({ routeStopRecordExists: false }), plannedDate(), scheduleFor({ station: false }),
    { allowSparseDataFallback: true },
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, 'route_stop_not_found');
});

test('route 110 always requires positive station-level evidence', () => {
  const engine = loadEngine();
  const result = engine.validateSegmentHistoricalSchedule(
    segment({ route: '110' }), plannedDate(), scheduleFor({ route: '110', station: false }),
    { allowSparseDataFallback: true },
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, 'fallback_blocked_strict_route');
  assert.equal(result.fallbackBlocked, true);
});

test('loop and duplicated-stop patterns cannot use route-level fallback', () => {
  const engine = loadEngine();
  const result = engine.validateSegmentHistoricalSchedule(
    segment({ isLoopOrAmbiguousRoute: true }), plannedDate(), scheduleFor({ station: false }),
    { allowSparseDataFallback: true },
  );

  assert.equal(result.valid, false);
  assert.equal(result.status, 'fallback_blocked_loop_or_ambiguous_route');
  assert.equal(result.fallbackBlocked, true);
});

test('arrive-by integration validates the estimated latest boarding time', async () => {
  const schedule = scheduleFor({
    station: stationPeriod({ start: '09:20', end: '09:30', slots: ['09:25'] }),
  });
  const engine = loadEngine(schedule);
  const route = {
    walkTimeOrigin: 5,
    walkTimeDest: 5,
    segments: [{
      ...segment(),
      stops: ['STOP', 'DEST'],
      toStop: 'DEST',
      routeInfo: { freq: '10' },
      rideDurationMinutes: 30,
    }],
  };

  const valid = await engine.applyRouteTiming(route, {
    timeMode: 'arrive',
    dateValue: '2026-07-15',
    timeValue: '10:00',
    now: new Date(2026, 6, 15, 7, 0, 0),
    allowSparseHistoricalFallback: true,
  });

  assert.equal(valid, true);
  assert.equal(new Date(route.segments[0].boardTime).getHours(), 9);
  assert.equal(new Date(route.segments[0].boardTime).getMinutes(), 25);
  assert.equal(route.segments[0].historicalSchedule.status, 'operating_station_level');
  assert.equal(route.historicalConfidence, 'high');
});

test('leave-at integration validates the computed boarding stop and time', async () => {
  const schedule = scheduleFor({
    station: stationPeriod({ start: '08:10', end: '08:20', slots: ['08:15'] }),
  });
  const engine = loadEngine(schedule);
  const route = {
    walkTimeOrigin: 5,
    walkTimeDest: 0,
    segments: [{
      ...segment(),
      stops: ['STOP', 'DEST'],
      toStop: 'DEST',
      routeInfo: { freq: '10' },
      rideDurationMinutes: 20,
    }],
  };

  const valid = await engine.applyRouteTiming(route, {
    timeMode: 'leave',
    dateValue: '2026-07-15',
    timeValue: '08:00',
    now: new Date(2026, 6, 15, 7, 0, 0),
    allowSparseHistoricalFallback: true,
  });

  assert.equal(valid, true);
  assert.equal(new Date(route.segments[0].boardTime).getHours(), 8);
  assert.equal(new Date(route.segments[0].boardTime).getMinutes(), 16);
  assert.equal(route.segments[0].historicalSchedule.requestedMinute, 8 * 60 + 16);
  assert.equal(route.segments[0].historicalSchedule.status, 'operating_station_level');
});
