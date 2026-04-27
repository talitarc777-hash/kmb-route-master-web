import { buildGeoResolver, buildOperatorSummary, createEtaLoader, createStaticDatasetLoader } from './operatorCommon';

const loadCitybusDatasetInternal = createStaticDatasetLoader('citybus', '/api/operators/citybus/dataset');
const loadCitybusEtaInternal = createEtaLoader('citybus-eta', ({ stopId, route }) =>
  `/api/operators/citybus/eta/${encodeURIComponent(stopId)}/${encodeURIComponent(route)}`,
);

export async function loadCitybusDataset() {
  return loadCitybusDatasetInternal();
}

export async function getCitybusETA(stopId, route) {
  return loadCitybusEtaInternal({ stopId, route });
}

export async function getCitybusStop(stopId) {
  const response = await fetch(`/api/operators/citybus/stop/${encodeURIComponent(stopId)}`);
  if (!response.ok) {
    throw new Error(`Failed to load Citybus stop ${stopId}: ${response.status}`);
  }
  return response.json();
}

export const resolveCitybusGridStop = buildGeoResolver('citybus');

export async function getCitybusSummary() {
  return buildOperatorSummary(await loadCitybusDataset());
}

export const citybusAdapter = {
  operator: 'CTB',
  loadDataset: loadCitybusDataset,
  getETA: getCitybusETA,
  getStop: getCitybusStop,
  resolveGridStop: resolveCitybusGridStop,
  getSummary: getCitybusSummary,
};
