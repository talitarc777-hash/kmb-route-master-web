import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

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
  const res = await fetch(`/api/google/geocode/json?address=${encodeURIComponent(query)}&components=country:hk`);
  const data = await res.json();
  if (!data || data.status !== 'OK' || data.results.length === 0) return null;
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, name: query };
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

// Autocomplete Input Component
const AutocompleteInput = ({ value, onChange, placeholder }) => {
  const displayValue = typeof value === 'string' ? value : value?.name || '';
  const [suggestions, setSuggestions] = useState([]);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (displayValue.length < 2) {
        setSuggestions([]);
        return;
      }
      try {
        // const res = await fetch(
        //   `/api/google/place/autocomplete/json?input=${encodeURIComponent(
        //     displayValue,
        //   )}&components=country:hk&key=${GCP_API_KEY}`,
        // );
        // Ensure this URL matches the rewrite in vercel.json
        // Change ${input} to ${encodeURIComponent(displayValue)}
        const res = await fetch(`/api/google/place/autocomplete/json?input=${encodeURIComponent(displayValue)}&components=country:hk`);
        const data = await res.json();
        if (data.status === 'OK') setSuggestions(data.predictions.slice(0, 5));
        else setSuggestions([]);
      } catch (e) {
        // Handle error silently
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [value, displayValue]);

  return (
    <div className="relative w-full">
      <input
        className="w-full p-4 bg-slate-50 rounded-2xl font-bold border border-slate-200"
        placeholder={placeholder}
        value={displayValue}
        onChange={(e) => {
          onChange(e.target.value);
          setShow(true);
        }}
        onFocus={() => setShow(true)}
        onBlur={() => setTimeout(() => setShow(false), 200)}
      />
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
        <h2 className="font-black text-lg">⭐ Bookmarks</h2>
        <button onClick={onClose} className="text-slate-400 text-xl font-bold">
          ✕
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
                  {group.groupName} ✏️
                </span>
              )}
              <button
                onClick={() => {
                  const u = window.bookmarkEngine.deleteGroup(bookmarks, gi);
                  update(u);
                }}
                className="text-red-400 text-xs font-bold"
              >
                ✕
              </button>
            </div>

            {group.stops.length === 0 && (
              <div className="text-xs text-slate-300 mb-1">
                No stops yet. Add stops from route results.
              </div>
            )}

            {group.stops.map((s, si) => {
              const stopInfo = stopMap[s.stopId];
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
                      {etas.length === 0 && (
                        <span className="text-xs text-slate-300">Fetching ETAs...</span>
                      )}
                      {etas.slice(0, 4).map((e, ei) => (
                        <span
                          key={ei}
                          className={`text-xs font-bold px-2 py-0.5 rounded-full bg-white border eta-${e.color}`}
                        >
                          {e.route} · {e.waitMin <= 0 ? 'Arriving' : `${e.waitMin}min`}
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
                    ✕
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

  // Search handler
  const handleSearch = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!dataLoaded) return;
    setIsLoading(true);
    setSearchError(null);
    setResults([]);
    setSelectedRoute(null);
    clearMapGraphics();

    try {
      const [originLoc, destLoc] = await Promise.all([
        resolveLocation(origin),
        resolveLocation(destination),
      ]);

      setLoadingStatus('Searching routes...');
      const { filteredCandidates } = await window.routeEngine.findRoutes({
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
        onProgress: (msg) => setLoadingStatus(msg),
      });

      if (filteredCandidates.length === 0)
        throw new Error(
          'No routes found. Try different locations or check if bus services are running.',
        );

      setResults(filteredCandidates);
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
    clearMapGraphics();
    const { Graphic, Polyline, Point, Extent } = arcgisModulesRef.current;
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

    for (let si = 0; si < route.segments.length; si++) {
      const seg = route.segments[si];
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
      if (si < route.segments.length - 1 && route.walkInfoTransfer?.geometry)
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
    const handleSelectRoute = async (route) => {
        setSelectedRoute(route);
        setExpandedSegments(new Set());
        drawRouteOnMap(route);

        // Update this part to use your new API path:
        const etaPromises = route.segments.map((seg) =>
        // We point this to our python proxy
        fetch(`/api/kmb/route-stop?action=getEta&route=${seg.route}&bound=${seg.bound}&service_type=${seg.service_type}`)
            .then(res => res.json())
            .then(data => data.data || [])
        );

    // Live ETA update for display
    // const etaPromises = route.segments.map((seg) =>
    //   window.routeEngine.fetchETA(seg.fromStop, seg.route, seg.service_type),
    // );
    const etas = await Promise.all(etaPromises);
    const now = new Date();
    const updatedSegments = route.segments.map((seg, i) => {
      const etaList = etas[i] || [];
      const next = etaList.find((e) => e.eta && new Date(e.eta) > now);
      return {
        ...seg,
        nextEta: next?.eta ? new Date(next.eta) : null,
        busInterval:
          etaList.length >= 2 && etaList[0].eta && etaList[1].eta
            ? Math.round((new Date(etaList[1].eta) - new Date(etaList[0].eta)) / 60000)
            : null,
      };
    });
    setSelectedRoute((prev) => ({ ...prev, segments: updatedSegments }));
  };

  // Add to bookmark
  const handleAddToBookmark = (stopId, stopName, routesAtStop) => {
    setAddToBookmark({ stopId, stopName, routes: routesAtStop });
  };

  const confirmAddBookmark = (groupIndex) => {
    const updated = window.bookmarkEngine.addStop(bookmarks, groupIndex, addToBookmark);
    setBookmarks(updated);
    setAddToBookmark(null);
  };

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
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3 bg-white/80 backdrop-blur p-2 rounded-2xl border border-white/50 shadow-sm">
            {/* <div className="bg-[#E1251B] p-2 rounded-xl text-white font-bold">BUS</div> */}
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
              ⭐
            </button>
            <button
              onClick={() => {
                setIsSearchOpen((v) => !v);
                setShowBookmarks(false);
              }}
              className="p-3 bg-white rounded-2xl shadow-md text-xl"
            >
              {isSearchOpen ? '✕' : '🔍'}
            </button>
          </div>
        </div>

        {isSearchOpen && (
          <form onSubmit={handleSearch} className="max-w-md mx-auto mt-4 space-y-3">
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
            <AutocompleteInput
              placeholder="From... (e.g. 旺角, Mong Kok)"
              value={origin}
              onChange={setOrigin}
            />
            <AutocompleteInput
              placeholder="To... (e.g. 尖沙咀, Tsim Sha Tsui)"
              value={destination}
              onChange={setDestination}
            />
            <button
              type="submit"
              disabled={isLoading || !dataLoaded}
              className="w-full py-4 bg-[#E1251B] text-white rounded-2xl font-black italic uppercase shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <span className="animate-spin">⏳</span> {loadingStatus || 'Searching...'}
                </>
              ) : !dataLoaded ? (
                <>
                  <span className="animate-pulse">📡</span> {loadingStatus}
                </>
              ) : (
                'Search Routes'
              )}
            </button>
            {searchError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm font-bold">
                ⚠️ {searchError}
              </div>
            )}
          </form>
        )}
      </div>

      {/* Loading overlay */}
      {!dataLoaded && !isSearchOpen && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 bg-white/90 backdrop-blur px-6 py-4 rounded-2xl shadow-xl text-sm font-bold text-slate-600">
          🗺️ {loadingStatus}
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
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl max-h-[60vh] overflow-y-auto scrollbar-hide slide-up flex flex-col">
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 shrink-0">
            {results.length} Route{results.length > 1 ? 's' : ''} Found
          </h2>

          {/* Filter Section */}
          <div className="mb-4 shrink-0 bg-slate-50 p-3 rounded-2xl border border-slate-200">
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
              {Array.from(new Set(results.flatMap((r) => r.segments.map((s) => s.route))))
                .sort((a, b) =>
                  b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }),
                )
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
                      {r} {isExcluded && '✕'}
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
          </div>

          <div className="space-y-2 overflow-y-auto flex-1 scrollbar-hide">
            {results.map((r) => (
              <div
                key={r.id}
                className="p-4 bg-slate-50 rounded-2xl border-2 border-slate-100 cursor-pointer hover:border-[#E1251B] transition-colors"
                onClick={() => handleSelectRoute(r)}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <div className="font-black text-lg flex items-center gap-2 flex-wrap">
                      {r.segments.map((seg, si) => (
                        <React.Fragment key={si}>
                          {si > 0 && <span className="text-slate-300 text-sm">→</span>}
                          <div className="flex flex-col items-start gap-1">
                            <span
                              className="px-2 py-0.5 rounded-lg text-white text-sm"
                              style={{
                                backgroundColor: ROUTE_COLORS[si % ROUTE_COLORS.length],
                              }}
                            >
                              {seg.route}
                            </span>
                            {seg.nextEta ? (
                              <span className="text-[10px] text-[#E1251B] leading-none whitespace-nowrap">
                                Next bus:{' '}
                                {Math.max(0, Math.round((new Date(seg.nextEta) - new Date()) / 60000))}{' '}
                                mins
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
                        {r.transfers === 0 ? 'Direct' : `${r.transfers} transfer${r.transfers > 1 ? 's' : ''}`}
                      </span>
                      <span>· {r.totalStops} stops</span>
                      {r.walkTimeOrigin > 0 && <span>· 🚶 {r.walkTimeOrigin}min walk</span>}
                      {r.originWaitTime > 0 && <span>· ⏱ {r.originWaitTime}min wait</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[#E1251B] font-bold text-lg">~{r.estimatedTime}min</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Selected route detail */}
      {selectedRoute && !showBookmarks && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white p-4 rounded-t-[2rem] shadow-2xl max-h-[55vh] overflow-y-auto scrollbar-hide slide-up">
          <button
            onClick={() => {
              setSelectedRoute(null);
              clearMapGraphics();
            }}
            className="text-xs font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2"
          >
            ← Back
          </button>

          <div className="flex items-center gap-3 mb-3">
            {selectedRoute.segments.map((seg, si) => (
              <React.Fragment key={si}>
                {si > 0 && <span className="text-slate-300">→</span>}
                <span
                  className="px-3 py-1 rounded-xl text-white font-black text-lg"
                  style={{ backgroundColor: ROUTE_COLORS[si % ROUTE_COLORS.length] }}
                >
                  {seg.route}
                </span>
              </React.Fragment>
            ))}
            <span className="ml-auto text-[#E1251B] font-bold text-xl">
              ~{selectedRoute.estimatedTime}min
            </span>
          </div>

          {selectedRoute.walkTimeOrigin > 0 && (
            <div className="flex items-center gap-2 text-sm text-slate-500 mb-2 pl-2 border-l-2 border-dashed border-slate-300">
              🚶 Walk {selectedRoute.walkTimeOrigin} min to stop
            </div>
          )}

          {selectedRoute.segments.map((seg, si) => {
            const fromStop = stopMapRef.current[seg.fromStop];
            const toStop = stopMapRef.current[seg.toStop];
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
                      {seg.route}
                    </span>
                    <span className="text-xs text-slate-500">
                      {seg.routeInfo?.orig_tc} → {seg.routeInfo?.dest_tc}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-bold">📍 {fromStop?.name_tc || fromStop?.name_en}</div>
                    <button
                      onClick={() =>
                        handleAddToBookmark(seg.fromStop, fromStop?.name_tc || fromStop?.name_en, routesAtFromStop)
                      }
                      className="text-xs text-slate-400 hover:text-yellow-500"
                      title="Bookmark this stop"
                    >
                      ⭐
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
                      {expandedSegments.has(si) ? '▲' : '▼'} {seg.stops.length - 2} intermediate
                      stops
                    </div>
                    <div className="flex font-normal flex-wrap gap-2">
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
                                <span className="text-slate-300 mr-2">•</span>
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
                                ⭐
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="text-sm font-bold">📍 {toStop?.name_tc || toStop?.name_en}</div>
                </div>
                {si < selectedRoute.segments.length - 1 && (
                  <div className="flex items-center gap-2 text-sm text-slate-500 my-2 pl-2 border-l-2 border-dashed border-slate-300">
                    🚶 Transfer ({selectedRoute.walkTimeTransfer || '?'} min walk)
                  </div>
                )}
              </div>
            );
          })}

          {selectedRoute.walkTimeDest > 0 && (
            <div className="flex items-center gap-2 text-sm text-slate-500 mt-2 pl-2 border-l-2 border-dashed border-slate-300">
              🚶 Walk {selectedRoute.walkTimeDest} min to destination
            </div>
          )}
        </div>
      )}

      {/* Add to Bookmark modal */}
      {addToBookmark && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-3xl p-6 mx-4 w-full max-w-xs shadow-2xl">
            <h3 className="font-black text-lg mb-1">⭐ Add to Bookmark</h3>
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
