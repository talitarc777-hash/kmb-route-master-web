import assert from 'node:assert/strict';
import test from 'node:test';

import { onRequestGet as onKmbRequestGet } from '../functions/api/kmb/[[path]].js';
import {
  alertExplicitlyNamesRoute,
  applyServiceAlertsToRoutes,
  parseTdServiceAlerts,
  rankRoutesByDisruption,
} from '../src/utils/serviceAlerts.js';

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<list>
  <message>
    <INCIDENT_NUMBER>IN-DIVERSION</INCIDENT_NUMBER>
    <INCIDENT_HEADING_EN>Public Transport Arrangement</INCIDENT_HEADING_EN>
    <INCIDENT_HEADING_CN>公共交通安排</INCIDENT_HEADING_CN>
    <INCIDENT_DETAIL_EN>Temporary route diversion</INCIDENT_DETAIL_EN>
    <INCIDENT_DETAIL_CN>臨時改道</INCIDENT_DETAIL_CN>
    <ANNOUNCEMENT_DATE>2026-07-28T10:00:00</ANNOUNCEMENT_DATE>
    <INCIDENT_STATUS_EN>UPDATED</INCIDENT_STATUS_EN>
    <INCIDENT_STATUS_CN>更新情況</INCIDENT_STATUS_CN>
    <CONTENT_EN>KMB routes 606 and 606A are temporarily diverted near Kwun Tong.</CONTENT_EN>
    <CONTENT_CN>九巴路線606及606A於觀塘臨時改道。</CONTENT_CN>
  </message>
  <message>
    <INCIDENT_NUMBER>IN-SUSPENDED</INCIDENT_NUMBER>
    <INCIDENT_HEADING_EN>Service Suspension</INCIDENT_HEADING_EN>
    <INCIDENT_HEADING_CN>暫停服務</INCIDENT_HEADING_CN>
    <INCIDENT_DETAIL_EN>Bus service suspended</INCIDENT_DETAIL_EN>
    <INCIDENT_DETAIL_CN>巴士暫停服務</INCIDENT_DETAIL_CN>
    <INCIDENT_STATUS_EN>NEW</INCIDENT_STATUS_EN>
    <INCIDENT_STATUS_CN>最新情況</INCIDENT_STATUS_CN>
    <CONTENT_EN>KMB route 671 service is suspended until further notice.</CONTENT_EN>
    <CONTENT_CN>九巴路線671暫停服務，直至另行通知。</CONTENT_CN>
  </message>
  <message>
    <INCIDENT_NUMBER>IN-CLOSED</INCIDENT_NUMBER>
    <INCIDENT_STATUS_EN>CLOSED</INCIDENT_STATUS_EN>
    <INCIDENT_STATUS_CN>完結</INCIDENT_STATUS_CN>
    <CONTENT_EN>KMB route 269C was suspended.</CONTENT_EN>
    <CONTENT_CN>九巴路線269C曾暫停服務。</CONTENT_CN>
  </message>
</list>`;

test('parses active TD alerts and ignores incidents marked closed', () => {
  const alerts = parseTdServiceAlerts(SAMPLE_XML);

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].severity, 'diversion');
  assert.equal(alerts[0].penaltyMinutes, 20);
  assert.equal(alerts[1].severity, 'suspended');
});

test('route matching requires an explicit route reference and respects number boundaries', () => {
  const [diversion] = parseTdServiceAlerts(SAMPLE_XML);

  assert.equal(alertExplicitlyNamesRoute(diversion, '606'), true);
  assert.equal(alertExplicitlyNamesRoute(diversion, '606A'), true);
  assert.equal(alertExplicitlyNamesRoute(diversion, '6'), false);
  assert.equal(alertExplicitlyNamesRoute({ contentEn: 'Traffic is busy in Kwun Tong.' }, '606'), false);
});

test('suppresses suspended services and penalizes but retains diverted routes', () => {
  const alerts = parseTdServiceAlerts(SAMPLE_XML);
  const result = applyServiceAlertsToRoutes([
    { id: 'diverted', estimatedTime: 45, segments: [{ route: '606' }] },
    { id: 'suspended', estimatedTime: 40, segments: [{ route: '671' }] },
    { id: 'boundary', estimatedTime: 30, segments: [{ route: '6' }] },
    { id: 'closed-alert', estimatedTime: 50, segments: [{ route: '269C' }] },
  ], alerts);

  assert.deepEqual(result.routes.map((route) => route.id), ['diverted', 'boundary', 'closed-alert']);
  assert.equal(result.routes[0].serviceAlertSeverity, 'diversion');
  assert.equal(result.routes[0].disruptionPenaltyMinutes, 20);
  assert.equal(result.routes[1].serviceAlerts.length, 0);
  assert.deepEqual(result.suppressedRoutes.map((route) => route.id), ['suspended']);
});

test('uses the disruption wording nearest the named route in a mixed notice', () => {
  const mixedAlert = {
    id: 'mixed',
    statusEn: 'UPDATED',
    contentEn: 'KMB route 606 is diverted via Kwun Tong Road. Tram service is suspended in Central.',
  };
  const result = applyServiceAlertsToRoutes([
    { id: '606-option', estimatedTime: 40, segments: [{ route: '606' }] },
  ], [mixedAlert]);

  assert.equal(result.suppressedRoutes.length, 0);
  assert.equal(result.routes[0].serviceAlertSeverity, 'diversion');
  assert.equal(result.routes[0].disruptionPenaltyMinutes, 20);
});

test('ranking uses disruption penalties without changing displayed journey minutes', () => {
  const diverted = { id: 'diverted', estimatedTime: 30, disruptionPenaltyMinutes: 20 };
  const normal = { id: 'normal', estimatedTime: 40, disruptionPenaltyMinutes: 0 };
  const ranked = rankRoutesByDisruption([diverted, normal], (route) => route.estimatedTime);

  assert.deepEqual(ranked.map((route) => route.id), ['normal', 'diverted']);
  assert.equal(diverted.estimatedTime, 30);
});

test('KMB proxy serves the official XML alert feed with a short shared cache', async () => {
  const originalFetch = globalThis.fetch;
  let forwardedUrl = '';
  globalThis.fetch = async (url) => {
    forwardedUrl = String(url);
    return new Response(SAMPLE_XML, {
      status: 200,
      headers: { 'Content-Type': 'application/xml' },
    });
  };

  try {
    const response = await onKmbRequestGet({
      request: new Request('https://example.test/api/kmb/service-alerts'),
      params: { path: ['service-alerts'] },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/xml/);
    assert.match(response.headers.get('cache-control'), /s-maxage=60/);
    assert.equal(forwardedUrl, 'https://www.td.gov.hk/en/special_news/trafficnews.xml');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
