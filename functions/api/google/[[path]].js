const jsonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};
const ALLOWED_GOOGLE_PATHS = new Set([
  'geocode/json',
  'directions/json',
  'place/autocomplete/json',
]);
const ALLOWED_DIRECTIONS_MODES = new Set(['walking', 'driving', 'transit']);
const HK_BOUNDS = { minLat: 21.8, maxLat: 22.7, minLng: 113.7, maxLng: 114.6 };

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders,
  });
}

function subpathFromParams(params) {
  const raw = Array.isArray(params.path) ? params.path.join('/') : params.path || '';
  return raw.replace(/^\/+|\/+$/g, '');
}

function normalizeHkCoordinate(value) {
  const [latText, lngText, ...extra] = String(value || '').split(',');
  const lat = Number(latText);
  const lng = Number(lngText);
  if (extra.length > 0 || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < HK_BOUNDS.minLat || lat > HK_BOUNDS.maxLat ||
      lng < HK_BOUNDS.minLng || lng > HK_BOUNDS.maxLng) return null;
  return `${lat},${lng}`;
}

function buildGoogleQuery(subpath, incomingParams, apiKey) {
  const query = new URLSearchParams({ key: apiKey });
  if (subpath === 'place/autocomplete/json') {
    const input = String(incomingParams.get('input') || '').trim();
    if (input.length < 3 || input.length > 200) return null;
    query.set('input', input);
    query.set('components', 'country:hk');
    query.set('language', 'zh-TW');
    query.set('location', '22.3193,114.1694');
    query.set('radius', '50000');
    return query;
  }
  if (subpath === 'geocode/json') {
    const placeId = String(incomingParams.get('place_id') || '').trim();
    if (placeId) {
      if (!/^[A-Za-z0-9_-]{5,300}$/.test(placeId)) return null;
      query.set('place_id', placeId);
      return query;
    }
    const address = String(incomingParams.get('address') || '').trim();
    if (!address || address.length > 200) return null;
    query.set('address', address);
    query.set('components', 'country:hk');
    return query;
  }

  const origin = normalizeHkCoordinate(incomingParams.get('origin'));
  const destination = normalizeHkCoordinate(incomingParams.get('destination'));
  const mode = String(incomingParams.get('mode') || '').toLowerCase();
  if (!origin || !destination || !ALLOWED_DIRECTIONS_MODES.has(mode)) return null;
  query.set('origin', origin);
  query.set('destination', destination);
  query.set('mode', mode);

  const waypointsText = incomingParams.get('waypoints');
  if (waypointsText) {
    const waypoints = waypointsText.split('|').map(normalizeHkCoordinate);
    if (waypoints.length > 23 || waypoints.some((point) => !point)) return null;
    query.set('waypoints', waypoints.join('|'));
  }
  if (mode === 'transit') query.set('transit_mode', 'bus');
  if (incomingParams.get('alternatives') === 'true') query.set('alternatives', 'true');

  for (const timeKey of ['departure_time', 'arrival_time']) {
    const value = incomingParams.get(timeKey);
    if (value && /^\d{9,12}$/.test(value)) query.set(timeKey, value);
  }
  return query;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: jsonHeaders,
  });
}

export async function onRequestGet({ request, params, env }) {
  const apiKey = env.GCP_API_KEY || '';
  if (!apiKey) {
    return jsonResponse({
      status: 'CONFIGURATION_ERROR',
      error_message: 'GCP_API_KEY is not configured in Cloudflare Pages environment variables.',
      routes: [],
      results: [],
    }, 503);
  }

  const subpath = subpathFromParams(params);
  if (!subpath) {
    return jsonResponse({
      status: 'NOT_FOUND',
      error_message: 'Missing Google Maps API path.',
    }, 404);
  }
  if (!ALLOWED_GOOGLE_PATHS.has(subpath)) {
    return jsonResponse({
      status: 'NOT_FOUND',
      error_message: 'Unsupported Google Maps API path.',
    }, 404);
  }

  const incomingUrl = new URL(request.url);
  const googleQuery = buildGoogleQuery(subpath, incomingUrl.searchParams, apiKey);
  if (!googleQuery) {
    return jsonResponse({
      status: 'INVALID_REQUEST',
      error_message: 'The Google request is outside the supported Hong Kong route-planning shape.',
    }, 400);
  }
  const targetUrl = `https://maps.googleapis.com/maps/api/${subpath}?${googleQuery.toString()}`;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Accept: 'application/json',
        Referer: incomingUrl.origin,
      },
    });

    const text = await upstream.text();
    try {
      JSON.parse(text);
    } catch {
      return jsonResponse({
        status: 'UPSTREAM_ERROR',
        error_message: 'Google upstream returned non-JSON content.',
        routes: [],
        results: [],
      }, 502);
    }

    return new Response(text, {
      status: upstream.ok ? 200 : upstream.status,
      headers: jsonHeaders,
    });
  } catch (error) {
    return jsonResponse({
      status: 'UPSTREAM_ERROR',
      error_message: error?.message || String(error),
      routes: [],
      results: [],
    }, 502);
  }
}
