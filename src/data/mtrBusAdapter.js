import { buildOperatorSummary, createStaticDatasetLoader } from './operatorCommon.js';

const loadMtrBusDatasetInternal = createStaticDatasetLoader('mtr-bus', '/operator-data/mtr-bus.compact.json');

export async function loadMtrBusDataset() {
  return loadMtrBusDatasetInternal();
}

export async function getMtrBusSummary() {
  return buildOperatorSummary(await loadMtrBusDataset());
}

export const mtrBusAdapter = {
  operator: 'MTR',
  loadDataset: loadMtrBusDataset,
  getSummary: getMtrBusSummary,
};
