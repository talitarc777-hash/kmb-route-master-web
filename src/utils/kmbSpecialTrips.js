const DEFAULT_OPERATOR = 'KMB';
const DEFAULT_DISPLAY_STOP_LIMIT = 2;

function normalizedValue(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizedServiceType(value) {
  return String(value ?? '').trim();
}

function normalizedStopIds(stopIds) {
  return (Array.isArray(stopIds) ? stopIds : [])
    .map((stopId) => String(stopId ?? '').trim())
    .filter(Boolean);
}

function serviceTypeSort(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function routeDirection(candidate) {
  return normalizedValue(candidate?.direction || candidate?.dir || candidate?.bound);
}

export function createKmbRouteVariantKey(candidate) {
  const route = normalizedValue(candidate?.route);
  const direction = routeDirection(candidate);
  const serviceType = normalizedServiceType(
    candidate?.serviceType ?? candidate?.service_type,
  );
  if (!route || !direction || !serviceType) return null;
  return `${route}|${direction}|${serviceType}`;
}

function stopDisplay(stopId, stopMap = {}) {
  const stop = stopMap?.[stopId] || {};
  return {
    id: stopId,
    nameEn: String(stop.name_en || stop.name?.en || '').trim(),
    nameTc: String(stop.name_tc || stop.name?.tc || '').trim(),
    nameSc: String(stop.name_sc || stop.name?.sc || '').trim(),
  };
}

export function diffKmbStopSequences(baselineStopIds, variantStopIds) {
  const baseline = normalizedStopIds(baselineStopIds);
  const variant = normalizedStopIds(variantStopIds);
  if (baseline.length === 0 || variant.length === 0) return null;

  const matrix = Array.from(
    { length: baseline.length + 1 },
    () => new Uint16Array(variant.length + 1),
  );
  for (let baselineIndex = baseline.length - 1; baselineIndex >= 0; baselineIndex -= 1) {
    for (let variantIndex = variant.length - 1; variantIndex >= 0; variantIndex -= 1) {
      matrix[baselineIndex][variantIndex] = baseline[baselineIndex] === variant[variantIndex]
        ? matrix[baselineIndex + 1][variantIndex + 1] + 1
        : Math.max(
            matrix[baselineIndex + 1][variantIndex],
            matrix[baselineIndex][variantIndex + 1],
          );
    }
  }

  const addedStopIds = [];
  const skippedStopIds = [];
  let baselineIndex = 0;
  let variantIndex = 0;
  while (baselineIndex < baseline.length && variantIndex < variant.length) {
    if (baseline[baselineIndex] === variant[variantIndex]) {
      baselineIndex += 1;
      variantIndex += 1;
    } else if (
      matrix[baselineIndex + 1][variantIndex]
      >= matrix[baselineIndex][variantIndex + 1]
    ) {
      skippedStopIds.push(baseline[baselineIndex]);
      baselineIndex += 1;
    } else {
      addedStopIds.push(variant[variantIndex]);
      variantIndex += 1;
    }
  }
  skippedStopIds.push(...baseline.slice(baselineIndex));
  addedStopIds.push(...variant.slice(variantIndex));

  return {
    addedStopIds,
    skippedStopIds,
    sequenceChanged: addedStopIds.length > 0 || skippedStopIds.length > 0,
  };
}

export function analyseKmbRouteVariant({
  route,
  direction,
  serviceType,
  baselineServiceType,
  baselineStopIds,
  variantStopIds,
  stopMap = {},
  baseSelection = 'provided',
} = {}) {
  const normalizedRoute = normalizedValue(route);
  const normalizedDirection = normalizedValue(direction);
  const normalizedVariantServiceType = normalizedServiceType(serviceType);
  const normalizedBaselineServiceType = normalizedServiceType(baselineServiceType);
  const difference = diffKmbStopSequences(baselineStopIds, variantStopIds);
  if (
    !normalizedRoute
    || !normalizedDirection
    || !normalizedVariantServiceType
    || !normalizedBaselineServiceType
    || !difference
  ) {
    return null;
  }

  return {
    isSpecialTrip: difference.sequenceChanged,
    route: normalizedRoute,
    direction: normalizedDirection,
    serviceType: normalizedVariantServiceType,
    baselineServiceType: normalizedBaselineServiceType,
    baseSelection,
    addedStopIds: difference.addedStopIds,
    skippedStopIds: difference.skippedStopIds,
    addedStops: difference.addedStopIds.map((stopId) => stopDisplay(stopId, stopMap)),
    skippedStops: difference.skippedStopIds.map((stopId) => stopDisplay(stopId, stopMap)),
    sequenceChanged: difference.sequenceChanged,
  };
}

function stopSequenceIdentity(stopIds) {
  return normalizedStopIds(stopIds).join('\u001F');
}

function selectBaselineVariant(variants) {
  const sequenceGroups = new Map();
  variants.forEach((variant) => {
    const identity = stopSequenceIdentity(variant.stopIds);
    if (!sequenceGroups.has(identity)) sequenceGroups.set(identity, []);
    sequenceGroups.get(identity).push(variant);
  });

  // A repeated sequence is stronger evidence of the normal pattern than any
  // service-type number. Service type 1 is only used to break an equal-sized
  // sequence tie, matching the app's existing primary-variant convention
  // without assuming that it is always the normal trip.
  const dominantGroup = Array.from(sequenceGroups.values()).sort((left, right) => (
    right.length - left.length
    || Number(right.some((variant) => variant.serviceType === '1'))
      - Number(left.some((variant) => variant.serviceType === '1'))
    || serviceTypeSort(
      [...left].sort((a, b) => serviceTypeSort(a.serviceType, b.serviceType))[0].serviceType,
      [...right].sort((a, b) => serviceTypeSort(a.serviceType, b.serviceType))[0].serviceType,
    )
  ))[0];
  const sortedDominantGroup = [...dominantGroup].sort((left, right) => (
    serviceTypeSort(left.serviceType, right.serviceType)
  ));
  const serviceTypeOne = sortedDominantGroup.find((variant) => variant.serviceType === '1');
  const variant = serviceTypeOne || sortedDominantGroup[0];
  const hasUniqueDominantSequence = dominantGroup.length > Math.max(
    0,
    ...Array.from(sequenceGroups.values())
      .filter((group) => group !== dominantGroup)
      .map((group) => group.length),
  );
  const reason = hasUniqueDominantSequence
    ? 'dominant_sequence_then_lowest_service_type'
    : serviceTypeOne
      ? 'service_type_1_tiebreak'
      : 'lowest_service_type_tiebreak';
  return { variant, reason };
}

function parseRouteVariantEntry(routeKey, stopIds) {
  const [route, direction, serviceType] = String(routeKey || '').split('|');
  const normalizedStops = normalizedStopIds(stopIds);
  if (!route || !direction || !serviceType || normalizedStops.length < 2) return null;
  return {
    route: normalizedValue(route),
    direction: normalizedValue(direction),
    serviceType: normalizedServiceType(serviceType),
    stopIds: normalizedStops,
  };
}

export function createKmbSpecialTripDetector({
  routeStops = {},
  stopMap = {},
  operator = DEFAULT_OPERATOR,
} = {}) {
  const normalizedOperator = normalizedValue(operator || DEFAULT_OPERATOR);
  const variantsByRouteDirection = new Map();
  Object.entries(routeStops || {}).forEach(([routeKey, stopIds]) => {
    const variant = parseRouteVariantEntry(routeKey, stopIds);
    if (!variant) return;
    const groupKey = `${variant.route}|${variant.direction}`;
    if (!variantsByRouteDirection.has(groupKey)) variantsByRouteDirection.set(groupKey, []);
    variantsByRouteDirection.get(groupKey).push(variant);
  });

  const analysisByVariantKey = new Map();
  variantsByRouteDirection.forEach((variants) => {
    const { variant: baseline, reason } = selectBaselineVariant(variants);
    variants.forEach((variant) => {
      const analysis = analyseKmbRouteVariant({
        route: variant.route,
        direction: variant.direction,
        serviceType: variant.serviceType,
        baselineServiceType: baseline.serviceType,
        baselineStopIds: baseline.stopIds,
        variantStopIds: variant.stopIds,
        stopMap,
        baseSelection: reason,
      });
      if (analysis) {
        analysisByVariantKey.set(
          createKmbRouteVariantKey(variant),
          { ...analysis, variantCount: variants.length },
        );
      }
    });
  });

  const getVariantAnalysis = (candidate) => {
    const candidateOperator = normalizedValue(
      candidate?.operator || candidate?.co || DEFAULT_OPERATOR,
    );
    if (candidateOperator !== normalizedOperator) return null;
    const key = createKmbRouteVariantKey(candidate);
    return key ? analysisByVariantKey.get(key) || null : null;
  };

  const getEtaSpecialTripInfo = (eta, fallback = {}) => {
    if (!eta) return null;
    const candidate = {
      operator: eta.co || eta.operator || fallback.operator || DEFAULT_OPERATOR,
      route: eta.route || fallback.route,
      direction: eta.dir || eta.direction || eta.bound || fallback.direction || fallback.bound,
      service_type: eta.service_type ?? eta.serviceType
        ?? fallback.service_type ?? fallback.serviceType,
    };
    const analysis = getVariantAnalysis(candidate);
    return analysis?.isSpecialTrip ? analysis : null;
  };

  return {
    getVariantAnalysis,
    getEtaSpecialTripInfo,
    variantCount: analysisByVariantKey.size,
  };
}

export function annotateKmbEtaSpecialTrip(eta, fallback, detector) {
  return {
    ...eta,
    specialTripInfo: detector?.getEtaSpecialTripInfo?.(eta, fallback) || null,
  };
}

function localizedStopName(stop, locale) {
  if (locale === 'tc') return stop?.nameTc || stop?.nameEn || '';
  if (locale === 'sc') return stop?.nameSc || stop?.nameEn || '';
  return stop?.nameEn || stop?.nameTc || '';
}

function localizedStopNames(stops, locale, limit) {
  return (stops || [])
    .map((stop) => localizedStopName(stop, locale))
    .filter(Boolean)
    .slice(0, limit);
}

export function formatKmbSpecialTripInfo(info, locale = 'en', {
  maxStops = DEFAULT_DISPLAY_STOP_LIMIT,
} = {}) {
  if (!info?.isSpecialTrip) return '';
  const normalizedLocale = String(locale || 'en').toLowerCase();
  const isChinese = normalizedLocale === 'tc' || normalizedLocale === 'zh-hk';
  const addedNames = localizedStopNames(info.addedStops, isChinese ? 'tc' : 'en', maxStops);
  const skippedNames = localizedStopNames(info.skippedStops, isChinese ? 'tc' : 'en', maxStops);
  const addedCount = info.addedStopIds?.length || 0;
  const skippedCount = info.skippedStopIds?.length || 0;

  if (isChinese) {
    const pieces = ['特別班次'];
    if (addedNames.length > 0) {
      pieces.push(`途經 ${addedNames.join('、')}${addedCount > addedNames.length ? ` 等${addedCount}站` : ''}`);
    }
    if (skippedNames.length > 0) {
      pieces.push(`不停 ${skippedNames.join('、')}${skippedCount > skippedNames.length ? ` 等${skippedCount}站` : ''}`);
    }
    if (pieces.length === 1) pieces.push('停站安排不同');
    return pieces.join(' · ');
  }

  const pieces = ['Special trip'];
  if (addedNames.length > 0) {
    pieces.push(`via ${addedNames.join(', ')}${addedCount > addedNames.length ? ` +${addedCount - addedNames.length} stops` : ''}`);
  }
  if (skippedNames.length > 0) {
    pieces.push(`skips ${skippedNames.join(', ')}${skippedCount > skippedNames.length ? ` +${skippedCount - skippedNames.length} stops` : ''}`);
  }
  if (pieces.length === 1) pieces.push('different stopping pattern');
  return pieces.join(' · ');
}
