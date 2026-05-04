import { buildOperatorSummary, createStaticDatasetLoader } from './operatorCommon.js';

const loadLrtDatasetInternal = createStaticDatasetLoader('lrt', '/api/operators/lrt/dataset?compact=1');

export async function loadLrtDataset() {
  return loadLrtDatasetInternal();
}

export async function getLrtSummary() {
  return buildOperatorSummary(await loadLrtDataset());
}

export const lrtAdapter = {
  operator: 'MTR',
  loadDataset: loadLrtDataset,
  getSummary: getLrtSummary,
};
