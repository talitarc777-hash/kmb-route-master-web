import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet } from '../functions/api/google/[[path]].js';

test('Google proxy rejects API paths that the app does not use', async () => {
  const response = await onRequestGet({
    request: new Request('https://example.test/api/google/place/autocomplete/json?input=test'),
    params: { path: ['place', 'autocomplete', 'json'] },
    env: { GCP_API_KEY: 'server-secret' },
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).status, 'NOT_FOUND');
});

test('Google proxy forwards an allowed Directions request with the server key', async () => {
  const originalFetch = globalThis.fetch;
  let forwardedUrl = '';
  globalThis.fetch = async (url) => {
    forwardedUrl = String(url);
    return new Response(JSON.stringify({ status: 'OK', routes: [] }), { status: 200 });
  };

  try {
    const response = await onRequestGet({
      request: new Request(
        'https://example.test/api/google/directions/json?' +
          'origin=22.2819,114.1589&destination=22.2866,114.1937&mode=walking&key=browser-key',
      ),
      params: { path: ['directions', 'json'] },
      env: { GCP_API_KEY: 'server-secret' },
    });

    assert.equal(response.status, 200);
    assert.match(forwardedUrl, /maps\.googleapis\.com\/maps\/api\/directions\/json/);
    assert.match(forwardedUrl, /key=server-secret/);
    assert.doesNotMatch(forwardedUrl, /browser-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Google proxy rejects Directions coordinates outside Hong Kong', async () => {
  const response = await onRequestGet({
    request: new Request(
      'https://example.test/api/google/directions/json?' +
        'origin=51.5072,-0.1276&destination=48.8566,2.3522&mode=driving',
    ),
    params: { path: ['directions', 'json'] },
    env: { GCP_API_KEY: 'server-secret' },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).status, 'INVALID_REQUEST');
});
