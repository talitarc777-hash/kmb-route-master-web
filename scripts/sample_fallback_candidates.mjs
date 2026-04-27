import { execFileSync } from 'node:child_process';
import { generateFallbackCandidatesFromDatasets } from '../src/data/fallbackRouteGenerator.js';

function fixtureDatasets() {
  return {
    citybus: {
      operator: 'CTB',
      routes: [
        { id: 'CTB:C1', route_id: 'C1', route: 'C1', display_route: 'C1', fare: 8.5, fare_currency: 'HKD', source: 'fixture Citybus route' },
      ],
      stops: [
        { id: 'CTB:CB-A', stop_id: 'CB-A', name: { en: 'Central Pier' }, lat: 22.286, lng: 114.158, coordinate_source: 'fixture WGS84' },
        { id: 'CTB:CB-B', stop_id: 'CB-B', name: { en: 'Admiralty' }, lat: 22.279, lng: 114.165, coordinate_source: 'fixture WGS84' },
        { id: 'CTB:CB-C', stop_id: 'CB-C', name: { en: 'Causeway Bay' }, lat: 22.281, lng: 114.184, coordinate_source: 'fixture WGS84' },
      ],
      route_stops: [
        { route_variant_id: 'CTB:C1:1', route_id: 'C1', direction: '1', sequence: 1, stop_id: 'CB-A' },
        { route_variant_id: 'CTB:C1:1', route_id: 'C1', direction: '1', sequence: 2, stop_id: 'CB-B' },
        { route_variant_id: 'CTB:C1:1', route_id: 'C1', direction: '1', sequence: 3, stop_id: 'CB-C' },
      ],
      fares: [],
    },
    tram: {
      operator: 'TRAM',
      routes: [
        { id: 'TRAM:T1', route_id: 'T1', route: 'Western Market to Shau Kei Wan', display_route: 'Tram', fare: 3, fare_currency: 'HKD', source: 'fixture Tram route' },
      ],
      stops: [
        { id: 'TRAM:TR-A', stop_id: 'TR-A', name: { en: 'Central Tram Stop' }, lat: 22.282, lng: 114.157, coordinate_source: 'fixture WGS84' },
        { id: 'TRAM:TR-B', stop_id: 'TR-B', name: { en: 'Wan Chai Tram Stop' }, lat: 22.277, lng: 114.174, coordinate_source: 'fixture WGS84' },
        { id: 'TRAM:TR-C', stop_id: 'TR-C', name: { en: 'Causeway Bay Tram Stop' }, lat: 22.281, lng: 114.185, coordinate_source: 'fixture WGS84' },
      ],
      route_stops: [
        { route_variant_id: 'TRAM:T1:1', route_id: 'T1', direction: '1', sequence: 1, stop_id: 'TR-A' },
        { route_variant_id: 'TRAM:T1:1', route_id: 'T1', direction: '1', sequence: 2, stop_id: 'TR-B' },
        { route_variant_id: 'TRAM:T1:1', route_id: 'T1', direction: '1', sequence: 3, stop_id: 'TR-C' },
      ],
      fares: [],
    },
    mtr: {
      operator: 'MTR',
      routes: [
        { id: 'MTR:ISL:DT', route_id: 'ISL', route: 'ISL', line: 'ISL', display_route: 'ISL', source: 'fixture MTR route' },
      ],
      stops: [
        { id: 'MTR:1', stop_id: '1', station_code: 'CEN', name: { en: 'Central' }, lat: 22.282, lng: 114.158, coordinate_source: 'fixture WGS84' },
        { id: 'MTR:2', stop_id: '2', station_code: 'ADM', name: { en: 'Admiralty' }, lat: 22.278, lng: 114.165, coordinate_source: 'fixture WGS84' },
        { id: 'MTR:3', stop_id: '3', station_code: 'WAC', name: { en: 'Wan Chai' }, lat: 22.277, lng: 114.173, coordinate_source: 'fixture WGS84' },
        { id: 'MTR:4', stop_id: '4', station_code: 'CAB', name: { en: 'Causeway Bay' }, lat: 22.281, lng: 114.185, coordinate_source: 'fixture WGS84' },
      ],
      route_stops: [
        { route_variant_id: 'MTR:ISL:DT', route_id: 'ISL', direction: 'DT', sequence: 1, stop_id: '1' },
        { route_variant_id: 'MTR:ISL:DT', route_id: 'ISL', direction: 'DT', sequence: 2, stop_id: '2' },
        { route_variant_id: 'MTR:ISL:DT', route_id: 'ISL', direction: 'DT', sequence: 3, stop_id: '3' },
        { route_variant_id: 'MTR:ISL:DT', route_id: 'ISL', direction: 'DT', sequence: 4, stop_id: '4' },
      ],
      fares: [
        { src_stop_id: '1', dest_stop_id: '4', fare_rule: { octopus_adult: 7.5 }, currency: 'HKD', source: 'fixture MTR fare' },
        { src_stop_id: '2', dest_stop_id: '4', fare_rule: { octopus_adult: 6.5 }, currency: 'HKD', source: 'fixture MTR fare' },
      ],
    },
  };
}

function loadLiveDatasets() {
  const datasetJson = execFileSync(
    'python',
    [
      '-c',
      `
import json, sys
sys.path.insert(0, 'api')
import open_data

def compact(dataset):
    return {
        'operator': dataset.get('operator'),
        'sources': dataset.get('sources', {}),
        'routes': [
            {k: route.get(k) for k in ('id', 'route_id', 'route', 'line', 'display_route', 'source', 'full_fare', 'fare', 'fare_currency')}
            for route in dataset.get('routes', [])
        ],
        'route_stops': [
            {k: route_stop.get(k) for k in ('route_variant_id', 'route_id', 'direction', 'sequence', 'stop_id')}
            for route_stop in dataset.get('route_stops', [])
        ],
        'stops': [
            {k: stop.get(k) for k in ('id', 'stop_id', 'station_code', 'name', 'lat', 'lng', 'coordinate_source')}
            for stop in dataset.get('stops', [])
        ],
        'fares': dataset.get('fares', []),
    }

payload = {
    'citybus': compact(open_data.build_citybus_dataset()),
    'tram': compact(open_data.build_tram_dataset()),
    'mtr': compact(open_data.build_mtr_dataset()),
}
print(json.dumps(payload, ensure_ascii=False))
`,
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
      maxBuffer: 80 * 1024 * 1024,
    },
  );
  return JSON.parse(datasetJson);
}

let datasets;
let source = 'live enriched operator datasets';
try {
  datasets = process.argv.includes('--fixture') ? fixtureDatasets() : loadLiveDatasets();
  if (process.argv.includes('--fixture')) source = 'deterministic fixture datasets';
} catch (error) {
  console.warn(`Live dataset sample failed: ${error.message}`);
  console.warn('Falling back to deterministic fixture datasets.');
  datasets = fixtureDatasets();
  source = 'deterministic fixture datasets';
}

const sample = generateFallbackCandidatesFromDatasets({
  datasets,
  originLoc: { lat: 22.2825, lng: 114.158, name: 'Central' },
  destLoc: { lat: 22.281, lng: 114.184, name: 'Causeway Bay' },
  maxCandidates: 8,
});

console.log(JSON.stringify({ ...sample, sample_source: source }, null, 2));
