import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadDotEnv() {
  try {
    const text = await readFile(path.join(rootDir, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, name, rawValue] = match;
      if (process.env[name]) continue;
      process.env[name] = rawValue.replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    // .env is optional. Cloudflare Pages provides this value through its env.
  }
}

async function checkEndpoint(label, pathName, searchParams) {
  const params = new URLSearchParams(searchParams);
  params.set('key', process.env.GCP_API_KEY);
  const url = `https://maps.googleapis.com/maps/api/${pathName}?${params.toString()}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => null);
  const status = data?.status || `HTTP_${response.status}`;
  const message = data?.error_message ? ` - ${data.error_message}` : '';
  console.log(`${label}: ${status}${message}`);
  return status === 'OK' || status === 'ZERO_RESULTS';
}

await loadDotEnv();

if (!process.env.GCP_API_KEY || process.env.GCP_API_KEY === 'your_gcp_api_key_here') {
  console.error('GCP_API_KEY is missing. Add it to .env locally, or set it in Cloudflare Pages environment variables.');
  process.exit(1);
}

const autocompleteOk = await checkEndpoint('Places autocomplete', 'place/autocomplete/json', {
  input: 'central',
  components: 'country:hk',
});

const geocodeOk = await checkEndpoint('Geocoding', 'geocode/json', {
  address: 'central',
  components: 'country:hk',
});

if (!autocompleteOk || !geocodeOk) {
  console.error('GCP_API_KEY test failed. Check that Places API and Geocoding API are enabled, billing is active, and key restrictions allow server-side web service calls.');
  process.exit(1);
}

console.log('GCP_API_KEY looks usable for autocomplete and geocoding.');
