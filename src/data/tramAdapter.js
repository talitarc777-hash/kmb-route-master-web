import { buildGeoResolver, buildOperatorSummary, createStaticDatasetLoader } from './operatorCommon.js';

const loadTramDatasetInternal = createStaticDatasetLoader('tram', '/operator-data/tram.compact.json');

export async function loadTramDataset() {
  return loadTramDatasetInternal();
}

export const resolveTramGridStop = buildGeoResolver('tram');

export async function getTramSummary() {
  return buildOperatorSummary(await loadTramDataset());
}

export const tramAdapter = {
  operator: 'TRAM',
  loadDataset: loadTramDataset,
  resolveGridStop: resolveTramGridStop,
  getSummary: getTramSummary,
};
