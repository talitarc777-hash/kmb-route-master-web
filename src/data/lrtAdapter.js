import { buildOperatorSummary, createStaticDatasetLoader } from './operatorCommon.js';

const loadLrtDatasetInternal = createStaticDatasetLoader('lrt', '/operator-data/lrt.compact.json');

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
