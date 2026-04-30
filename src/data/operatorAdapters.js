import { citybusAdapter } from './citybusAdapter.js';
import { tramAdapter } from './tramAdapter.js';
import { mtrAdapter } from './mtrAdapter.js';
import { mtrBusAdapter } from './mtrBusAdapter.js';
import { lrtAdapter } from './lrtAdapter.js';

export { citybusAdapter, tramAdapter, mtrAdapter, mtrBusAdapter, lrtAdapter };

export const operatorAdapters = {
  citybus: citybusAdapter,
  tram: tramAdapter,
  mtr: mtrAdapter,
  mtr_bus: mtrBusAdapter,
  lrt: lrtAdapter,
};

const OPERATOR_LABELS = {
  citybus: 'CTB',
  tram: 'TRAM',
  mtr: 'MTR',
  mtr_bus: 'MTR_BUS',
  lrt: 'LRT',
};

function emptyDataset(operator, reason) {
  return {
    operator,
    routes: [],
    stops: [],
    route_stops: [],
    fares: [],
    error: reason,
  };
}

export async function loadExternalOperatorDatasets(operatorModes) {
  const requestedModes = new Set(operatorModes || Object.keys(operatorAdapters));
  requestedModes.delete('kmb');
  const loadJobs = Object.entries(operatorAdapters)
    .filter(([mode]) => requestedModes.has(mode))
    .map(async ([mode, adapter]) => {
      const result = await adapter.loadDataset();
      return [mode, result];
    });
  const entries = await Promise.allSettled(loadJobs);
  const datasets = {};

  for (const [mode, label] of Object.entries(OPERATOR_LABELS)) {
    datasets[mode] = requestedModes.has(mode)
      ? emptyDataset(label, 'Dataset was requested but did not finish loading.')
      : emptyDataset(label, 'Dataset was not requested for this search.');
  }

  for (const entry of entries) {
    if (entry.status === 'fulfilled') {
      const [mode, dataset] = entry.value;
      datasets[mode] = dataset;
      continue;
    }

    console.warn('Operator dataset could not be loaded for alternatives:', entry.reason);
  }

  return datasets;
}
