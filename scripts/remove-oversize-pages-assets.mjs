import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oversizedAssets = [
  path.join(rootDir, 'dist', 'operator-data', 'kmb_operation_time_slots.json'),
];

for (const assetPath of oversizedAssets) {
  try {
    await rm(assetPath, { force: true });
    console.log(`Removed oversized Pages asset: ${path.relative(rootDir, assetPath)}`);
  } catch (error) {
    console.warn(`Could not remove ${path.relative(rootDir, assetPath)}: ${error.message}`);
  }
}
