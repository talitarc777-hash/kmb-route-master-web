import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  generateFallbackCandidates,
  refineFallbackCandidateRideTimes,
} from './data/fallbackRouteGenerator.js';

// Constants
const ROUTE_COLORS = [
  '#E1251B',
  '#2563EB',
  '#16A34A',
  '#D97706',
  '#9333EA',
  '#DB2777',
  '#0891B2',
  '#65A30D',
];

const GCP_CACHE_LIMIT = 200;
const GCP_GEOCODE_CACHE_KEY = 'kmb_gcp_geocode_cache_v1';
const GCP_AUTOCOMPLETE_CACHE_KEY = 'kmb_gcp_autocomplete_cache_v1';
const GCP_GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GCP_AUTOCOMPLETE_TTL_MS = 12 * 60 * 60 * 1000;
const FALLBACK_GRID_SIZE_DEG = 0.005;
const FALLBACK_CACHE_LIMIT = 16;
const FALLBACK_CACHE_TTL_MS = 30 * 60 * 1000;

const geocodeCacheState = {
  memory: new Map(),
  inflight: new Map(),
  persisted: null,
  storageKey: GCP_GEOCODE_CACHE_KEY,
  ttlMs: GCP_GEOCODE_TTL_MS,
};

const autocompleteCacheState = {
  memory: new Map(),
  inflight: new Map(),
  persisted: null,
  storageKey: GCP_AUTOCOMPLETE_CACHE_KEY,
  ttlMs: GCP_AUTOCOMPLETE_TTL_MS,
};

function loadGcpCache(state) {
  if (state.persisted) return state.persisted;
  state.persisted = new Map();
  try {
    const raw = localStorage.getItem(state.storageKey);
    if (!raw) return state.persisted;
    const rows = JSON.parse(raw);
    const now = Date.now();
    rows.forEach((row) => {
      if (!row?.key) return;
      if (!row.expiresAt || row.expiresAt <= now) return;
      state.persisted.set(row.key, row);
    });
  } catch {
    state.persisted = new Map();
  }
  return state.persisted;
}

function saveGcpCache(state) {
  try {
    const now = Date.now();
    const rows = Array.from(loadGcpCache(state).entries())
      .map(([key, row]) => ({ key, ...row }))
      .filter((row) => row.expiresAt > now)
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
      .slice(0, GCP_CACHE_LIMIT);
    localStorage.setItem(state.storageKey, JSON.stringify(rows));
  } catch {
    // Ignore quota/storage errors to avoid blocking UI.
  }
}

function getCachedGcpValue(state, key) {
  if (state.memory.has(key)) return state.memory.get(key);
  const cache = loadGcpCache(state);
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    saveGcpCache(state);
    return null;
  }
  state.memory.set(key, hit.value);
  return hit.value;
}

function setCachedGcpValue(state, key, value) {
  state.memory.set(key, value);
  const cache = loadGcpCache(state);
  cache.set(key, {
    value,
    savedAt: Date.now(),
    expiresAt: Date.now() + state.ttlMs,
  });
  saveGcpCache(state);
}

async function fetchGcpWithCache(state, key, fetcher) {
  const cached = getCachedGcpValue(state, key);
  if (cached) return cached;
  if (state.inflight.has(key)) return state.inflight.get(key);

  const request = (async () => {
    try {
      const value = await fetcher();
      if (value !== null && value !== undefined) setCachedGcpValue(state, key, value);
      return value;
    } finally {
      state.inflight.delete(key);
    }
  })();

  state.inflight.set(key, request);
  return request;
}

// Utility: Coordinate conversion
function hk80ToWgs84(x, y) {
  return {
    lat: 22.312133 + (y - 819069.8) / 111111,
    lng: 114.178556 + (x - 836694.05) / 102980,
  };
}

function wgs84ToHk80(lat, lng) {
  return {
    x: 836694.05 + (lng - 114.178556) * 102980,
    y: 819069.8 + (lat - 22.312133) * 111111,
  };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseLocationInput(input) {
  const trimmed = input.trim();
  const m = trimmed.match(/^([\d.]+)\s*[,\s]\s*([\d.]+)$/);
  if (m) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (a > 800000 && b > 800000) {
      const w = hk80ToWgs84(a, b);
      return { type: 'coords', lat: w.lat, lng: w.lng };
    }
    if (a > 10 && a < 30 && b > 100 && b < 130)
      return { type: 'coords', lat: a, lng: b };
  }
  return { type: 'text', query: trimmed };
}

async function geocode(query, placeId = null) {
  const normalizedQuery = query.trim().toLowerCase();
  const cacheKey = placeId ? `pid:${placeId}` : `q:${normalizedQuery}`;
  return fetchGcpWithCache(geocodeCacheState, cacheKey, async () => {
    const queryPart = placeId
      ? `place_id=${encodeURIComponent(placeId)}`
      : `address=${encodeURIComponent(query)}&components=country:hk`;
    const res = await fetch(`/api/google/geocode/json?${queryPart}`);
    const data = await res.json();
    if (!data || data.status !== 'OK' || data.results.length === 0) return null;
    const loc = data.results[0].geometry.location;
    return { lat: loc.lat, lng: loc.lng, name: query };
  });
}

async function resolveLocation(inputObj) {
  const rawText = typeof inputObj === 'string' ? inputObj : inputObj.name;
  const placeId = typeof inputObj === 'object' ? inputObj.place_id : null;
  const parsed = parseLocationInput(rawText);
  if (parsed.type === 'coords') return { lat: parsed.lat, lng: parsed.lng, name: rawText };
  const result = await geocode(rawText, placeId);
  if (!result) throw new Error(`Cannot find location: "${rawText}"`);
  return result;
}

function cloneRouteResults(routes) {
  return (routes || []).map((route) => ({
    ...route,
    segments: (route.segments || []).map((seg) => ({ ...seg })),
    legs: (route.legs || []).map((leg) => ({ ...leg })),
  }));
}

