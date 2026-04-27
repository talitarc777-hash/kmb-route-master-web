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
  const [citybus, tram, mtr] = await Promise.all([
    citybusAdapter.loadDataset(),
    tramAdapter.loadDataset(),
    mtrAdapter.loadDataset(),
  ]);

  return {
    citybus,
    tram,
    mtr,
  };
}
