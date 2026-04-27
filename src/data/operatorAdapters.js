import { citybusAdapter } from './citybusAdapter';
import { tramAdapter } from './tramAdapter';
import { mtrAdapter } from './mtrAdapter';

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
