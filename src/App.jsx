import { useState, useEffect, useRef } from 'react';

const App = () => {
    const [mapLoaded, setMapLoaded] = useState(false);
    const [origin, setOrigin] = useState('');
    const [destination, setDestination] = useState('');
    const [results, setResults] = useState([]);
    const [selectedRoute, setSelectedRoute] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isSearchOpen, setIsSearchOpen] = useState(true);
    const [showInfo, setShowInfo] = useState(false);
    const [initialLocating, setInitialLocating] = useState(true);
    const [showDetails, setShowDetails] = useState(false);
    const [aiInsight, setAiInsight] = useState(null);
    const [isAiLoading, setIsAiLoading] = useState(false);
    const [aiSuggestions, setAiSuggestions] = useState([]);

    const mapRef = useRef(null);
    const viewRef = useRef(null);
    const graphicsLayerRef = useRef(null);

    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || '';

    useEffect(() => {
        initArcGIS();
    }, []);

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
            ],
            (
                Map,
                Basemap,
                VectorTileLayer,
                MapView,
                Point,
                GraphicsLayer,
                Graphic,
                Polyline,
            ) => {
                const vtLayer = new VectorTileLayer({
                    url: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/basemap/HK80',
                });
                const labelLayer = new VectorTileLayer({
                    url: 'https://mapapi.geodata.gov.hk/gs/api/v1.0.0/vt/label/hk/tc/HK80',
                });
                const map = new Map({
                    basemap: new Basemap({ baseLayers: [vtLayer] }),
                });
                map.add(labelLayer);

                const view = new MapView({
                    container: mapRef.current,
                    map: map,
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

                view.when(() => {
                    setMapLoaded(true);
                    setInitialLocating(false);
                });
            },
        );
    };

    const handleSearch = (e) => {
        e.preventDefault();
        setIsLoading(true);
        setTimeout(() => {
            setResults([
                {
                    id: 1,
                    totalTime: 42,
                    totalCost: 12.1,
                    summary: '960 → Walk',
                    segments: [],
                },
            ]);
            setIsLoading(false);
            setIsSearchOpen(false);
        }, 1000);
    };

    return (
        <div className="relative h-full w-full bg-slate-100 flex flex-col font-sans">
            <div ref={mapRef} className="absolute inset-0 z-0"></div>

            {/* Branding Header */}
            <div
                className={`absolute top-0 left-0 right-0 z-20 p-4 transition-all ${isSearchOpen ? 'bg-white shadow-xl' : ''}`}
            >
                <div className="max-w-md mx-auto flex items-center justify-between">
                    <div className="flex items-center gap-3 bg-white/80 backdrop-blur p-2 rounded-2xl border border-white/50 shadow-sm">
                        <div className="bg-[#E1251B] p-2 rounded-xl text-white font-bold">
                            BUS
                        </div>
                        <h1 className="text-xl font-black italic uppercase tracking-tighter">
                            KMB <span className="text-[#E1251B]">Route Master</span>
                        </h1>
                    </div>
                    {!isSearchOpen && (
                        <button
                            onClick={() => setIsSearchOpen(true)}
                            className="p-3 bg-white rounded-2xl shadow-md"
                        >
                            🔍
                        </button>
                    )}
                </div>

                {isSearchOpen && (
                    <form
                        onSubmit={handleSearch}
                        className="max-w-md mx-auto mt-4 space-y-3"
                    >
                        <input
                            className="w-full p-4 bg-slate-50 rounded-2xl font-bold"
                            placeholder="From..."
                            value={origin}
                            onChange={(e) => setOrigin(e.target.value)}
                        />
                        <input
                            className="w-full p-4 bg-slate-50 rounded-2xl font-bold"
                            placeholder="To..."
                            value={destination}
                            onChange={(e) => setDestination(e.target.value)}
                        />
                        <button className="w-full py-4 bg-[#E1251B] text-white rounded-2xl font-black italic uppercase shadow-lg">
                            Search Routes
                        </button>
                    </form>
                )}
            </div>

            {results.length > 0 && !selectedRoute && (
                <div className="absolute bottom-0 left-0 right-0 z-20 bg-white p-6 rounded-t-[2.5rem] shadow-2xl h-[30vh]">
                    <h2 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4">
                        Route Results
                    </h2>
                    {results.map((r) => (
                        <div
                            key={r.id}
                            className="p-4 bg-slate-50 rounded-2xl border-2 border-slate-100 flex justify-between items-center"
                            onClick={() => setSelectedRoute(r)}
                        >
                            <div className="font-black text-lg">{r.summary}</div>
                            <div className="text-[#E1251B] font-bold">{r.totalTime} mins</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default App;
