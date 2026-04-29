import { citybusAdapter } from './citybusAdapter.js';
import { tramAdapter } from './tramAdapter.js';
import { mtrAdapter } from './mtrAdapter.js';

export { citybusAdapter, tramAdapter, mtrAdapter };

export const operatorAdapters = {
  citybus: citybusAdapter,
  tram: tramAdapter,
  mtr: mtrAdapter,
};

export async function loadExternalOperatorDatasets() {
  const entries = await Promise.allSettled([
    citybusAdapter.loadDataset(),
    tramAdapter.loadDataset(),
    mtrAdapter.loadDataset(),
  ]);
  const [citybusResult, tramResult, mtrResult] = entries;

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
  };
}
