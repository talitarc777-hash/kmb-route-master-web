function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-HK')
    .replace(/\s+/g, ' ');
}

function localStopScore(stopId, stop, query) {
  const id = normalizeSearchText(stopId);
  const english = normalizeSearchText(stop?.name_en);
  const chinese = normalizeSearchText(stop?.name_tc);
  const values = [id, english, chinese].filter(Boolean);
  if (values.some((value) => value === query)) return 0;
  if (values.some((value) => value.startsWith(query))) return 1;
  if (values.some((value) => value.includes(query))) return 2;
  return null;
}

export function findLocalKmbStopSuggestions(stopMap, query, limit = 5) {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length < 2 || !stopMap || typeof stopMap !== 'object') return [];

  return Object.entries(stopMap)
    .map(([stopId, stop]) => {
      const score = localStopScore(stopId, stop, normalizedQuery);
      const lat = Number(stop?.lat);
      const lng = Number(stop?.lng);
      if (score == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const mainText = stop.name_tc || stop.name_en || stopId;
      const secondaryText = [stop.name_en, stopId]
        .filter((value) => value && value !== mainText)
        .join(' · ');
      return {
        score,
        source: 'kmb',
        place_id: `kmb-stop:${stopId}`,
        description: secondaryText ? `${mainText} (${secondaryText})` : mainText,
        structured_formatting: {
          main_text: mainText,
          secondary_text: secondaryText,
        },
        lat,
        lng,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score ||
      left.description.localeCompare(right.description, 'zh-HK'))
    .slice(0, Math.max(1, limit))
    .map(({ score, ...suggestion }) => suggestion);
}

export function normalizeGooglePlaceSuggestions(payload, limit = 5) {
  if (payload?.status !== 'OK' || !Array.isArray(payload?.predictions)) return [];
  return payload.predictions
    .filter((prediction) => prediction?.place_id && prediction?.description)
    .slice(0, Math.max(1, limit))
    .map((prediction) => ({
      source: 'google',
      place_id: prediction.place_id,
      description: prediction.description,
      structured_formatting: {
        main_text: prediction.structured_formatting?.main_text || prediction.description,
        secondary_text: prediction.structured_formatting?.secondary_text || '',
      },
    }));
}
