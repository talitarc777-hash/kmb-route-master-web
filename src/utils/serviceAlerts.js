const DISRUPTION_PENALTY_MINUTES = {
  info: 0,
  delay: 10,
  diversion: 20,
  suspended: Infinity,
};

const SEVERITY_ORDER = {
  info: 0,
  delay: 1,
  diversion: 2,
  suspended: 3,
};

const SEVERITY_PATTERNS = {
  suspended: /\b(?:service\s+)?suspend(?:ed|sion)?\b|停止服務|暫停服務|停駛|停運/i,
  diversion: /\bdivert(?:ed|ion)?\b|\btruncat(?:ed|ion)?\b|temporary bus stop|stop (?:is )?(?:relocated|closed|skipped)|改道|繞道|截短|不停站|巴士站.{0,12}(?:遷移|暫停使用|取消)|站位改動/i,
  delay: /\bdelay(?:ed|s)?\b|longer journey|journey time.{0,20}longer|traffic is busy|交通繁忙|延誤|行車時間.{0,12}延長|行程時間.{0,12}延長/i,
};

function decodeXmlEntities(value) {
  return String(value || '').replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, token) => {
      const normalized = token.toLowerCase();
      if (normalized === 'amp') return '&';
      if (normalized === 'lt') return '<';
      if (normalized === 'gt') return '>';
      if (normalized === 'quot') return '"';
      if (normalized === 'apos') return "'";
      const codePoint = normalized.startsWith('#x')
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    },
  );
}

