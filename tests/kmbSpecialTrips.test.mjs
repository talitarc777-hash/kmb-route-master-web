import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  analyseKmbRouteVariant,
  annotateKmbEtaSpecialTrip,
  createKmbSpecialTripDetector,
  diffKmbStopSequences,
  formatKmbSpecialTripInfo,
} from '../src/utils/kmbSpecialTrips.js';

const bookmarkEngineSource = await readFile(
  new URL('../public/bookmarks.js', import.meta.url),
  'utf8',
);

const stopMap = {
  A: { name_en: 'Alpha', name_tc: '甲站' },
  B: { name_en: 'Bravo', name_tc: '乙站' },
  C: { name_en: 'Charlie', name_tc: '丙站' },
  D: { name_en: 'Delta', name_tc: '丁站' },
  E: { name_en: 'Echo', name_tc: '戊站' },
  X: { name_en: 'Shek Po Tsuen', name_tc: '石埗村' },
};

test('identical route-variant stop sequences are not special', () => {
  const info = analyseKmbRouteVariant({
    route: 'R',
    direction: 'O',
    serviceType: 2,
    baselineServiceType: '1',
    baselineStopIds: ['A', 'B', 'C', 'D'],
    variantStopIds: ['A', 'B', 'C', 'D'],
    stopMap,
  });

  assert.equal(info.isSpecialTrip, false);
  assert.deepEqual(info.addedStopIds, []);
  assert.deepEqual(info.skippedStopIds, []);
});

test('sequence diff detects an added intermediate stop', () => {
  const difference = diffKmbStopSequences(
    ['A', 'B', 'C', 'D'],
    ['A', 'B', 'X', 'C', 'D'],
  );

  assert.equal(difference.sequenceChanged, true);
  assert.deepEqual(difference.addedStopIds, ['X']);
  assert.deepEqual(difference.skippedStopIds, []);
});

test('sequence diff detects a skipped intermediate stop', () => {
  const difference = diffKmbStopSequences(
    ['A', 'B', 'C', 'D', 'E'],
    ['A', 'B', 'D', 'E'],
  );

  assert.deepEqual(difference.addedStopIds, []);
  assert.deepEqual(difference.skippedStopIds, ['C']);
});

test('detector compares service variants only within the same direction', () => {
  const detector = createKmbSpecialTripDetector({
    routeStops: {
      'R|O|1': ['A', 'B', 'C', 'D'],
      'R|O|2': ['A', 'B', 'X', 'C', 'D'],
      'R|I|1': ['D', 'C', 'B', 'A'],
      'R|I|2': ['D', 'C', 'B', 'A'],
    },
    stopMap,
  });

  assert.equal(detector.getVariantAnalysis({ route: 'R', bound: 'O', service_type: 2 }).isSpecialTrip, true);
  assert.equal(detector.getVariantAnalysis({ route: 'R', bound: 'I', service_type: 2 }).isSpecialTrip, false);
});

test('different service types with identical stops do not create a badge', () => {
  const detector = createKmbSpecialTripDetector({
    routeStops: {
      'R|O|1': ['A', 'B', 'C', 'D'],
      'R|O|9': ['A', 'B', 'C', 'D'],
    },
    stopMap,
  });

  assert.equal(detector.getEtaSpecialTripInfo({ route: 'R', dir: 'O', service_type: 9 }), null);
});

test('a route direction with only one service type is not special', () => {
  const detector = createKmbSpecialTripDetector({
    routeStops: { 'R|O|7': ['A', 'B', 'C'] },
    stopMap,
  });

  const info = detector.getVariantAnalysis({ route: 'R', bound: 'O', service_type: 7 });
  assert.equal(info.isSpecialTrip, false);
  assert.equal(detector.getEtaSpecialTripInfo({ route: 'R', dir: 'O', service_type: 7 }), null);
});

test('each ETA uses its own actual service_type', () => {
  const detector = createKmbSpecialTripDetector({
    routeStops: {
      'R|O|1': ['A', 'B', 'C', 'D'],
      'R|O|5': ['A', 'B', 'X', 'C', 'D'],
    },
    stopMap,
  });
  const etas = [
    { route: 'R', dir: 'O', service_type: 1, eta: '2026-08-18T10:06:00+08:00' },
    { route: 'R', dir: 'O', service_type: 5, eta: '2026-08-18T10:14:00+08:00' },
    { route: 'R', dir: 'O', service_type: '1', eta: '2026-08-18T10:22:00+08:00' },
  ].map((eta) => annotateKmbEtaSpecialTrip(
    eta,
    { route: 'R', bound: 'O', service_type: '1' },
    detector,
  ));

  assert.equal(etas[0].specialTripInfo, null);
  assert.equal(etas[1].specialTripInfo.isSpecialTrip, true);
  assert.deepEqual(etas[1].specialTripInfo.addedStopIds, ['X']);
  assert.equal(etas[2].specialTripInfo, null);
});

test('269C regression identifies Shek Po Tsuen generically from route stops', () => {
  const detector = createKmbSpecialTripDetector({
    routeStops: {
      '269C|O|1': ['A', 'B', 'C', 'D'],
      '269C|O|5': ['A', 'B', 'X', 'C', 'D'],
    },
    stopMap,
  });
  const info = detector.getEtaSpecialTripInfo({
    co: 'KMB',
    route: '269C',
    dir: 'O',
    service_type: 5,
  });

  assert.equal(info.isSpecialTrip, true);
  assert.deepEqual(info.addedStopIds, ['X']);
  assert.equal(formatKmbSpecialTripInfo(info, 'en'), 'Special trip · via Shek Po Tsuen');
  assert.equal(formatKmbSpecialTripInfo(info, 'tc'), '特別班次 · 途經 石埗村');
});

