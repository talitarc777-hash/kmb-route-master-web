const jsonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

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
      predictions: [],
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

  const incomingUrl = new URL(request.url);
  incomingUrl.searchParams.set('key', apiKey);
  const targetUrl = `https://maps.googleapis.com/maps/api/${subpath}?${incomingUrl.searchParams.toString()}`;

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
        predictions: [],
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
      predictions: [],
      results: [],
    }, 502);
  }
}
