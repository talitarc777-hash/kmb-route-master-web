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
