import { buildOperatorSummary, createEtaLoader, createStaticDatasetLoader } from './operatorCommon.js';

const loadMtrDatasetInternal = createStaticDatasetLoader('mtr', '/api/operators/mtr/dataset?compact=1');
const loadMtrEtaInternal = createEtaLoader('mtr-eta', ({ line, station }) =>
  `/api/operators/mtr/eta?line=${encodeURIComponent(line)}&station=${encodeURIComponent(station)}`,
);

export async function loadMtrDataset() {
  return loadMtrDatasetInternal();
}

export async function getMtrETA(line, station) {
  return loadMtrEtaInternal({ line, station });
}

export async function getMtrSummary() {
  return buildOperatorSummary(await loadMtrDataset());
}

export const mtrAdapter = {
  operator: 'MTR',
  loadDataset: loadMtrDataset,
  getETA: getMtrETA,
  getSummary: getMtrSummary,
};
