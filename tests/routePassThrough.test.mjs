import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateRoutePassThrough,
  createRoutePassThroughDetector,
  getBookmarkRoutePassThroughInfo,
  resolveBookmarkRouteCandidates,
} from '../src/utils/routePassThrough.js';

const STOP_A = 'STOP-A';
const STOP_SHEK_PO = 'STOP-SHEK-PO';
const STOP_SAME_NAME_OTHER_POLE = 'STOP-SHEK-PO-OTHER';
const STOP_X = 'STOP-X';
const STOP_D = 'STOP-D';

function fixture() {
  const stopMap = {
    [STOP_A]: { name_en: 'Origin (YL001)', name_tc: '起點 (YL001)' },
    [STOP_SHEK_PO]: { name_en: 'SHEK PO TSUEN (YL130)', name_tc: '石埗村 (YL130)' },
    [STOP_SAME_NAME_OTHER_POLE]: { name_en: 'SHEK PO TSUEN (YL131)', name_tc: '石埗村 (YL131)' },
    [STOP_X]: { name_en: 'Other stop (YL200)', name_tc: '其他站 (YL200)' },
    [STOP_D]: { name_en: 'Destination (KT900)', name_tc: '終點 (KT900)' },
  };
  const routeStops = {
    '269C|O|5': [STOP_A, STOP_X, STOP_SHEK_PO, STOP_D],
    '269C|O|1': [STOP_A, STOP_X, STOP_D],
    '269C|I|1': [STOP_D, STOP_X, STOP_A],
    '68A|O|1': [STOP_A, STOP_X, STOP_D],
    'AMB|O|1': [STOP_A, STOP_SHEK_PO, STOP_D],
    'AMB|I|1': [STOP_A, STOP_X, STOP_D],
  };
  const stopRoutes = {
    [STOP_A]: [
      { route: '269C', bound: 'O', service_type: '5', seq: 1 },
      { route: '269C', bound: 'O', service_type: '1', seq: 1 },
      { route: '269C', bound: 'I', service_type: '1', seq: 3 },
      { route: '68A', bound: 'O', service_type: '1', seq: 1 },
      { route: 'AMB', bound: 'O', service_type: '1', seq: 1 },
      { route: 'AMB', bound: 'I', service_type: '1', seq: 1 },
    ],
  };
  return {
    detector: createRoutePassThroughDetector({ routeStops, stopMap }),
    routeStops,
    stopMap,
    stopRoutes,
  };
}

test('detects Shek Po from the exact 269C direction and service stop sequence', () => {
  const { detector } = fixture();
  const info = detector.getRoutePassThroughInfo({
    operator: 'KMB',
    route: '269C',
    bound: 'O',
    service_type: '5',
    fromStop: STOP_A,
    toStop: STOP_D,
  });

  assert.equal(info?.stationId, 'shek-po-tsuen');
  assert.equal(info?.targetStopId, STOP_SHEK_PO);
  assert.equal(info?.routeKey, '269C|O|5');
  assert.match(info?.label || '', /Passes Shek Po Tsuen/);
});

test('does not match the wrong direction, service type, operator, or another route', () => {
  const { detector } = fixture();
  const base = { fromStop: STOP_A, toStop: STOP_D };

  assert.equal(detector.getRoutePassThroughInfo({ ...base, route: '269C', bound: 'I', service_type: '1' }), null);
  assert.equal(detector.getRoutePassThroughInfo({ ...base, route: '269C', bound: 'O', service_type: '1' }), null);
  assert.equal(detector.getRoutePassThroughInfo({ ...base, route: '68A', bound: 'O', service_type: '1' }), null);
  assert.equal(detector.getRoutePassThroughInfo({ ...base, operator: 'CTB', route: '269C', bound: 'O', service_type: '5' }), null);
});

test('only shows a pass-through notice when Shek Po is inside the travelled leg', () => {
  const { detector } = fixture();
  const route = { route: '269C', bound: 'O', service_type: '5' };

  assert.equal(detector.getRoutePassThroughInfo({
    ...route,
    fromStop: STOP_SHEK_PO,
    toStop: STOP_D,
  }), null);
  assert.equal(detector.getRoutePassThroughInfo({
    ...route,
    fromStop: STOP_A,
    toStop: STOP_SHEK_PO,
  }), null);
  assert.equal(detector.getRoutePassThroughInfo({
    ...route,
    fromStop: STOP_X,
    toStop: STOP_D,
    stops: [STOP_X, STOP_SHEK_PO, STOP_D],
  })?.stationId, 'shek-po-tsuen');
  assert.equal(detector.getRoutePassThroughInfo({
    ...route,
    fromStop: STOP_SHEK_PO,
    toStop: STOP_D,
    stops: [STOP_SHEK_PO, STOP_D],
  }), null);
});

test('resolves the stable YL130 stop code before same-name station aliases', () => {
  const { detector } = fixture();
  const info = detector.getRoutePassThroughInfo({
    route: '269C',
    bound: 'O',
    service_type: '5',
    stops: [STOP_A, STOP_SHEK_PO, STOP_D],
  });

  assert.equal(info?.targetStopId, STOP_SHEK_PO);
  assert.notEqual(info?.targetStopId, STOP_SAME_NAME_OTHER_POLE);
});

test('route-planning annotation carries the reusable pass-through metadata to the UI', () => {
  const { detector } = fixture();
  const annotated = annotateRoutePassThrough({
    route: '269C',
    bound: 'O',
    service_type: '5',
    fromStop: STOP_A,
    toStop: STOP_D,
    stops: [STOP_A, STOP_X, STOP_SHEK_PO, STOP_D],
  }, detector);

  assert.equal(annotated.passThroughInfo?.stationId, 'shek-po-tsuen');
});

test('an exact bookmark keeps direction metadata after serialization and rebuilds the notice', () => {
  const { detector, stopRoutes } = fixture();
  const stored = JSON.parse(JSON.stringify({
    route: '269C',
    bound: 'O',
    service_type: '5',
    stopId: STOP_A,
    seq: 1,
  }));
  const info = getBookmarkRoutePassThroughInfo(stored, {
    bookmarkStopId: STOP_A,
    stopRoutes,
    detector,
  });

  assert.equal(info?.stationId, 'shek-po-tsuen');
});

test('legacy bookmarks load safely and only infer a direction when variants agree', () => {
  const { detector, stopRoutes } = fixture();
  const legacy269C = { route: '269C', service_type: '5' };
  const legacyAmbiguous = { route: 'AMB', service_type: '1' };
  const legacyMissing = { route: 'OLD', service_type: '1' };

  assert.equal(resolveBookmarkRouteCandidates(legacy269C, {
    bookmarkStopId: STOP_A,
    stopRoutes,
  }).length, 1);
  assert.equal(getBookmarkRoutePassThroughInfo(legacy269C, {
    bookmarkStopId: STOP_A,
    stopRoutes,
    detector,
  })?.stationId, 'shek-po-tsuen');
  assert.equal(getBookmarkRoutePassThroughInfo(legacyAmbiguous, {
    bookmarkStopId: STOP_A,
    stopRoutes,
    detector,
  }), null);
  assert.equal(getBookmarkRoutePassThroughInfo(legacyMissing, {
    bookmarkStopId: STOP_A,
    stopRoutes,
    detector,
  }), null);
});
