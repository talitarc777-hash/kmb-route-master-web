const KMB_ENDPOINTS = {
  stop: 'https://data.etabus.gov.hk/v1/transport/kmb/stop',
  route: 'https://data.etabus.gov.hk/v1/transport/kmb/route',
  'route-stop': 'https://data.etabus.gov.hk/v1/transport/kmb/route-stop',
};

const jsonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=60',
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: jsonHeaders,
  });
}

function routeNameFromParams(params) {
  const raw = Array.isArray(params.path) ? params.path.join('/') : params.path || '';
  const routeName = raw.replace(/^\/+|\/+$/g, '');
  return routeName || null;
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: jsonHeaders,
  });
}

export async function onRequestGet({ params }) {
  const routeName = routeNameFromParams(params);
  const upstreamUrl = KMB_ENDPOINTS[routeName];

  if (!upstreamUrl) {
    return jsonResponse({
      status: 'NOT_FOUND',
      error_message: `Unsupported KMB endpoint: ${routeName || '(empty)'}`,
    }, 404);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: 'application/json',
      },
      cf: {
        cacheTtl: 60,
        cacheEverything: true,
      },
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return jsonResponse({
        status: 'UPSTREAM_ERROR',
        error_message: `KMB upstream returned HTTP ${upstream.status}`,
      }, 502);
    }

    try {
      JSON.parse(text);
    } catch {
      return jsonResponse({
        status: 'UPSTREAM_ERROR',
        error_message: 'KMB upstream returned non-JSON content.',
      }, 502);
    }

    return new Response(text, {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
    return jsonResponse({
      status: 'UPSTREAM_ERROR',
      error_message: error?.message || String(error),
    }, 502);
  }
}