test('missing route metadata fails quietly and preserves the ETA', () => {
  const detector = createKmbSpecialTripDetector();
  const eta = { route: 'MISSING', dir: 'O', service_type: 8, eta: '2026-08-18T10:00:00+08:00' };
  const annotated = annotateKmbEtaSpecialTrip(eta, {}, detector);

  assert.deepEqual(annotated, { ...eta, specialTripInfo: null });
});

test('base selection uses service type 1 only as a tie-break and otherwise uses the dominant sequence', () => {
  const withPrimary = createKmbSpecialTripDetector({
    routeStops: {
      'R|O|1': ['A', 'B', 'C'],
      'R|O|5': ['A', 'X', 'B', 'C'],
    },
    stopMap,
  });
  assert.equal(withPrimary.getVariantAnalysis({ route: 'R', bound: 'O', service_type: 5 }).baseSelection, 'service_type_1_tiebreak');

  const primaryIsNotDominant = createKmbSpecialTripDetector({
    routeStops: {
      'T|O|1': ['A', 'X', 'B', 'C'],
      'T|O|2': ['A', 'B', 'C'],
      'T|O|3': ['A', 'B', 'C'],
    },
    stopMap,
  });
  const nonBlindInfo = primaryIsNotDominant.getVariantAnalysis({
    route: 'T',
    bound: 'O',
    service_type: 1,
  });
  assert.equal(nonBlindInfo.baselineServiceType, '2');
  assert.equal(nonBlindInfo.baseSelection, 'dominant_sequence_then_lowest_service_type');
  assert.deepEqual(nonBlindInfo.addedStopIds, ['X']);

  const withoutPrimary = createKmbSpecialTripDetector({
    routeStops: {
      'S|O|2': ['A', 'B', 'C'],
      'S|O|3': ['A', 'B', 'C'],
      'S|O|9': ['A', 'X', 'B', 'C'],
    },
    stopMap,
  });
  const fallbackInfo = withoutPrimary.getVariantAnalysis({ route: 'S', bound: 'O', service_type: 9 });
  assert.equal(fallbackInfo.baselineServiceType, '2');
  assert.equal(fallbackInfo.baseSelection, 'dominant_sequence_then_lowest_service_type');
  assert.deepEqual(fallbackInfo.addedStopIds, ['X']);
});

test('bookmark realtime ETA preserves the individual arrival service type for analysis', async () => {
  const futureEta = new Date(Date.now() + 10 * 60_000).toISOString();
  const context = {
    console,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    fetch: async (url) => {
      assert.match(String(url), /\/eta\/STOP\/269C\/1\?/);
      return {
        json: async () => ({
          data: [{
            co: 'KMB',
            route: '269C',
            dir: 'O',
            service_type: 5,
            eta: futureEta,
            rmk_en: 'Special departure',
          }],
        }),
      };
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(bookmarkEngineSource, context, { filename: 'bookmarks.js' });

  const [eta] = await context.window.bookmarkEngine.fetchStopETAs('STOP', [{
    route: '269C',
    bound: 'O',
    service_type: '1',
  }]);
  assert.equal(eta.service_type, '5');
  assert.equal(eta.direction, 'O');
  assert.equal(eta.rmk_en, 'Special departure');

  const detector = createKmbSpecialTripDetector({
    routeStops: {
      '269C|O|1': ['A', 'B', 'C'],
      '269C|O|5': ['A', 'X', 'B', 'C'],
    },
    stopMap,
  });
  const annotated = annotateKmbEtaSpecialTrip(eta, {}, detector);
  assert.equal(
    formatKmbSpecialTripInfo(annotated.specialTripInfo, 'en'),
    'Special trip · via Shek Po Tsuen',
  );
});

test('bookmark ETA order uses exact arrival timestamps when rounded minutes are equal', async () => {
  const now = Date.now();
  const laterNormalEta = new Date(now + 5 * 60_000 + 20_000).toISOString();
  const earlierSpecialEta = new Date(now + 4 * 60_000 + 40_000).toISOString();
  const context = {
    console,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    fetch: async (url) => ({
      json: async () => ({
        data: String(url).includes('/69X/2?')
          ? [{
              route: '69X',
              dir: 'O',
              service_type: 2,
              eta: earlierSpecialEta,
              eta_seq: 1,
            }]
          : [{
              route: '69X',
              dir: 'O',
              service_type: 1,
              eta: laterNormalEta,
              eta_seq: 1,
            }],
      }),
    }),
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(bookmarkEngineSource, context, { filename: 'bookmarks.js' });

  const etas = await context.window.bookmarkEngine.fetchStopETAs('STOP', [
    { route: '69X', bound: 'O', service_type: '1' },
    { route: '69X', bound: 'O', service_type: '2' },
  ]);

  assert.equal(etas[0].service_type, '2');
  assert.equal(etas[0].eta, earlierSpecialEta);
  assert.equal(etas[1].service_type, '1');
  assert.equal(etas[1].eta, laterNormalEta);
  assert.equal(etas[0].waitMin, etas[1].waitMin);
});