function withSoftTimeout(promise, timeoutMs) {
  let timeoutId;
  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      resolve({ timedOut: true, promise });
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve({ timedOut: false, value });
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function buildSearchCacheKey({
  originLoc,
  destLoc,
  timeMode,
  dateValue,
  timeValue,
  excludedRoutesText,
  allowFallbackNonKmb,
  strictEtaOnly,
}) {
  return JSON.stringify({
    origin: [originLoc.lat.toFixed(6), originLoc.lng.toFixed(6)],
    destination: [destLoc.lat.toFixed(6), destLoc.lng.toFixed(6)],
    timeMode,
    dateValue: timeMode === 'now' ? '' : dateValue,
    timeValue: timeMode === 'now' ? '' : timeValue,
    excludedRoutesText: (excludedRoutesText || '').trim().toUpperCase(),
    allowFallbackNonKmb: Boolean(allowFallbackNonKmb),
    strictEtaOnly: Boolean(strictEtaOnly),
  });
}

function coarseCoord(value) {
  return Math.round(value / FALLBACK_GRID_SIZE_DEG) * FALLBACK_GRID_SIZE_DEG;
}

function buildFallbackCacheKey({
  originLoc,
  destLoc,
  timeMode,
  dateValue,
  timeValue,
  includeTransfers,
  maxCandidates,
}) {
  const timeKey = timeMode === 'now'
    ? `now:${Math.floor(Date.now() / FALLBACK_CACHE_TTL_MS)}`
    : `${dateValue || ''}:${timeValue || ''}`;
  return JSON.stringify({
    origin: [coarseCoord(originLoc.lat).toFixed(3), coarseCoord(originLoc.lng).toFixed(3)],
    destination: [coarseCoord(destLoc.lat).toFixed(3), coarseCoord(destLoc.lng).toFixed(3)],
    timeMode,
    timeKey,
    includeTransfers: Boolean(includeTransfers),
    maxCandidates,
  });
}

function getCachedFallback(cache, key) {
  const row = cache.get(key);
  if (!row) return null;
  if (Date.now() - row.savedAt > FALLBACK_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return row;
}

function setCachedFallback(cache, key, row) {
  cache.set(key, {
    ...row,
    savedAt: Date.now(),
  });
  if (cache.size > FALLBACK_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function isFallbackRoute(route) {
  return route?.type === 'fallback_candidate' || route?.isFallback;
}

function parseMoney(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatFare(fare) {
  if (!fare || fare.status !== 'available' || fare.amount == null) return 'Fare unavailable';
  return `${fare.currency || 'HKD'} ${Number(fare.amount).toFixed(1)}`;
}

function getOperatorDisplayName(code) {
  const key = String(code || '').trim().toUpperCase();
  if (key === 'KMB') return 'KMB';
  if (key === 'CTB') return 'Citybus';
  if (key === 'TRAM') return 'Tram';
  if (key === 'MTR') return 'MTR';
  return code || 'Other';
}

function getOperatorBadgeClass(code) {
  const key = String(code || '').trim().toUpperCase();
  if (key === 'KMB') return 'bg-red-600 text-white';
  if (key === 'CTB') return 'bg-blue-600 text-white';
  if (key === 'TRAM') return 'bg-emerald-600 text-white';
  if (key === 'MTR') return 'bg-amber-500 text-slate-900';
  return 'bg-slate-500 text-white';
}

function parseOperatorCodes(value) {
  if (!value) return [];
  return String(value)
    .split('+')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function estimateKmbFare(route) {
  let total = 0;
  for (const segment of route?.segments || []) {
    const fare = parseMoney(segment?.routeInfo?.fare ?? segment?.routeInfo?.full_fare);
    if (fare == null) return null;
    total += fare;
  }
  return Number(total.toFixed(1));
}

function knownFareForRanking(route) {
  if (isFallbackRoute(route)) {
    return route.fare?.status === 'available' ? parseMoney(route.fare.amount) : null;
  }
  // User-specific rule: treat KMB as zero-cost for ranking because of monthly pass.
  return 0;
}

function estimatedTimeForRanking(route) {
  return isFallbackRoute(route)
    ? route.estimated_time_min ?? route.estimatedTime ?? 9999
    : route.estimatedTime ?? 9999;
}

function rankCombinedTransportOptions(routes) {
  return [...(routes || [])].sort((a, b) => {
    const aFare = knownFareForRanking(a);
    const bFare = knownFareForRanking(b);

    if (aFare != null && bFare != null && aFare !== bFare) return aFare - bFare;
    if (estimatedTimeForRanking(a) !== estimatedTimeForRanking(b)) {
      return estimatedTimeForRanking(a) - estimatedTimeForRanking(b);
    }
    if ((a.transfers || 0) !== (b.transfers || 0)) {
      return (a.transfers || 0) - (b.transfers || 0);
    }
    // Final tie-breaker: if everything else is equal, prefer known fare.
    if (aFare == null && bFare != null) return 1;
    if (aFare != null && bFare == null) return -1;
    return 0;
  });
}

function scoreKmbQuality(routes) {
  if (!routes || routes.length === 0) {
    return { score: 0, isWeak: true, reason: 'No KMB route found' };
  }

  const best = [...routes].sort(
    (a, b) => estimatedTimeForRanking(a) - estimatedTimeForRanking(b),
  )[0];
  const segments = best.segments || [];
  const etaCoverage = segments.length > 0
    ? segments.filter((seg) => seg.hasActiveEta === true).length / segments.length
    : 0;
  const wait = best.originWaitTime ?? 99;
  const estimatedTime = best.estimatedTime ?? 9999;

  let score = 0.2;
  score += best.transfers === 0 ? 0.2 : best.transfers === 1 ? 0.1 : 0;
  score += etaCoverage * 0.25;
  score += wait <= 5 ? 0.15 : wait <= 12 ? 0.08 : 0;
  score += estimatedTime <= 45 ? 0.15 : estimatedTime <= 70 ? 0.08 : 0;
  score += routes.length >= 3 ? 0.05 : 0;

  const rounded = Number(Math.min(1, score).toFixed(2));
  const weakReasons = [];
  if (best.transfers > 0) weakReasons.push('best KMB needs transfer');
  if (etaCoverage < 1) weakReasons.push('missing live ETA');
  if (wait > 12) weakReasons.push('long wait');
  if (estimatedTime > 70) weakReasons.push('long trip time');

  return {
    score: rounded,
    isWeak: rounded < 0.65,
    reason: weakReasons.join(', ') || 'KMB route looks usable',
  };
}

function fallbackSearchSettings(kmbQuality) {
  if (kmbQuality.isWeak) {
    return {
      includeTransfers: true,
      maxCandidates: 12,
      googleRefineLimit: 5,
      timeoutMs: 20000,
    };
  }

  return {
    includeTransfers: false,
    maxCandidates: 6,
    googleRefineLimit: 3,
    timeoutMs: 12000,
  };
}

function annotateAlternativeCandidates(candidates) {
  return (candidates || []).map((candidate) => ({
    ...candidate,
    isFallback: true,
    optionLabel: 'Alternative transport option',
    estimatedTime: candidate.estimated_time_min,
  }));
}

// Autocomplete Input Component
const AutocompleteInput = ({ value, onChange, placeholder, onClear }) => {
  const displayValue = typeof value === 'string' ? value : value?.name || '';
  const [suggestions, setSuggestions] = useState([]);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const trimmedValue = displayValue.trim();
      const hasSelectedPlace = Boolean(value && typeof value === 'object' && value.place_id);
      const parsedValue = trimmedValue ? parseLocationInput(trimmedValue) : null;

      if (trimmedValue.length < 2 || hasSelectedPlace || parsedValue?.type === 'coords') {
        setSuggestions([]);
        return;
      }
      try {
        const key = trimmedValue.toLowerCase();
        const predictions = await fetchGcpWithCache(
          autocompleteCacheState,
          key,
          async () => {
            const res = await fetch(
              `/api/google/place/autocomplete/json?input=${encodeURIComponent(trimmedValue)}&components=country:hk`,
            );
            const data = await res.json();
            return data.status === 'OK' ? data.predictions.slice(0, 5) : [];
          },
        );
        setSuggestions(predictions || []);
      } catch (e) {
        console.error('Fetch Error:', e);
        setSuggestions([]);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [value, displayValue]);

  return (
    <div className="relative w-full">
      <input
        className={`w-full p-4 bg-slate-50 rounded-2xl font-bold border border-slate-200 ${onClear ? 'pr-12' : ''}`}
        placeholder={placeholder}
        value={displayValue}
        onChange={(e) => {
          onChange(e.target.value);
          setShow(true);
        }}
        onFocus={() => setShow(true)}
        onBlur={() => setTimeout(() => setShow(false), 200)}
      />
      {onClear && displayValue && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onClear();
            setSuggestions([]);
            setShow(false);
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 font-black text-lg leading-none"
          aria-label={`Clear ${placeholder}`}
        >
          {'\u2715'}
        </button>
      )}
      {show && suggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 bg-white border border-slate-200 rounded-xl shadow-xl mt-1 overflow-hidden">
          {suggestions.map((s) => (
            <div
              key={s.place_id}
              onMouseDown={() => {
                onChange({ name: s.description, place_id: s.place_id });
                setShow(false);
              }}
              className="px-4 py-3 hover:bg-slate-50 cursor-pointer text-sm border-b border-slate-100"
            >
              <span className="font-bold">{s.structured_formatting?.main_text}</span>
              <span className="text-slate-400 ml-1 text-xs">
                {s.structured_formatting?.secondary_text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// Skeleton card
const SkeletonCard = () => (
  <div className="p-4 bg-slate-50 rounded-2xl border-2 border-slate-100 animate-pulse">
    <div className="flex justify-between">
      <div>
        <div className="w-24 h-6 bg-slate-200 rounded-lg mb-2" />
        <div className="w-40 h-4 bg-slate-100 rounded-lg" />
      </div>
      <div className="w-16 h-8 bg-slate-200 rounded-lg" />
    </div>
  </div>
);

// Bookmark Panel Component
const BookmarkPanel = ({ stopMap, onClose, bookmarks, setBookmarks }) => {
  const [etaMap, setEtaMap] = useState(new Map());
  const [editing, setEditing] = useState(null);
  const [newGroupName, setNewGroupName] = useState('');
  const pollerRef = useRef(null);

  useEffect(() => {
    pollerRef.current = new window.bookmarkEngine.ETAPoller((updates) => {
      setEtaMap(new Map(updates));
    });
    pollerRef.current.start(bookmarks);
    return () => pollerRef.current.stop();
  }, []);

  useEffect(() => {
    if (pollerRef.current) pollerRef.current.update(bookmarks);
  }, [bookmarks]);

  const update = (newBm) => setBookmarks(newBm);

  const handleAddGroup = () => {
    if (!newGroupName.trim()) return;
    const updated = window.bookmarkEngine.createGroup(bookmarks, newGroupName.trim());
    update(updated);
    setNewGroupName('');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-black text-lg">{'\u2B50'} Bookmarks</h2>
        <button onClick={onClose} className="text-slate-400 text-xl font-bold">
          {'\u2715'}
        </button>
      </div>

      {/* Add group */}
      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 p-2 bg-slate-100 rounded-xl text-sm font-bold border border-slate-200"
          placeholder="New group name..."
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAddGroup()}
        />
        <button
          onClick={handleAddGroup}
          className="px-3 py-2 bg-[#E1251B] text-white rounded-xl text-sm font-black"
        >
          +
        </button>
      </div>

      {bookmarks.length === 0 && (
        <div className="text-center text-slate-400 text-sm mt-4">
          No bookmark groups yet.
          <br />
          Add a group to track your favourite stops!
        </div>
      )}

      <div className="space-y-4 overflow-y-auto flex-1 scrollbar-hide">
        {bookmarks.map((group, gi) => (
          <div key={gi} className="bg-slate-50 rounded-2xl border border-slate-100 p-3">
            {/* Group header */}
            <div className="flex items-center justify-between mb-2">
              {editing === gi ? (
                <input
                  className="font-black text-sm bg-white border border-slate-200 rounded-lg px-2 py-1 flex-1 mr-2"
                  value={group.groupName}
                  autoFocus
                  onChange={(e) => {
                    const updated = window.bookmarkEngine.renameGroup(
                      bookmarks,
                      gi,
                      e.target.value,
                    );
                    update(updated);
                  }}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
                />
              ) : (
                <span
                  className="font-black text-sm text-slate-700 cursor-pointer"
                  onClick={() => setEditing(gi)}
                >
                  {group.groupName} {'\u270F\uFE0F'}
                </span>
              )}
              <button
                onClick={() => {
                  const u = window.bookmarkEngine.deleteGroup(bookmarks, gi);
                  update(u);
                }}
                className="text-red-400 text-xs font-bold"
              >
                {'\u2715'}
              </button>
            </div>

            {group.stops.length === 0 && (
              <div className="text-xs text-slate-300 mb-1">
                No stops yet. Add stops from route results.
              </div>
            )}

            {group.stops.map((s, si) => {
              const stopInfo = stopMap[s.stopId];
              const hasEtaData = etaMap.has(s.stopId);
              const etas = etaMap.get(s.stopId) || [];
              return (
                <div
                  key={si}
                  className="flex items-start justify-between py-2 border-b border-slate-100 last:border-none"
                >
                  <div className="flex-1">
                    <div className="text-sm font-bold text-slate-700">
                      {stopInfo?.name_tc || s.stopName}
                    </div>
                    <div className="text-xs text-slate-400">{stopInfo?.name_en}</div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {!hasEtaData && (
                        <span className="text-xs text-slate-300">Fetching ETAs...</span>
                      )}
                      {hasEtaData && etas.length === 0 && (
                        <span className="text-xs text-slate-400">No ETA available now</span>
                      )}
                      {etas.slice(0, 4).map((e, ei) => (
                        <span
                          key={ei}
                          className={`text-xs font-bold px-2 py-0.5 rounded-full bg-white border eta-${e.color}`}
                        >
                          {e.route} {'\u00B7'} {e.waitMin <= 0 ? 'Arriving' : `${e.waitMin}min`}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const u = window.bookmarkEngine.removeStop(bookmarks, gi, s.stopId);
                      update(u);
                    }}
                    className="text-slate-300 text-sm hover:text-red-400 ml-2 mt-0.5"
                  >
                    {'\u2715'}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};

// Main App Component
const App = () => {
  const [mapLoaded, setMapLoaded] = useState(false);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [results, setResults] = useState([]);
  const [selectedRoute, setSelectedRoute] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(true);
  const [isFilterExpanded, setIsFilterExpanded] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState('Initialising...');
  const [searchError, setSearchError] = useState(null);
  const [expandedSegments, setExpandedSegments] = useState(new Set());
  const [timeMode, setTimeMode] = useState('now');
  const [dateValue, setDateValue] = useState(
    new Date().toISOString().split('T')[0],
  );
  const [timeValue, setTimeValue] = useState(
    new Date().toTimeString().substring(0, 5),
  );
  const [excludedRoutesText, setExcludedRoutesText] = useState('');
  const [strictEtaOnly, setStrictEtaOnly] = useState(true);
  const [allowFallbackNonKmb, setAllowFallbackNonKmb] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [isResultsMinimized, setIsResultsMinimized] = useState(false);
  const [isRefreshingEta, setIsRefreshingEta] = useState(false);
  const [lastEtaRefreshAt, setLastEtaRefreshAt] = useState(null);
  const [refreshFeedback, setRefreshFeedback] = useState(null);

  // Add-to-bookmark modal state
  const [addToBookmark, setAddToBookmark] = useState(null);
  const [bookmarks, setBookmarks] = useState(() =>
    window.bookmarkEngine?.loadBookmarks?.() || [],
  );

  const mapRef = useRef(null);
  const viewRef = useRef(null);
  const graphicsLayerRef = useRef(null);
  const arcgisModulesRef = useRef(null);
  const stopMapRef = useRef({});
  const routeMapRef = useRef({});
  const routeStopsRef = useRef({});
  const stopRoutesRef = useRef({});
  const searchCacheRef = useRef(new Map());
  const fallbackCacheRef = useRef(new Map());
  const searchRunRef = useRef(0);

  const displayedResults = useMemo(() => {
    if (!strictEtaOnly || timeMode !== 'now') return results;
    return results.filter((route) =>
      isFallbackRoute(route) ||
      (route.segments || []).every((seg) => seg.hasActiveEta === true),
    );
  }, [results, strictEtaOnly, timeMode]);

  const displayedResultCards = useMemo(() => {
    const groups = new Map();
    const cardsByKey = new Map();
    const orderedKeys = [];
    for (const route of displayedResults) {
      if (isFallbackRoute(route)) {
        const key = route.id || `fallback-${orderedKeys.length}`;
        cardsByKey.set(key, {
          key,
          type: 'fallback',
          representative: route,
          segmentDisplay: [],
        });
        orderedKeys.push(key);
        continue;
      }
      const stopPattern = (route.segments || [])
        .map((seg) => `${seg.fromStop}->${seg.toStop}`)
        .join('|');
      const groupKey = `${route.transfers}|${stopPattern}`;
      const isNewGroup = !groups.has(groupKey);
      if (isNewGroup) groups.set(groupKey, []);
      groups.get(groupKey).push(route);
      if (isNewGroup) orderedKeys.push(groupKey);
    }

    Array.from(groups.entries()).forEach(([groupKey, groupRoutes]) => {
      const sortedRoutes = [...groupRoutes].sort(
        (a, b) => (a.estimatedTime || 9999) - (b.estimatedTime || 9999),
      );
      const representative = sortedRoutes[0];
      const segmentDisplay = (representative.segments || []).map((seg, si) => {
        const routeOptionMap = new Map();
        sortedRoutes.forEach((routeCandidate) => {
          const candidateSeg = (routeCandidate.segments || [])[si];
          if (!candidateSeg?.route) return;
          const optionKey = `${candidateSeg.route}|${candidateSeg.service_type || '1'}`;
          const candidateEta = candidateSeg.nextEta ? new Date(candidateSeg.nextEta) : null;
          const previous = routeOptionMap.get(optionKey);
          const shouldReplace =
            !previous ||
            (candidateEta && (!previous.nextEta || candidateEta < previous.nextEta));
          if (shouldReplace) {
            routeOptionMap.set(optionKey, {
              route: candidateSeg.route,
              service_type: candidateSeg.service_type || '1',
              nextEta: candidateEta,
              hasActiveEta: Boolean(candidateSeg.hasActiveEta ?? candidateSeg.nextEta),
              busInterval: candidateSeg.busInterval ?? null,
            });
          }
        });

        const routeOptions = Array.from(routeOptionMap.values()).sort((a, b) =>
          a.route.localeCompare(b.route, undefined, { numeric: true, sensitivity: 'base' }),
        );
        const routeNames = routeOptions.map((o) => o.route);
        const earliestEta = routeOptions
          .map((o) => o.nextEta)
          .filter(Boolean)
          .sort((a, b) => a - b)[0];

        return {
          ...seg,
          routeLabel: routeNames.join('/'),
          routeOptions,
          nextEta: earliestEta || seg.nextEta,
        };
      });

      cardsByKey.set(groupKey, {
        key: groupKey,
        representative,
        segmentDisplay,
      });
    });

    return orderedKeys.map((key) => cardsByKey.get(key)).filter(Boolean);
  }, [displayedResults]);

  const availableFilterRoutes = useMemo(() => {
    return Array.from(
      new Set(
        displayedResults
          .filter((route) => !isFallbackRoute(route))
          .flatMap((route) => (route.segments || []).map((seg) => seg.route)),
      ),
    ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  }, [displayedResults]);

  const getEtaText = useCallback((etaValue) => {
    if (!etaValue) return 'No ETA';
    const waitMin = Math.max(
      0,
      Math.round((new Date(etaValue) - new Date()) / 60000),
    );
    return waitMin <= 0 ? 'Arriving' : `${waitMin} min`;
  }, []);

  const getEtaChipClass = useCallback((etaValue) => {
    if (!etaValue) return 'bg-slate-100 text-slate-500 border-slate-200';
    const waitMin = Math.max(
      0,
      Math.round((new Date(etaValue) - new Date()) / 60000),
    );
    if (waitMin <= 3) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (waitMin <= 10) return 'bg-amber-50 text-amber-700 border-amber-200';
    return 'bg-rose-50 text-rose-700 border-rose-200';
  }, []);

  const formatClockTime = useCallback((timeValue) => {
    if (!timeValue) return null;
    const parsed = timeValue instanceof Date ? timeValue : new Date(timeValue);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleTimeString('en-HK', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }, []);

  const refreshStatusClass = useMemo(() => {
    if (!refreshFeedback) return '';
    if (refreshFeedback.type === 'success')
      return 'bg-emerald-50 border-emerald-200 text-emerald-700';
    if (refreshFeedback.type === 'error')
      return 'bg-red-50 border-red-200 text-red-600';
    return 'bg-slate-100 border-slate-200 text-slate-600';
  }, [refreshFeedback]);

  const formatRefreshTime = useCallback((time) => {
    if (!time) return '';
    return time.toLocaleTimeString('en-HK', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, []);

  const refreshRouteTiming = useCallback(
    async (route) => {
      if (isFallbackRoute(route)) return route;
      const clonedRoute = {
        ...route,
        segments: (route.segments || []).map((seg) => ({ ...seg })),
      };
      const isValid = await window.routeEngine.applyRouteTiming(clonedRoute, {
        timeMode,
        dateValue,
        timeValue,
        now: new Date(),
        allowNoEtaNow: !strictEtaOnly,
      });
      return isValid ? clonedRoute : null;
    },
    [dateValue, strictEtaOnly, timeMode, timeValue],
  );

  // Load KMB data
  useEffect(() => {
    loadKMBData();
  }, []);

  useEffect(() => {
    initArcGIS();
  }, []);

  const loadKMBData = async () => {
    try {
      setLoadingStatus('Connecting to KMB Open Data...');
      
      const [stopsRes, routesRes, routeStopsRes] = await Promise.all([
        fetch('/api/kmb/stop'),
        fetch('/api/kmb/route'),
        fetch('/api/kmb/route-stop')
      ]);

      if (!stopsRes.ok) throw new Error('API Response Error');

      setLoadingStatus('Processing Map Data...');
      const [stopsData, routesData, routeStopsData] = await Promise.all([
        stopsRes.json(),
        routesRes.json(),
        routeStopsRes.json(),
      ]);

      // 1. Process Stops (ID -> Name/Lat/Long)
      const sm = {};
      stopsData.data.forEach(s => {
        sm[s.stop] = {
          name_en: s.name_en,
          name_tc: s.name_tc,
          lat: parseFloat(s.lat),
          lng: parseFloat(s.long),
        };
      });
      stopMapRef.current = sm;

      // 2. Process Routes
      const rm = {};
      routesData.data.forEach(r => {
        // Create a unique key for each route direction
        rm[`${r.route}|${r.bound}|${r.service_type}`] = r;
      });
      routeMapRef.current = rm;

      // 3. Process Route-Stop Relationships (The sequences)
      const rs = {};
      const sr = {};
      routeStopsData.data.forEach(item => {
        const key = `${item.route}|${item.bound}|${item.service_type}`;
        if (!rs[key]) rs[key] = [];
        rs[key].push(item.stop);
        
        if (!sr[item.stop]) sr[item.stop] = [];
        sr[item.stop].push({
          route: item.route,
          bound: item.bound,
          service_type: item.service_type,
          seq: parseInt(item.seq),
        });
      });
      routeStopsRef.current = rs;
      stopRoutesRef.current = sr;

      setLoadingStatus('Ready');
      setDataLoaded(true);
    } catch (err) {
      console.error("Data Load Error:", err);
      setLoadingStatus('Connection failed. Please check your internet and refresh.');
    }
  };

  const initArcGIS = () => {
    window.require(
      [
        'esri/Map',
        'esri/Basemap',
        'esri/layers/VectorTileLayer',
        'esri/views/MapView',
        'esri/geometry/Point',
        'esri/layers/GraphicsLayer',
        'esri/Graphic',
        'esri/geometry/Polyline',
        'esri/geometry/Extent',
      ],
      (Map, Basemap, VectorTileLayer, MapView, Point, GraphicsLayer, Graphic, Polyline, Extent) => {
        arcgisModulesRef.current = { Point, Graphic, Polyline, Extent };
        const vtLayer = new VectorTileLayer({
          url: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/basemap/HK80',
        });
        const labelLayer = new VectorTileLayer({
          url: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/label/hk/tc/HK80',
        });
        const map = new Map({ basemap: new Basemap({ baseLayers: [vtLayer] }) });
        map.add(labelLayer);
        const view = new MapView({
          container: mapRef.current,
          map,
          center: new Point({
            x: 833359.88,
            y: 822961.98,
            spatialReference: { wkid: 2326 },
          }),
          zoom: 12,
        });
        const layer = new GraphicsLayer();
        map.add(layer);
        graphicsLayerRef.current = layer;
        viewRef.current = view;
        view.ui.padding = { top: 80 };
        view.when(() => setMapLoaded(true));
      },
    );
  };

  const clearMapGraphics = () => graphicsLayerRef.current?.removeAll();

  const drawFallbackRouteOnMap = (route) => {
    clearMapGraphics();
    const { Graphic, Polyline, Point, Extent } = arcgisModulesRef.current || {};
    const layer = graphicsLayerRef.current;
    const view = viewRef.current;
    if (!layer || !view || !Graphic || !Polyline || !Point || !Extent) return;

    const points = [
      route.origin,
      ...(route.legs || []).flatMap((leg) => [leg.origin_stop, leg.destination_stop]),
      route.destination,
    ].filter((point) => point?.lat != null && point?.lng != null);

    if (points.length < 2) return;

    layer.add(
      new Graphic({
        geometry: new Polyline({
          paths: [points.map((point) => [point.lng, point.lat])],
          spatialReference: { wkid: 4326 },
        }),
        symbol: { type: 'simple-line', color: [37, 99, 235, 0.85], width: 5, style: 'short-dash' },
      }),
    );

    points.forEach((point, index) => {
      layer.add(
        new Graphic({
          geometry: new Point({ x: point.lng, y: point.lat, spatialReference: { wkid: 4326 } }),
          symbol: {
            type: 'simple-marker',
            color: index === 0 ? [34, 197, 94] : index === points.length - 1 ? [239, 68, 68] : [255, 255, 255],
            size: index === 0 || index === points.length - 1 ? 13 : 9,
            outline: { color: [37, 99, 235], width: 2 },
          },
          popupTemplate: { title: point.name?.en || point.name || point.stop_id || 'Transport stop' },
        }),
      );
    });

    const lats = points.map((point) => point.lat);
    const lngs = points.map((point) => point.lng);
    view.goTo(
      new Extent({
        xmin: Math.min(...lngs) - 0.005,
        ymin: Math.min(...lats) - 0.005,
        xmax: Math.max(...lngs) + 0.005,
        ymax: Math.max(...lats) + 0.005,
        spatialReference: { wkid: 4326 },
      }).expand(1.15),
    ).catch(() => {});
  };

  // Search handler
  const handleSearch = async (e, overrides = {}) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!dataLoaded) return;
    const searchAllowFallback = overrides.allowFallbackNonKmb ?? allowFallbackNonKmb;
    const searchStrictEtaOnly = overrides.strictEtaOnly ?? strictEtaOnly;
    const preserveExistingResults = Boolean(overrides.preserveExistingResults);
    const searchRunId = ++searchRunRef.current;
    window.routeEngine?.clearEtaCallLog?.();
    setIsLoading(true);
    setSearchError(null);
    setRefreshFeedback(null);
    if (!preserveExistingResults) setResults([]);
    setSelectedRoute(null);
    clearMapGraphics();

    try {
      let kmbSearchError = null;
      const [originLoc, destLoc] = await Promise.all([
        resolveLocation(origin),
        resolveLocation(destination),
      ]);
      const searchCacheKey = buildSearchCacheKey({
        originLoc,
        destLoc,
        timeMode,
        dateValue,
        timeValue,
        excludedRoutesText,
        allowFallbackNonKmb: searchAllowFallback,
        strictEtaOnly: searchStrictEtaOnly,
      });
      const canReusePlannedSearch = timeMode !== 'now';
      const cachedSearch = canReusePlannedSearch
        ? searchCacheRef.current.get(searchCacheKey)
        : null;

      if (cachedSearch) {
        setResults(cloneRouteResults(cachedSearch));
        setIsSearchOpen(false);
        return;
      }

      setLoadingStatus('Searching routes...');
      let filteredCandidates = [];
      try {
        const routeSearch = await window.routeEngine.findRoutes({
          originLoc,
          destLoc,
          stopMap: stopMapRef.current,
          routeMap: routeMapRef.current,
          routeStops: routeStopsRef.current,
          stopRoutes: stopRoutesRef.current,
          timeMode,
          dateValue,
          timeValue,
          excludedRoutesText,
          strictEtaOnly: searchStrictEtaOnly,
          onProgress: (msg) => setLoadingStatus(msg),
        });
        filteredCandidates = routeSearch.filteredCandidates || [];
      } catch (err) {
        kmbSearchError = err;
        if (!searchAllowFallback) throw err;
      }

      if (filteredCandidates.length === 0 && !searchAllowFallback)
        throw new Error(
          'No routes found. Try different locations or check if bus services are running.',
        );

      let finalResults = filteredCandidates;
      if (searchAllowFallback) {
        const hasValidKmb = filteredCandidates.length > 0;
        const kmbQuality = scoreKmbQuality(filteredCandidates);
        const fallbackSettings = fallbackSearchSettings(kmbQuality);
        const fallbackCacheKey = buildFallbackCacheKey({
          originLoc,
          destLoc,
          timeMode,
          dateValue,
          timeValue,
          includeTransfers: fallbackSettings.includeTransfers,
          maxCandidates: fallbackSettings.maxCandidates,
        });
        setLoadingStatus('Checking other transport options...');
        try {
          const cachedFallback = getCachedFallback(fallbackCacheRef.current, fallbackCacheKey);
          let fallbackPayload = cachedFallback?.payload || null;
          let fallbackTimedOut = false;
          let fallbackRequest = null;
          if (!fallbackPayload) {
            fallbackRequest = generateFallbackCandidates({
              originLoc,
              destLoc,
              maxCandidates: fallbackSettings.maxCandidates,
              includeTransfers: fallbackSettings.includeTransfers,
              timeMode,
              dateValue,
              timeValue,
              refineRideTimes: false,
            });
            const fallbackResult = await withSoftTimeout(fallbackRequest, fallbackSettings.timeoutMs);
            fallbackTimedOut = fallbackResult.timedOut;
            fallbackPayload = fallbackTimedOut
              ? {
                  candidates: [],
                  debug: [{ status: 'pending_operator_datasets' }],
                  generated_at: new Date().toISOString(),
                  source: 'operator datasets still loading',
                }
              : fallbackResult.value;
          }
          if (!cachedFallback && !fallbackTimedOut) {
            setCachedFallback(fallbackCacheRef.current, fallbackCacheKey, { payload: fallbackPayload });
          }
          const alternatives = annotateAlternativeCandidates(fallbackPayload.candidates || []);
          finalResults = rankCombinedTransportOptions([...filteredCandidates, ...alternatives]);
          if (fallbackTimedOut && fallbackRequest) {
            fallbackRequest
              .then((latePayload) => {
                if (searchRunRef.current !== searchRunId) return;
                setCachedFallback(fallbackCacheRef.current, fallbackCacheKey, { payload: latePayload });
                const lateAlternatives = annotateAlternativeCandidates(latePayload.candidates || []);
                if (lateAlternatives.length === 0) return;
                setSearchError(null);
                setResults((currentResults) => {
                  const currentKmb = (currentResults || []).filter((route) => !isFallbackRoute(route));
                  return rankCombinedTransportOptions([...currentKmb, ...lateAlternatives]);
                });
                setIsSearchOpen(false);
              })
              .catch((error) => {
                console.warn('Other transport options could not finish loading:', error);
              });
          }

          if (finalResults.length === 0 && !fallbackTimedOut) {
            throw kmbSearchError || new Error(
              'No routes found. Try different locations or check if services are running.',
            );
          }

          if (canReusePlannedSearch) {
            searchCacheRef.current.set(searchCacheKey, cloneRouteResults(finalResults));
            if (searchCacheRef.current.size > 8) {
              const oldestKey = searchCacheRef.current.keys().next().value;
              searchCacheRef.current.delete(oldestKey);
            }
          }

          setResults(finalResults);
          setIsSearchOpen(false);

          if (!fallbackTimedOut && !cachedFallback?.refined && alternatives.length > 0) {
            refineFallbackCandidateRideTimes(alternatives, {
              maxRefinements: fallbackSettings.googleRefineLimit,
              timeMode,
              dateValue,
              timeValue,
            }).then((refinedAlternatives) => {
              if (searchRunRef.current !== searchRunId) return;
              const refinedPayload = {
                ...fallbackPayload,
                candidates: refinedAlternatives,
                refined_at: new Date().toISOString(),
              };
              setCachedFallback(fallbackCacheRef.current, fallbackCacheKey, {
                payload: refinedPayload,
                refined: true,
              });
              setResults((currentResults) => {
                const currentKmb = currentResults.filter((route) => !isFallbackRoute(route));
                return rankCombinedTransportOptions([
                  ...currentKmb,
                  ...annotateAlternativeCandidates(refinedAlternatives),
                ]);
              });
            }).catch(() => {
              // Keep fast local alternatives if Google ride-time refinement fails.
            });
          }

          return;
        } catch (fallbackError) {
          if (!hasValidKmb) throw fallbackError;
          const previousAlternatives = preserveExistingResults
            ? (results || []).filter((route) => isFallbackRoute(route))
            : [];
          finalResults = rankCombinedTransportOptions([
            ...filteredCandidates,
            ...previousAlternatives,
          ]);
          console.warn('Other transport options could not load:', fallbackError);
        }
      }

      if (finalResults.length === 0) {
        throw kmbSearchError || new Error(
          'No routes found. Try different locations or check if services are running.',
        );
      }

      if (canReusePlannedSearch) {
        searchCacheRef.current.set(searchCacheKey, cloneRouteResults(finalResults));
        if (searchCacheRef.current.size > 8) {
          const oldestKey = searchCacheRef.current.keys().next().value;
          searchCacheRef.current.delete(oldestKey);
        }
      }

      setResults(finalResults);
      setIsSearchOpen(false);
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setIsLoading(false);
      setLoadingStatus('');
    }
  };

  // Draw route on map
  const drawRouteOnMap = async (route) => {
    if (isFallbackRoute(route)) {
      drawFallbackRouteOnMap(route);
      return;
    }
    clearMapGraphics();
    const { Graphic, Polyline, Point, Extent } = arcgisModulesRef.current || {};
    const layer = graphicsLayerRef.current;
    const view = viewRef.current;
    if (!layer || !view || !Graphic) return;

    let allLats = [];
    let allLngs = [];

    const drawPoly = (geometry, color, width = 6, style = 'solid') => {
      if (!geometry || geometry.length < 2) return;
      const paths = geometry.map(([ln, la]) => [ln, la]);
      layer.add(
        new Graphic({
          geometry: new Polyline({
            paths: [paths],
            spatialReference: { wkid: 4326 },
          }),
          symbol: { type: 'simple-line', color, width, style },
        }),
      );
    };

    const addMarker = (lat, lng, color, nameEn, nameTc, size = 10, isTerminal = false) => {
      layer.add(
        new Graphic({
          geometry: new Point({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
          symbol: {
            type: 'simple-marker',
            style: 'circle',
            color: isTerminal ? color : [255, 255, 255],
            size,
            outline: { color, width: isTerminal ? 3 : 2 },
          },
          popupTemplate: { title: nameEn, content: nameTc },
        }),
      );
      allLats.push(lat);
      allLngs.push(lng);
    };

    if (route.walkInfoOrigin?.geometry) {
      drawPoly(route.walkInfoOrigin.geometry, [100, 100, 100, 0.8], 4, 'short-dot');
      allLats.push(route.originLoc.lat);
      allLngs.push(route.originLoc.lng);
      layer.add(
        new Graphic({
          geometry: new Point({
            x: route.originLoc.lng,
            y: route.originLoc.lat,
            spatialReference: { wkid: 4326 },
          }),
          symbol: {
            type: 'simple-marker',
            color: [34, 197, 94],
            size: 14,
            outline: { color: [255, 255, 255], width: 3 },
          },
        }),
      );
    }

    const routeSegments = route.segments || [];
    for (let si = 0; si < routeSegments.length; si++) {
      const seg = routeSegments[si];
      const color = ROUTE_COLORS[si % ROUTE_COLORS.length];
      const segStops = seg.stops.map((id) => stopMapRef.current[id]).filter(Boolean);

      if (segStops.length >= 2) {
        const start = segStops[0];
        const end = segStops[segStops.length - 1];
        const intermediates = segStops.slice(1, -1);
        const roadInfo = await window.routeEngine.fetchGCPRoute(
          start.lat,
          start.lng,
          end.lat,
          end.lng,
          'driving',
          intermediates,
        );
        drawPoly(roadInfo.geometry, color, 6, 'solid');
      }
      segStops.forEach((s, idx) => {
        const isTerm = idx === 0 || idx === segStops.length - 1;
        addMarker(s.lat, s.lng, color, s.name_en, s.name_tc, isTerm ? 12 : 8, isTerm);
      });
      if (si < routeSegments.length - 1 && route.walkInfoTransfer?.geometry)
        drawPoly(route.walkInfoTransfer.geometry, [100, 100, 100, 0.8], 4, 'short-dot');
    }

    if (route.walkInfoDest?.geometry) {
      drawPoly(route.walkInfoDest.geometry, [100, 100, 100, 0.8], 4, 'short-dot');
      allLats.push(route.destLoc.lat);
      allLngs.push(route.destLoc.lng);
      layer.add(
        new Graphic({
          geometry: new Point({
            x: route.destLoc.lng,
            y: route.destLoc.lat,
            spatialReference: { wkid: 4326 },
          }),
          symbol: {
            type: 'simple-marker',
            color: [239, 68, 68],
            size: 14,
            outline: { color: [255, 255, 255], width: 3 },
          },
        }),
      );
    }

    if (allLats.length > 0) {
      const minLat = Math.min(...allLats);
      const maxLat = Math.max(...allLats);
      const minLng = Math.min(...allLngs);
      const maxLng = Math.max(...allLngs);
      const { Extent: ExtentClass } = arcgisModulesRef.current;
      view.goTo(
        new ExtentClass({
          xmin: minLng - 0.005,
          ymin: minLat - 0.005,
          xmax: maxLng + 0.005,
          ymax: maxLat + 0.005,
          spatialReference: { wkid: 4326 },
        }).expand(1.1),
      );
    }
  };

  // Select route handler
  const handleSelectRoute = (cardOrRoute) => {
    const isCard = Boolean(cardOrRoute?.representative && cardOrRoute?.segmentDisplay);
    const baseRoute = isCard ? cardOrRoute.representative : cardOrRoute;
    if (!baseRoute) return;
    const initialSegmentDisplay = isCard ? cardOrRoute.segmentDisplay : baseRoute.segments || [];

    setSelectedRoute({ ...baseRoute, segmentDisplay: initialSegmentDisplay });
    setExpandedSegments(new Set());
    drawRouteOnMap(baseRoute);
  };

  const handleRefreshEtaSession = useCallback(async () => {
    if (isLoading || isRefreshingEta || results.length === 0) return;

    setIsRefreshingEta(true);
    setRefreshFeedback({
      type: 'loading',
      message: 'Refreshing arrival times...',
    });

    try {
      window.routeEngine?.clearETACache?.();
      const refreshedResults = (
        await Promise.all(results.map((route) => refreshRouteTiming(route)))
      ).filter(Boolean);

      setResults(refreshedResults);

      if (refreshedResults.length === 0) {
        setSelectedRoute(null);
        clearMapGraphics();
        setRefreshFeedback({
          type: 'error',
          message: 'No catchable routes are available right now.',
        });
        return;
      }

      if (selectedRoute) {
        const latestBaseRoute =
          refreshedResults.find((route) => route.id === selectedRoute.id) || selectedRoute;
        const refreshedSelectedRoute = refreshedResults.find(
          (route) => route.id === selectedRoute.id,
        );

        if (!refreshedSelectedRoute) {
          setSelectedRoute(null);
          clearMapGraphics();
        } else {
          setSelectedRoute({
            ...selectedRoute,
            ...latestBaseRoute,
            segmentDisplay: isFallbackRoute(latestBaseRoute)
              ? selectedRoute.segmentDisplay || []
              : latestBaseRoute.segments || [],
          });
        }
      }

      const refreshedAt = new Date();
      setLastEtaRefreshAt(refreshedAt);
      setRefreshFeedback({
        type: 'success',
        message: `Updated at ${formatRefreshTime(refreshedAt)}`,
      });
    } catch {
      setRefreshFeedback({
        type: 'error',
        message: 'Refresh failed. Please try again.',
      });
    } finally {
      setIsRefreshingEta(false);
    }
  }, [
    formatRefreshTime,
    isLoading,
    isRefreshingEta,
    refreshRouteTiming,
    results,
    selectedRoute,
  ]);

  // Add to bookmark
  const handleAddToBookmark = (stopId, stopName, routesAtStop) => {
    setAddToBookmark({ stopId, stopName, routes: routesAtStop });
  };

  const confirmAddBookmark = (groupIndex) => {
    const updated = window.bookmarkEngine.addStop(bookmarks, groupIndex, addToBookmark);
    setBookmarks(updated);
    setAddToBookmark(null);
  };

  const downloadEtaCallLog = useCallback(() => {
    const text =
      window.routeEngine?.formatEtaCallLogTxt?.() ||
      'No ETA calls captured in this session.';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kmb-eta-call-log.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleSwapLocations = () => {
    const fromValue = origin;
    const toValue = destination;
    setOrigin(toValue);
    setDestination(fromValue);
  };

  const zoomToLocation = useCallback((lat, lng) => {
    const view = viewRef.current;
    if (!view) return;
    const Point = arcgisModulesRef.current?.Point;
    const target = Point
      ? new Point({ x: lng, y: lat, spatialReference: { wkid: 4326 } })
      : { longitude: lng, latitude: lat };
    view.goTo({ target, zoom: 16 }).catch(() => {});
  }, []);

  const handleUseCurrentLocation = async () => {
    if (!navigator.geolocation) {
      setSearchError('GPS is not supported on this device/browser.');
      return;
    }
    setIsLocating(true);
    setSearchError(null);
    try {
      const position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 30000,
        }),
      );
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      setOrigin(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
      zoomToLocation(lat, lng);
    } catch (err) {
      const msg =
        err?.code === 1
          ? 'Location permission denied. Please allow GPS permission.'
          : err?.code === 2
            ? 'Unable to get current location.'
            : err?.code === 3
              ? 'GPS request timed out. Please try again.'
              : 'Failed to get current location.';
      setSearchError(msg);
    } finally {
      setIsLocating(false);
    }
  };

  const detailSegments = selectedRoute?.segmentDisplay || selectedRoute?.segments || [];

  useEffect(() => {
    if (results.length === 0) setIsResultsMinimized(false);
  }, [results.length]);

  useEffect(() => {
    if (isSearchOpen && results.length > 0 && !selectedRoute && !showBookmarks) {
      setIsResultsMinimized(true);
    }
  }, [isSearchOpen, results.length, selectedRoute, showBookmarks]);

  useEffect(() => {
    if (!refreshFeedback) return;
    const timeout = setTimeout(() => setRefreshFeedback(null), 5000);
    return () => clearTimeout(timeout);
  }, [refreshFeedback]);

  // RENDER
  return (
    <div className="relative h-full w-full bg-slate-100 flex flex-col font-sans">
      <div ref={mapRef} className="absolute inset-0 z-0" />

      {/* Header */}
      <div
        className={`absolute top-0 left-0 right-0 z-20 p-4 transition-all ${
          isSearchOpen ? 'bg-white shadow-xl' : ''
        }`}
      >
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 bg-white/80 backdrop-blur p-2 rounded-2xl border border-white/50 shadow-sm">
            {/* Replaced CSS Icon with PWA Image */}
            <img src="/pwa-192x192.png" alt="KMB Bus" className="w-10 h-10 rounded-xl shadow-sm object-contain" />
            
            <h1 className="text-xl font-black italic uppercase tracking-tighter">
              KMB <span className="text-[#E1251B]">Route Master</span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setShowBookmarks((v) => !v);
                setIsSearchOpen(false);
              }}
              className="p-3 bg-white rounded-2xl shadow-md text-xl"
              title="Bookmarks"
            >
              {'\u2B50'}
            </button>
            <button
              onClick={() => {
                setIsSearchOpen((v) => {
                  const next = !v;
                  if (next && results.length > 0 && !selectedRoute && !showBookmarks) {
                    setIsResultsMinimized(true);
                  }
                  return next;
                });
                setShowBookmarks(false);
              }}
              className="p-3 bg-white rounded-2xl shadow-md text-xl"
            >
              {isSearchOpen ? '\u2715' : '\uD83D\uDD0D'}
            </button>
          </div>
        </div>

        {isSearchOpen && (
          <form onSubmit={handleSearch} className="max-w-xl mx-auto mt-4 space-y-3">
            <div className="bg-slate-50 p-2 rounded-2xl flex items-center justify-between border border-slate-200">
              <div className="flex gap-2">
                {['now', 'leave', 'arrive'].map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setTimeMode(mode)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
                      timeMode === mode
                        ? 'bg-[#E1251B] text-white'
                        : 'bg-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {mode === 'now' ? 'Now' : mode === 'leave' ? 'Leave At' : 'Arrive By'}
                  </button>
                ))}
              </div>
              {timeMode !== 'now' && (
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    value={timeValue}
                    onChange={(e) => setTimeValue(e.target.value)}
                    className="bg-transparent text-sm font-bold text-slate-700 outline-none cursor-pointer"
                  />
                  <input
                    type="date"
                    value={dateValue}
                    onChange={(e) => setDateValue(e.target.value)}
                    className="bg-transparent text-sm font-bold text-slate-700 outline-none w-5 cursor-pointer"
                    style={{ color: 'transparent', textShadow: '0 0 0 #334155' }}
                  />
                </div>
              )}
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 items-start">
              <div className="space-y-3">
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <AutocompleteInput
                    placeholder="From... (e.g. Mong Kok)"
                    value={origin}
                    onChange={setOrigin}
                    onClear={() => setOrigin('')}
                  />
                  <button
                    type="button"
                    onClick={handleUseCurrentLocation}
                    disabled={isLocating}
                    className="h-[52px] px-3 rounded-xl bg-white border border-slate-200 text-xs font-bold text-slate-600 hover:text-[#E1251B] hover:border-[#E1251B] transition disabled:opacity-50"
                    title="Use current GPS location"
                  >
                    {isLocating ? 'Locating...' : 'Use GPS'}
                  </button>
                </div>
                <AutocompleteInput
                  placeholder="To... (e.g. Tsim Sha Tsui)"
                  value={destination}
                  onChange={setDestination}
                  onClear={() => setDestination('')}
                />
              </div>
              <button
                type="button"
                onClick={handleSwapLocations}
                className="h-[52px] px-3 rounded-xl bg-white border border-slate-200 text-xs font-bold text-slate-600 hover:text-[#E1251B] hover:border-[#E1251B] transition"
                title="Swap From and To"
              >
                Swap
              </button>
            </div>
            <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white/90 p-3 text-xs font-bold text-slate-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allowFallbackNonKmb}
                onChange={(e) => setAllowFallbackNonKmb(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#E1251B] focus:ring-[#E1251B]"
              />
              <span className="leading-snug">
                Include other transport options with KMB
                <span className="block text-[11px] font-semibold text-slate-400">
                  Compare KMB with Citybus, Tram, and MTR by known fare, estimated time, and transfers.
                </span>
              </span>
            </label>
            <button
              type="submit"
              disabled={isLoading || !dataLoaded}
              className="w-full py-4 bg-[#E1251B] text-white rounded-2xl font-black italic uppercase shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <span className="animate-spin">{'\u23F3'}</span> {loadingStatus || 'Searching...'}
                </>
              ) : !dataLoaded ? (
                <>
                  <span className="animate-pulse">{'\u{1F4E1}'}</span> {loadingStatus}
                </>
              ) : (
                'Search Routes'
              )}
            </button>
            {searchError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm font-bold">
                {'\u26A0\uFE0F'} {searchError}
              </div>
            )}
          </form>
        )}
      </div>

      {/* Loading overlay */}
      {!dataLoaded && !isSearchOpen && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 bg-white/90 backdrop-blur px-6 py-4 rounded-2xl shadow-xl text-sm font-bold text-slate-600">
          {'\u{1F5FA}\uFE0F'} {loadingStatus}
        </div>
      )}

      {/* Bookmark panel */}
      {showBookmarks && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl max-h-[60vh] overflow-y-auto scrollbar-hide slide-up">
          <BookmarkPanel
            stopMap={stopMapRef.current}
            onClose={() => setShowBookmarks(false)}
            bookmarks={bookmarks}
            setBookmarks={setBookmarks}
          />
        </div>
      )}

      {/* Results panel */}
      {results.length > 0 && !selectedRoute && !showBookmarks && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl scrollbar-hide slide-up flex flex-col ${
            isResultsMinimized ? 'max-h-[110px] overflow-hidden' : 'max-h-[70vh] md:max-h-[60vh] overflow-y-auto'
          }`}
        >
          <div className="mb-3 shrink-0 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest">
                {displayedResultCards.length} Route{displayedResultCards.length > 1 ? 's' : ''}{' '}
                Found
              </h2>
              {lastEtaRefreshAt && (
                <div className="text-[11px] text-slate-500 font-semibold mt-1">
                  Last refreshed: {formatRefreshTime(lastEtaRefreshAt)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleRefreshEtaSession}
                disabled={isRefreshingEta || isLoading}
                className="text-[11px] font-bold text-[#E1251B] border border-[#E1251B]/30 rounded-lg px-2 py-1 hover:bg-[#E1251B]/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isRefreshingEta ? 'Refreshing...' : 'Refresh ETA'}
              </button>
              <button
                type="button"
                onClick={() => setIsResultsMinimized((v) => !v)}
                className="text-[11px] font-bold text-slate-500 hover:text-[#E1251B] border border-slate-200 rounded-lg px-2 py-1"
              >
                {isResultsMinimized ? 'Expand' : 'Minimize'}
              </button>
            </div>
          </div>
          {refreshFeedback && (
            <div
              aria-live="polite"
              className={`mb-3 p-2 border rounded-xl text-xs font-bold ${refreshStatusClass}`}
            >
              {refreshFeedback.message}
            </div>
          )}
          {!isResultsMinimized && (
            <>
          <label className="mb-3 shrink-0 flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs font-bold text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowFallbackNonKmb}
              onChange={(e) => {
                const next = e.target.checked;
                setAllowFallbackNonKmb(next);
                if (!isLoading) {
                  setTimeout(
                    () => handleSearch(null, {
                      allowFallbackNonKmb: next,
                      preserveExistingResults: next,
                    }),
                    0,
                  );
                }
              }}
              disabled={isLoading}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-[#E1251B] focus:ring-[#E1251B] disabled:opacity-50"
            />
            <span className="leading-snug">
              Include other transport options with KMB
              <span className="block text-[11px] font-semibold text-slate-400">
                Re-runs this search with Citybus, Tram, and MTR alternatives for comparison.
              </span>
            </span>
          </label>
          <label className="mb-3 shrink-0 flex items-center gap-2 text-xs font-bold text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={strictEtaOnly}
              onChange={(e) => {
                const next = e.target.checked;
                setStrictEtaOnly(next);
                if (!isLoading) {
                  setTimeout(
                    () => handleSearch(null, {
                      strictEtaOnly: next,
                      allowFallbackNonKmb,
                      preserveExistingResults: true,
                    }),
                    0,
                  );
                }
              }}
              disabled={timeMode !== 'now'}
              className="h-4 w-4 rounded border-slate-300 text-[#E1251B] focus:ring-[#E1251B]"
            />
            {timeMode === 'now'
              ? 'Strict ETA filter (show only routes where every segment has active ETA now)'
              : 'Strict ETA filter is available only for Now mode'}
          </label>
          <div className="mb-3 shrink-0">
            <button
              onClick={downloadEtaCallLog}
              className="text-[11px] font-bold text-[#E1251B] hover:underline"
            >
              Download KMB ETA call log (.txt)
            </button>
          </div>

          {/* Filter Section */}
          {/* <div className="mb-4 shrink-0 bg-slate-50 p-3 rounded-2xl border border-slate-200">
            <div className="text-xs font-bold text-slate-500 mb-2 flex justify-between items-center">
              <span>FILTER ROUTES</span>
              {excludedRoutesText && (
                <button
                  onClick={() => {
                    setExcludedRoutesText('');
                    setTimeout(() => handleSearch(), 0);
                  }}
                  className="text-[#E1251B] hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2 mb-2">
              {availableFilterRoutes
                .map((r) => {
                  const isExcluded = excludedRoutesText
                    .toUpperCase()
                    .split(/[\s,]+/)
                    .includes(r.toUpperCase());
                  return (
                    <button
                      key={r}
                      onClick={() => {
                        let current = excludedRoutesText
                          .toUpperCase()
                          .split(/[\s,]+/)
                          .filter(Boolean);
                        if (isExcluded) current = current.filter((x) => x !== r);
                        else current.push(r.toUpperCase());
                        const newText = current.join(', ');
                        setExcludedRoutesText(newText);
                      }}
                      className={`px-3 py-1 rounded-lg text-sm font-bold transition-all border ${
                        isExcluded
                          ? 'bg-slate-200 text-slate-400 border-slate-300'
                          : 'bg-white text-slate-700 border-slate-300 hover:border-[#E1251B] hover:text-[#E1251B]'
                      }`}
                    >
                      {r} {isExcluded && '\u2715'}
                    </button>
                  );
                })}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Or type routes to hide..."
                value={excludedRoutesText}
                onChange={(e) => setExcludedRoutesText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 p-3 bg-white rounded-xl font-bold border border-slate-200 uppercase placeholder:normal-case focus:ring-2 focus:ring-[#E1251B]/50 outline-none text-sm"
              />
              <button
                onClick={() => handleSearch()}
                disabled={isLoading}
                className="px-4 bg-[#E1251B] text-white rounded-xl font-bold text-sm hover:bg-red-700 transition"
              >
                Apply
              </button>
            </div>
          </div> */}
        {/* Filter Section - Expandable */}
        <div className="mb-4 shrink-0 bg-white/80 backdrop-blur rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Accordion Header */}
        <button 
            onClick={() => setIsFilterExpanded(!isFilterExpanded)}
            className="w-full flex items-center justify-between p-3 hover:bg-slate-50 transition-colors"
        >
            <div className="flex items-center gap-2">
            <span className="text-sm">{'\u{1F9EA}'}</span>
            <span className="text-xs font-black italic uppercase tracking-tighter text-slate-800">Filter Routes</span>
            </div>
            <div className="flex items-center gap-3">
            {excludedRoutesText && !isFilterExpanded && (
                <span className="text-[10px] bg-red-50 text-[#E1251B] px-2 py-0.5 rounded-full font-bold border border-red-100">
                Active Filters
                </span>
            )}
            <span className={`text-[#E1251B] text-xs font-bold transform transition-transform duration-300 ${isFilterExpanded ? 'rotate-180' : ''}`}>
                {isFilterExpanded ? '\u25B2' : '\u25BC'}
            </span>
            </div>
        </button>

        {/* Expandable Content */}
        {isFilterExpanded && (
            <div className="p-3 pt-0 border-t border-slate-100 bg-slate-50/50">
            <div className="text-[10px] font-bold text-slate-400 mt-2 mb-2 flex justify-between items-center uppercase tracking-widest">
                <span>Quick Select to Hide</span>
                {excludedRoutesText && (
                <button
                    onClick={() => {
                    setExcludedRoutesText('');
                    // Optional: auto-search after clear
                    setTimeout(() => handleSearch(), 0);
                    }}
                    className="text-[#E1251B] hover:underline normal-case"
                >
                    Clear All
                </button>
                )}
            </div>

            <div className="flex flex-wrap gap-2 mb-3">
                {availableFilterRoutes
                .map((r) => {
                    const isExcluded = excludedRoutesText
                    .toUpperCase()
                    .split(/[\s,]+/)
                    .includes(r.toUpperCase());
                    return (
                    <button
                        key={r}
                        onClick={() => {
                        let current = excludedRoutesText
                            .toUpperCase()
                            .split(/[\s,]+/)
                            .filter(Boolean);
                        if (isExcluded) current = current.filter((x) => x !== r);
                        else current.push(r.toUpperCase());
                        setExcludedRoutesText(current.join(', '));
                        }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border shadow-sm ${
                        isExcluded
                            ? 'bg-slate-200 text-slate-400 border-slate-300'
                            : 'bg-white text-slate-700 border-slate-200 hover:border-[#E1251B] hover:text-[#E1251B]'
                        }`}
                    >
                        {r} {isExcluded ? '\u2715' : '+'}
                    </button>
                    );
                })}
            </div>

            <div className="flex gap-2">
                <input
                type="text"
                placeholder="Or type routes (e.g. 960, 968)..."
                value={excludedRoutesText}
                onChange={(e) => setExcludedRoutesText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="flex-1 p-2.5 bg-white rounded-xl font-bold border border-slate-200 uppercase placeholder:normal-case focus:ring-2 focus:ring-[#E1251B]/50 outline-none text-xs"
                />
                <button
                onClick={() => {
                    setIsFilterExpanded(false); // Auto-collapse on apply
                    handleSearch();
                }}
                disabled={isLoading}
                className="px-4 bg-[#E1251B] text-white rounded-xl font-bold text-xs hover:bg-red-700 transition shadow-md active:scale-95"
                >
                Apply
                </button>
            </div>
            </div>
        )}
        </div>

          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-hide">
            {displayedResultCards.length === 0 && strictEtaOnly && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl text-xs font-bold text-amber-700">
                No routes match strict ETA filter right now. Try turning off strict ETA filter.
              </div>
            )}
            {displayedResultCards.map((card) => (
              card.type === 'fallback' ? (
                <div
                  key={card.key}
                  className="p-4 bg-blue-50 rounded-2xl border-2 border-blue-100 cursor-pointer hover:border-blue-500 transition-colors"
                  onClick={() => handleSelectRoute(card)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="mb-2 text-[11px] font-black uppercase tracking-wide text-blue-700">
                        {card.representative.optionLabel || 'Alternative transport option'}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-black text-lg text-slate-800">
                          {card.representative.route || card.representative.line}
                        </span>
                        {parseOperatorCodes(card.representative.operator).map((operatorCode) => (
                          <span
                            key={operatorCode}
                            className={`px-1 py-[1px] rounded text-[9px] leading-none font-black ${getOperatorBadgeClass(operatorCode)}`}
                          >
                            {getOperatorDisplayName(operatorCode)}
                          </span>
                        ))}
                      </div>
                      <div className="text-xs text-slate-500 mt-2 flex flex-wrap gap-2">
                        <span>
                          {card.representative.transfers === 0
                            ? 'Direct'
                            : `${card.representative.transfers} transfer${card.representative.transfers > 1 ? 's' : ''}`}
                        </span>
                        <span>{'\u00B7'} Walk {card.representative.walk_distance_m}m</span>
                        <span>{'\u00B7'} {formatFare(card.representative.fare)}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-blue-700 font-bold text-lg">
                        ~{card.representative.estimated_time_min}min
                      </div>
                      <div className="text-[11px] text-slate-400 font-bold">
                        confidence {Math.round((card.representative.confidence || 0) * 100)}%
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key={card.key}
                  className="p-4 bg-slate-50 rounded-2xl border-2 border-slate-100 cursor-pointer hover:border-[#E1251B] transition-colors"
                  onClick={() => handleSelectRoute(card)}
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-black text-lg flex items-center gap-2 flex-wrap">
                        {card.segmentDisplay.map((seg, si) => (
                          <React.Fragment key={si}>
                            {si > 0 && <span className="text-slate-300 text-sm">{'\u2192'}</span>}
                            <div className="flex flex-col items-start gap-1">
                              <div className="flex items-center gap-1.5">
                                <span
                                  className="px-2 py-0.5 rounded-lg text-white text-sm"
                                  style={{
                                    backgroundColor: ROUTE_COLORS[si % ROUTE_COLORS.length],
                                  }}
                                >
                                  {seg.routeLabel || seg.route}
                                </span>
                              </div>
                              {seg.routeOptions && seg.routeOptions.length > 0 ? (
                                <div className="flex flex-wrap gap-1 max-w-full sm:max-w-[220px]">
                                  {seg.routeOptions.map((option) => (
                                    <span
                                      key={`${option.route}|${option.service_type || '1'}`}
                                      className={`text-[10px] leading-none whitespace-nowrap px-2 py-1 rounded-full border ${getEtaChipClass(option.nextEta)}`}
                                    >
                                      {option.route}: {getEtaText(option.nextEta)}
                                    </span>
                                  ))}
                                </div>
                              ) : seg.nextEta ? (
                                <span className="text-[10px] text-[#E1251B] leading-none whitespace-nowrap">
                                  Next bus: {getEtaText(seg.nextEta)}
                                </span>
                              ) : seg.busInterval ? (
                                <span className="text-[10px] text-slate-400 leading-none whitespace-nowrap">
                                  Next bus: ~{seg.busInterval} mins
                                </span>
                              ) : null}
                            </div>
                          </React.Fragment>
                        ))}
                      </div>
                      <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-2">
                        <span>
                          {card.representative.transfers === 0
                            ? 'Direct'
                            : `${card.representative.transfers} transfer${card.representative.transfers > 1 ? 's' : ''}`}
                        </span>
                        <span>{'\u00B7'} {card.representative.totalStops} stops</span>
                        {card.representative.walkTimeOrigin > 0 && (
                          <span>{'\u00B7'} {'\u{1F6B6}'} {card.representative.walkTimeOrigin}min walk</span>
                        )}
                        {card.representative.originWaitTime > 0 && (
                          <span>{'\u00B7'} {'\u23F1'} {card.representative.originWaitTime}min wait</span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[#E1251B] font-bold text-lg">
                        ~{card.representative.estimatedTime}min
                      </div>
                    </div>
                  </div>
                </div>
              )
            ))}
          </div>
            </>
          )}
        </div>
      )}

      {/* Selected fallback detail */}
      {selectedRoute && isFallbackRoute(selectedRoute) && !showBookmarks && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl max-h-[70vh] md:max-h-[55vh] overflow-y-auto scrollbar-hide slide-up">
          <div className="flex items-center justify-between gap-3 mb-3">
            <button
              onClick={() => {
                setSelectedRoute(null);
                clearMapGraphics();
              }}
              className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"
            >
              {'\u2190'} Back
            </button>
            <span className="text-[11px] font-black uppercase tracking-wide text-blue-700">
              {selectedRoute.optionLabel || 'Alternative transport option'}
            </span>
          </div>

          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <span className="px-3 py-1 rounded-xl bg-blue-600 text-white font-black text-sm">
                  {selectedRoute.operator}
                </span>
                <span className="font-black text-xl text-slate-800">
                  {selectedRoute.route || selectedRoute.line}
                </span>
              </div>
              <div className="text-xs text-slate-500 font-semibold">
                {selectedRoute.journey_type === 'direct' ? 'Direct other transport option' : 'Other transport option with transfer'}
              </div>
            </div>
            <div className="text-right">
              <div className="text-blue-700 font-bold text-xl">~{selectedRoute.estimated_time_min}min</div>
              <div className="text-sm font-black text-slate-700">{formatFare(selectedRoute.fare)}</div>
            </div>
          </div>

          <div className="mb-4 rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs font-bold text-blue-800">
            Shown because you chose to compare KMB with other transport options.
          </div>

          <div className="space-y-3">
            {(selectedRoute.legs || []).map((leg, index) => (
              <div key={`${leg.route_variant_id}-${index}`} className="pl-3 border-l-4 border-blue-500 py-2">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded-lg bg-blue-600 text-white text-xs font-black">
                    {leg.operator}
                  </span>
                  <span className="text-sm font-black text-slate-800">{leg.route || leg.line}</span>
                  <span className="text-xs font-bold text-slate-500">{formatFare(leg.fare)}</span>
                </div>
                <div className="text-sm font-bold text-slate-700">
                  {leg.origin_stop?.name?.tc || leg.origin_stop?.name?.en || leg.origin_stop?.stop_id}
                  <span className="mx-2 text-slate-300">{'\u2192'}</span>
                  {leg.destination_stop?.name?.tc || leg.destination_stop?.name?.en || leg.destination_stop?.stop_id}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {leg.stop_count} stops {'\u00B7'} ride estimate {leg.estimated_ride_time_min} min
                </div>
                {index < (selectedRoute.transfer_stops || []).length && (
                  <div className="mt-2 text-xs font-bold text-slate-500">
                    Transfer walk: {selectedRoute.transfer_stops[index].walk_distance_m}m
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="mt-4 text-xs text-slate-500 font-semibold">
            Access walking: {selectedRoute.walk_distance_m}m {'\u00B7'} Confidence {Math.round((selectedRoute.confidence || 0) * 100)}%
          </div>
        </div>
      )}

      {/* Selected route detail */}
      {selectedRoute && !isFallbackRoute(selectedRoute) && !showBookmarks && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl max-h-[70vh] md:max-h-[55vh] overflow-y-auto scrollbar-hide slide-up">
          <div className="flex items-center justify-between gap-3 mb-3">
            <button
              onClick={() => {
                setSelectedRoute(null);
                clearMapGraphics();
              }}
              className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2"
            >
              {'\u2190'} Back
            </button>
            <button
              type="button"
              onClick={handleRefreshEtaSession}
              disabled={isRefreshingEta || isLoading}
              className="text-[11px] font-bold text-[#E1251B] border border-[#E1251B]/30 rounded-lg px-2 py-1 hover:bg-[#E1251B]/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRefreshingEta ? 'Refreshing...' : 'Refresh ETA'}
            </button>
          </div>
          {lastEtaRefreshAt && (
            <div className="text-[11px] text-slate-500 font-semibold mb-2">
              Last refreshed: {formatRefreshTime(lastEtaRefreshAt)}
            </div>
          )}
          {refreshFeedback && (
            <div
              aria-live="polite"
              className={`mb-3 p-2 border rounded-xl text-xs font-bold ${refreshStatusClass}`}
            >
              {refreshFeedback.message}
            </div>
          )}

          <div className="flex items-center gap-3 mb-3">
            {detailSegments.map((seg, si) => (
              <React.Fragment key={si}>
                {si > 0 && <span className="text-slate-300">{'\u2192'}</span>}
                <span
                  className="px-3 py-1 rounded-xl text-white font-black text-lg"
                  style={{ backgroundColor: ROUTE_COLORS[si % ROUTE_COLORS.length] }}
                >
                  {seg.routeLabel || seg.route}
                </span>
              </React.Fragment>
            ))}
            <span className="ml-auto text-[#E1251B] font-bold text-xl">
              ~{selectedRoute.estimatedTime}min
            </span>
          </div>

          {selectedRoute.walkTimeOrigin > 0 && (
            <div className="flex items-center gap-2 text-sm text-slate-500 mb-2 pl-2 border-l-2 border-dashed border-slate-300">
              {'\u{1F6B6}'} Walk {selectedRoute.walkTimeOrigin} min to stop
            </div>
          )}

          {(selectedRoute.segments || []).map((seg, si) => {
            const displaySeg = detailSegments[si] || seg;
            const fromStop = stopMapRef.current[seg.fromStop];
            const toStop = stopMapRef.current[seg.toStop];
            const nextSegment = detailSegments[si + 1] || (selectedRoute.segments || [])[si + 1];
            const transferWalkMinutes = si === 0
              ? selectedRoute.walkTimeTransfer
              : selectedRoute.walkTimeTransfer2;
            const transferArrivalClock = formatClockTime(displaySeg.arrivalTime || seg.arrivalTime);
            const nextBoardClock = formatClockTime(
              nextSegment?.boardTime || nextSegment?.nextEta,
            );
            const color = ROUTE_COLORS[si % ROUTE_COLORS.length];
            const routesAtFromStop = (stopRoutesRef.current[seg.fromStop] || []).map((r) => ({
              route: r.route,
              service_type: r.service_type,
            }));
            return (
              <div key={si} className="mb-2">
                <div className="pl-2 border-l-4 py-2" style={{ borderColor: color }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-2 py-0.5 rounded-lg text-white text-xs font-bold" style={{ backgroundColor: color }}>
                      {displaySeg.routeLabel || seg.route}
                    </span>
                    <span className="text-xs text-slate-500">
                      {seg.routeInfo?.orig_tc} {'\u2192'} {seg.routeInfo?.dest_tc}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold">{'\u{1F4CD}'} {fromStop?.name_tc || fromStop?.name_en}</div>
                    <button
                      onClick={() =>
                        handleAddToBookmark(seg.fromStop, fromStop?.name_tc || fromStop?.name_en, routesAtFromStop)
                      }
                      className="text-xs text-slate-400 hover:text-yellow-500"
                      title="Bookmark this stop"
                    >
                      {'\u2B50'}
                    </button>
                  </div>
                  <div
                    className="text-xs text-slate-400 my-1 cursor-pointer hover:text-slate-600 flex flex-col gap-1"
                    onClick={() => {
                      const newExp = new Set(expandedSegments);
                      newExp.has(si) ? newExp.delete(si) : newExp.add(si);
                      setExpandedSegments(newExp);
                    }}
                  >
                    <div className="flex items-center gap-1 font-bold">
                      {expandedSegments.has(si) ? '\u25B2' : '\u25BC'} {seg.stops.length - 2} intermediate
                      stops
                    </div>
                    <div className="flex font-normal flex-wrap gap-2">
                      {displaySeg.routeOptions && displaySeg.routeOptions.length > 0 ? (
                        displaySeg.routeOptions.map((option) => (
                          <span
                            key={`${option.route}|${option.service_type || '1'}`}
                            className={`text-[11px] px-2 py-1 rounded-full border ${getEtaChipClass(option.nextEta)}`}
                          >
                            {option.route}: {getEtaText(option.nextEta)}
                            {!option.nextEta && option.busInterval
                              ? ` (~${option.busInterval}min)`
                              : ''}
                          </span>
                        ))
                      ) : (
                        <>
                          {seg.nextEta && (
                            <span className="text-[#E1251B]">
                              Next: {new Date(seg.nextEta).toLocaleTimeString('en-HK', {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          )}
                          {seg.busInterval && (
                            <span className="text-slate-500">Every ~{seg.busInterval}min</span>
                          )}
                        </>
                      )}
                    </div>
                    {expandedSegments.has(si) && (
                      <div className="mt-2 py-2 border-l-2 border-dashed border-slate-200 pl-3 ml-1 space-y-2">
                        {seg.stops.slice(1, -1).map((stopId, stopIdx) => {
                          const stp = stopMapRef.current[stopId];
                          const rts = (stopRoutesRef.current[stopId] || []).map((r) => ({
                            route: r.route,
                            service_type: r.service_type,
                          }));
                          return (
                            <div
                              key={stopIdx}
                              className="flex items-center justify-between text-sm text-slate-600"
                            >
                              <span>
                                <span className="text-slate-300 mr-2">{'\u2022'}</span>
                                {stp?.name_tc || stp?.name_en}
                              </span>
                              <button
                                onClick={() =>
                                  handleAddToBookmark(
                                    stopId,
                                    stp?.name_tc || stp?.name_en,
                                    rts,
                                  )
                                }
                                className="text-xs text-slate-300 hover:text-yellow-500"
                              >
                                {'\u2B50'}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-bold flex items-center gap-2 flex-wrap">
                    <span>{'\u{1F3C1}'} {toStop?.name_tc || toStop?.name_en}</span>
                    {si < detailSegments.length - 1 && transferArrivalClock && (
                      <span className="text-[11px] font-bold px-2 py-1 rounded-full border border-red-100 bg-red-50 text-[#E1251B]">
                        Arrive {transferArrivalClock}
                      </span>
                    )}
                  </div>
                </div>
                {si < detailSegments.length - 1 && (
                  <div className="flex items-center gap-2 text-sm text-slate-500 my-2 pl-2 border-l-2 border-dashed border-slate-300">
                    {'\u{1F6B6}'} Transfer ({transferWalkMinutes || '?'} min walk)
                    {nextBoardClock && (
                      <span className="text-[11px] font-semibold text-slate-600">
                        {'\u00B7'} Next board {nextBoardClock}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {selectedRoute.walkTimeDest > 0 && (
            <div className="flex items-center gap-2 text-sm text-slate-500 mt-2 pl-2 border-l-2 border-dashed border-slate-300">
              {'\u{1F6B6}'} Walk {selectedRoute.walkTimeDest} min to destination
            </div>
          )}
        </div>
      )}

      {/* Add to Bookmark modal */}
      {addToBookmark && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-3xl p-6 mx-4 w-full max-w-xs shadow-2xl">
            <h3 className="font-black text-lg mb-1">{'\u2B50'} Add to Bookmark</h3>
            <p className="text-sm text-slate-500 mb-4">{addToBookmark.stopName}</p>
            {bookmarks.length === 0 && (
              <p className="text-sm text-slate-400 mb-3">
                No groups yet. Create one in the Bookmarks panel first.
              </p>
            )}
            <div className="space-y-2 max-h-48 overflow-y-auto scrollbar-hide">
              {bookmarks.map((g, gi) => (
                <button
                  key={gi}
                  onClick={() => confirmAddBookmark(gi)}
                  className="w-full text-left px-4 py-3 bg-slate-50 rounded-xl hover:bg-slate-100 font-bold text-sm"
                >
                  {g.groupName}
                </button>
              ))}
            </div>
            <button
              onClick={() => setAddToBookmark(null)}
              className="mt-4 w-full py-2 text-sm text-slate-400 font-bold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