function cleanXmlText(value) {
  return decodeXmlEntities(
    String(value || '')
      .replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tagValue(block, tagName) {
  const match = String(block || '').match(
    new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i'),
  );
  return cleanXmlText(match?.[1] || '');
}

function severityFromText(value) {
  const text = String(value || '').toLowerCase();
  if (SEVERITY_PATTERNS.suspended.test(text)) return 'suspended';
  if (SEVERITY_PATTERNS.diversion.test(text)) return 'diversion';
  if (SEVERITY_PATTERNS.delay.test(text)) return 'delay';
  return 'info';
}

function severityNearestRouteMention(context) {
  let nearest = null;
  for (const [severity, pattern] of Object.entries(SEVERITY_PATTERNS)) {
    const matcher = new RegExp(pattern.source, 'gi');
    let match = matcher.exec(context.text);
    while (match) {
      const distance = Math.abs(match.index - context.codeIndex);
      if (distance <= 160 && (
        !nearest ||
        distance < nearest.distance ||
        (distance === nearest.distance && SEVERITY_ORDER[severity] > SEVERITY_ORDER[nearest.severity])
      )) {
        nearest = { severity, distance };
      }
      match = matcher.exec(context.text);
    }
  }
  return nearest?.severity || 'info';
}

function disruptionSeverity(alert) {
  return severityFromText([
    alert.headingEn,
    alert.headingTc,
    alert.detailEn,
    alert.detailTc,
    alert.contentEn,
    alert.contentTc,
  ].join(' '));
}

export function parseTdServiceAlerts(xmlText) {
  const messages = String(xmlText || '').match(/<message\b[^>]*>[\s\S]*?<\/message>/gi) || [];
  return messages.map((block, index) => {
    const statusEn = tagValue(block, 'INCIDENT_STATUS_EN').toUpperCase();
    const statusTc = tagValue(block, 'INCIDENT_STATUS_CN');
    const latText = tagValue(block, 'LATITUDE');
    const lngText = tagValue(block, 'LONGITUDE');
    const alert = {
      id: tagValue(block, 'INCIDENT_NUMBER') || tagValue(block, 'ID') || `traffic-${index}`,
      statusEn,
      statusTc,
      headingEn: tagValue(block, 'INCIDENT_HEADING_EN'),
      headingTc: tagValue(block, 'INCIDENT_HEADING_CN'),
      detailEn: tagValue(block, 'INCIDENT_DETAIL_EN'),
      detailTc: tagValue(block, 'INCIDENT_DETAIL_CN'),
      contentEn: tagValue(block, 'CONTENT_EN'),
      contentTc: tagValue(block, 'CONTENT_CN'),
      locationEn: tagValue(block, 'LOCATION_EN'),
      locationTc: tagValue(block, 'LOCATION_CN'),
      announcedAt: tagValue(block, 'ANNOUNCEMENT_DATE'),
      lat: latText ? Number(latText) : null,
      lng: lngText ? Number(lngText) : null,
    };
    alert.severity = disruptionSeverity(alert);
    alert.penaltyMinutes = DISRUPTION_PENALTY_MINUTES[alert.severity];
    return alert;
  }).filter((alert) => alert.statusEn !== 'CLOSED' && alert.statusTc !== '完結');
}

function routeCodesFromOption(route) {
  const segmentCodes = (route?.segments || [])
    .map((segment) => String(segment?.route || '').trim().toUpperCase())
    .filter(Boolean);
  const legCodes = (route?.legs || [])
    .filter((leg) => /KMB|LWB/i.test(String(leg?.operator || '')))
    .map((leg) => String(leg?.route || leg?.line || '').trim().toUpperCase())
    .filter(Boolean);
  return [...new Set([...segmentCodes, ...legCodes])];
}

function alertSearchText(alert) {
  return [
    alert?.headingEn,
    alert?.headingTc,
    alert?.detailEn,
    alert?.detailTc,
    alert?.contentEn,
    alert?.contentTc,
  ].filter(Boolean).join(' ').toUpperCase();
}

function routeMentionContexts(alert, routeCode) {
  const code = String(routeCode || '').trim().toUpperCase();
  if (!code) return [];
  const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = alertSearchText(alert);
  const codePattern = new RegExp(`(^|[^A-Z0-9])${escapedCode}(?![A-Z0-9])`, 'g');
  const contexts = [];
  let match = codePattern.exec(text);
  while (match) {
    const codeIndex = match.index + match[1].length;
    const start = Math.max(0, codeIndex - 120);
    contexts.push({
      text: text.slice(start, codeIndex + code.length + 180),
      codeIndex: codeIndex - start,
    });
    match = codePattern.exec(text);
  }
  return contexts;
}

export function alertExplicitlyNamesRoute(alert, routeCode) {
  const code = String(routeCode || '').trim().toUpperCase();
  if (!code) return false;
  const escapedCode = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = alertSearchText(alert);
  const directPatterns = [
    new RegExp(`\\b(?:KMB\\s+)?(?:BUS\\s+)?ROUTES?\\s+(?:NO\\.?\\s*)?${escapedCode}(?![A-Z0-9])`, 'i'),
    new RegExp(`(^|[^A-Z0-9])${escapedCode}\\s*(?:號)?(?:巴士)?路線`, 'i'),
  ];
  if (directPatterns.some((pattern) => pattern.test(text))) return true;

  const codePattern = new RegExp(`(^|[^A-Z0-9])${escapedCode}(?![A-Z0-9])`, 'g');
  let match = codePattern.exec(text);
  while (match) {
    const codeIndex = match.index + match[1].length;
    const context = text.slice(Math.max(0, codeIndex - 80), codeIndex + code.length + 80);
    if (/\b(?:KMB|BUS)\b|九巴|巴士/.test(context) && /\bROUTES?\b|路線|號線/.test(context)) {
      return true;
    }
    match = codePattern.exec(text);
  }
  return false;
}

export function applyServiceAlertsToRoutes(routes, alerts) {
  const activeAlerts = Array.isArray(alerts) ? alerts : [];
  const keptRoutes = [];
  const suppressedRoutes = [];

  for (const route of routes || []) {
    const matches = [];
    for (const routeCode of routeCodesFromOption(route)) {
      for (const alert of activeAlerts) {
        if (!alertExplicitlyNamesRoute(alert, routeCode)) continue;
        if (matches.some((match) => match.id === alert.id && match.routeCode === routeCode)) continue;
        const routeSeverity = routeMentionContexts(alert, routeCode).reduce(
          (highest, context) => {
            const severity = severityNearestRouteMention(context);
            return SEVERITY_ORDER[severity] > SEVERITY_ORDER[highest] ? severity : highest;
          },
          'info',
        );
        matches.push({
          ...alert,
          routeCode,
          severity: routeSeverity,
          penaltyMinutes: DISRUPTION_PENALTY_MINUTES[routeSeverity],
        });
      }
    }

    const severity = matches.reduce(
      (highest, alert) => SEVERITY_ORDER[alert.severity] > SEVERITY_ORDER[highest]
        ? alert.severity
        : highest,
      'info',
    );
    const annotated = {
      ...route,
      serviceAlerts: matches,
      serviceAlertSeverity: matches.length > 0 ? severity : null,
      disruptionPenaltyMinutes: matches.length > 0
        ? DISRUPTION_PENALTY_MINUTES[severity]
        : 0,
    };

    if (severity === 'suspended' && matches.length > 0) suppressedRoutes.push(annotated);
    else keptRoutes.push(annotated);
  }

  return { routes: keptRoutes, suppressedRoutes };
}

export function rankRoutesByDisruption(routes, getBaseMinutes) {
  const indexedRoutes = (routes || []).map((route, index) => ({ route, index }));
  return indexedRoutes.sort((left, right) => {
    const penaltyLeft = Number(left.route?.disruptionPenaltyMinutes) || 0;
    const penaltyRight = Number(right.route?.disruptionPenaltyMinutes) || 0;
    if (penaltyLeft > 0 || penaltyRight > 0) {
      const baseLeft = Number(getBaseMinutes?.(left.route));
      const baseRight = Number(getBaseMinutes?.(right.route));
      const adjustedLeft = (Number.isFinite(baseLeft) ? baseLeft : 9999) + penaltyLeft;
      const adjustedRight = (Number.isFinite(baseRight) ? baseRight : 9999) + penaltyRight;
      if (adjustedLeft !== adjustedRight) return adjustedLeft - adjustedRight;
    }
    return left.index - right.index;
  }).map(({ route }) => route);
}

export function serviceAlertLabel(alert) {
  if (!alert) return '';
  const routePrefix = alert.routeCode ? `Route ${alert.routeCode}: ` : '';
  const message = alert.contentTc || alert.contentEn || alert.headingTc || alert.headingEn || 'Service alert';
  return `${routePrefix}${message}`;
}
