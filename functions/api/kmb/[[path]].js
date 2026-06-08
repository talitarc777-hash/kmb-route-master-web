const KMB_ENDPOINTS = {
  stop: 'https://data.etabus.gov.hk/v1/transport/kmb/stop',
  route: 'https://data.etabus.gov.hk/v1/transport/kmb/route',
  'route-stop': 'https://data.etabus.gov.hk/v1/transport/kmb/route-stop',
};
const CSDI_BUS_ROUTE_QUERY_URL =
  'https://portal.csdi.gov.hk/server/rest/services/common/' +
  'td_rcd_1638844988873_41214/FeatureServer/0/query';

const baseJsonHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Content-Type': 'application/json; charset=utf-8',
};

function responseHeaders(cacheControl = 'public, max-age=60') {
  return {
    ...baseJsonHeaders,
    'Cache-Control': cacheControl,
  };
}

function jsonResponse(payload, status = 200, cacheControl) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders(cacheControl),
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
    headers: responseHeaders(),
  });
}

export async function onRequestGet({ request, params }) {
  const routeName = routeNameFromParams(params);
  let upstreamUrl = KMB_ENDPOINTS[routeName];
  let cacheControl = 'public, max-age=60';

  if (routeName === 'route-geometry') {
    const incomingUrl = new URL(request.url);
    const route = (incomingUrl.searchParams.get('route') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(route)) {
      return jsonResponse({
        status: 'INVALID_REQUEST',
        error_message: 'A valid KMB route number is required.',
        features: [],
      }, 400, 'no-store');
    }

    const query = new URLSearchParams({
      f: 'geojson',
      where: `ROUTE_NAMEE='${route}'`,
      outFields: [
        'ROUTE_ID',
        'ROUTE_SEQ',
        'COMPANY_CODE',
        'ROUTE_NAMEE',
        'ST_STOP_ID',
        'ED_STOP_ID',
        'ST_STOP_NAMEE',
        'ED_STOP_NAMEE',
      ].join(','),
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'ROUTE_ID,ROUTE_SEQ',
    });
    upstreamUrl = `${CSDI_BUS_ROUTE_QUERY_URL}?${query.toString()}`;
    cacheControl = 'public, max-age=86400, s-maxage=604800';
  }

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
        cacheTtl: routeName === 'route-geometry' ? 604800 : 60,
        cacheEverything: true,
      },
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return jsonResponse({
        status: 'UPSTREAM_ERROR',
        error_message: `Route-data upstream returned HTTP ${upstream.status}`,
      }, 502);
    }

    try {
      JSON.parse(text);
    } catch {
      return jsonResponse({
        status: 'UPSTREAM_ERROR',
        error_message: 'Route-data upstream returned non-JSON content.',
      }, 502);
    }

    return new Response(text, {
      status: 200,
      headers: responseHeaders(cacheControl),
    });
  } catch (error) {
    return jsonResponse({
      status: 'UPSTREAM_ERROR',
      error_message: error?.message || String(error),
    }, 502);
  }
}
