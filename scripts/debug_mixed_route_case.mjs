import { execFileSync } from 'node:child_process';
import { generateFallbackCandidatesFromDatasets } from '../src/data/fallbackRouteGenerator.js';

const ROOT = new URL('..', import.meta.url);

function fetchJson(url) {
  return JSON.parse(execFileSync('curl.exe', ['-L', '-s', url], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 120 * 1024 * 1024,
  }));
}

function loadKmbDataset() {
  const stopsData = fetchJson('https://data.etabus.gov.hk/v1/transport/kmb/stop').data || [];
  const routesData = fetchJson('https://data.etabus.gov.hk/v1/transport/kmb/route').data || [];
  const routeStopsData = fetchJson('https://data.etabus.gov.hk/v1/transport/kmb/route-stop').data || [];

  const stopMap = {};
  for (const stop of stopsData) {
    stopMap[stop.stop] = {
      name_en: stop.name_en,
      name_tc: stop.name_tc,
      lat: Number(stop.lat),
      lng: Number(stop.long),
    };
  }

  const routeMap = {};
  for (const route of routesData) {
    routeMap[`${route.route}|${route.bound}|${route.service_type}`] = route;
  }

  const routeStops = {};
  for (const row of routeStopsData) {
    const key = `${row.route}|${row.bound}|${row.service_type}`;
    if (!routeStops[key]) routeStops[key] = [];
    routeStops[key].push(row.stop);
  }

  return {
    operator: 'KMB',
    routes: Object.entries(routeMap).map(([routeKey, route]) => ({
      id: `KMB:${routeKey}`,
      operator: 'KMB',
      route_id: routeKey,
      route: route.route,
      line: route.route,
      display_route: route.route,
      route_name: { tc: route.dest_tc || route.orig_tc || null, en: route.dest_en || route.orig_en || route.route },
      direction: route.bound,
      service_type: route.service_type,
      fare: 0,
      fare_currency: 'HKD',
      source: 'KMB Open Data',
    })),
    stops: Object.entries(stopMap).map(([stopId, stop]) => ({
      id: `KMB:${stopId}`,
      operator: 'KMB',
      stop_id: `KMB:${stopId}`,
      name: { tc: stop.name_tc || null, en: stop.name_en || null },
      lat: stop.lat,
      lng: stop.lng,
      coordinate_source: 'KMB Open Data',
    })),
    route_stops: Object.entries(routeStops).flatMap(([routeKey, stopIds]) =>
      stopIds.map((stopId, index) => ({
        id: `KMB:${routeKey}:${index + 1}:${stopId}`,
        operator: 'KMB',
        route_id: routeKey,
        route_variant_id: `KMB:${routeKey}`,
        direction: routeMap[routeKey]?.bound || null,
        service_type: routeMap[routeKey]?.service_type || null,
        sequence: index + 1,
        stop_id: `KMB:${stopId}`,
      })),
    ),
    fares: [],
  };
}

function loadMtrBusDataset() {
  const datasetJson = execFileSync(
    'python',
    [
      '-c',
      `
import json, sys
sys.path.insert(0, 'api')
import open_data
print(json.dumps(open_data.build_mtr_bus_dataset(), ensure_ascii=False))
`,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 80 * 1024 * 1024,
    },
  );
  return JSON.parse(datasetJson);
}

const sample = await generateFallbackCandidatesFromDatasets({
  datasets: {
    kmb: loadKmbDataset(),
    mtr_bus: loadMtrBusDataset(),
  },
  originLoc: { lat: 22.2921, lng: 114.2081, name: 'North Point Government Offices' },
  destLoc: { lat: 22.44018, lng: 113.99171, name: '新生村' },
  operatorModes: ['kmb', 'mtr_bus'],
  includeTransfers: true,
  walkRadiusKm: 8,
  transferRadiusKm: 1.2,
  maxCandidates: 12,
});

console.log(JSON.stringify({
  debug: sample.debug,
  candidates: sample.candidates.map((candidate) => ({
    route: candidate.route,
    operator: candidate.operator,
    time: candidate.estimated_time_min,
    fare: candidate.fare,
    transfers: candidate.transfers,
    legs: candidate.legs?.map((leg) => ({
      mode: leg.mode,
      route: leg.route,
      from: leg.origin_stop?.name,
      to: leg.destination_stop?.name,
      ride: leg.ride_time_min,
    })),
  })),
}, null, 2));
