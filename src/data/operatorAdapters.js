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

export async function loadExternalOperatorDatasets() {
  const entries = await Promise.allSettled([
    citybusAdapter.loadDataset(),
    tramAdapter.loadDataset(),
    mtrAdapter.loadDataset(),
    mtrBusAdapter.loadDataset(),
    lrtAdapter.loadDataset(),
  ]);
  const [citybusResult, tramResult, mtrResult, mtrBusResult, lrtResult] = entries;

  const getDataset = (result, operator) => {
    if (result.status === 'fulfilled') return result.value;
    console.warn(`${operator} dataset could not be loaded for alternatives:`, result.reason);
    return {
      operator,
      routes: [],
      stops: [],
      route_stops: [],
      fares: [],
      error: result.reason?.message || String(result.reason || 'Dataset unavailable'),
    };
  };

  return {
    citybus: getDataset(citybusResult, 'CTB'),
    tram: getDataset(tramResult, 'TRAM'),
    mtr: getDataset(mtrResult, 'MTR'),
    mtr_bus: getDataset(mtrBusResult, 'MTR_BUS'),
    lrt: getDataset(lrtResult, 'LRT'),
  };
}
