export const BOOKMARK_ETA_DISPLAY_LIMIT = 6;
export const BOOKMARK_URGENT_ETA_MINUTES = 1;

export function selectVisibleBookmarkEtas(
  etas = [],
  {
    limit = BOOKMARK_ETA_DISPLAY_LIMIT,
    urgentMinutes = BOOKMARK_URGENT_ETA_MINUTES,
  } = {},
) {
  const rows = Array.isArray(etas) ? etas : [];
  return rows.filter((eta, index) => (
    index < limit
    || (Number.isFinite(Number(eta?.waitMin)) && Number(eta.waitMin) <= urgentMinutes)
  ));
}
