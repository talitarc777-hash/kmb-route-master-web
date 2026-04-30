import { buildOperatorSummary, createStaticDatasetLoader } from './operatorCommon.js';

const loadMtrBusDatasetInternal = createStaticDatasetLoader('mtr-bus', '/api/operators/mtr-bus/dataset');

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
