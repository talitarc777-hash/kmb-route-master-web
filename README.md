# KMB Route Master

A React route planner for Hong Kong. It searches KMB routes locally, validates live or planned service availability, estimates walking/waiting/ride time, and can optionally use Google Transit for gaps where KMB has no usable option.

## Features

- KMB direct, one-transfer, and two-transfer route generation
- Nearby-stop lookup through an in-browser spatial index
- Live KMB ETA filtering with a user-controlled strict ETA option
- Official Transport Department service-alert matching and disruption-aware ranking
- Leave-at and arrive-by validation against compact historical service windows
- Google Directions walking times plus bounded Google Transit ride-time references for KMB legs
- Optional Google Transit options when KMB is unavailable or has an ETA gap
- KMB monthly-pass treatment: KMB legs are ranked as zero additional fare
- Citybus, Tram, MTR, Light Rail, and MTR Bus fare/rail metadata from cached or official open data
- ArcGIS-based route and stop map display
- Official CSDI bus-route geometry with persistent browser caching
- Google driving geometry only when no usable CSDI route shape is available
- Installable Progressive Web App

## Quick Start

Requirements: Node.js 20+ and npm.

```bash
npm install
copy .env.example .env
npm run dev
```

Open the local URL printed by Vite.

For Google-backed features, set this server-side value:

```dotenv
GCP_API_KEY=your_google_maps_platform_key
```

Enable the Places API, Geocoding API, and Directions API for that key. The server proxy rejects other Google Maps API paths, strips unsupported parameters, restricts autocomplete to Hong Kong, and accepts Directions coordinates only within Hong Kong. Do not expose the key through a `VITE_` variable.

If the frontend and API are hosted separately, also set:

```dotenv
VITE_API_BASE_URL=https://your-api-host.example
```

Leave `VITE_API_BASE_URL` empty when the frontend and API share one origin.

## Commands

```bash
npm run dev
npm run build
npm run preview
npm run check:gcp
```

The production build is written to `dist/`.

## Route-Finding Workflow

### 1. Resolve the journey

The app converts the entered origin and destination into WGS84 coordinates. After three typed characters and a 400 ms pause, the dropdown shows Hong Kong place predictions from Google Maps only. Selecting a prediction resolves its place ID through one Geocoding request; unselected free text is geocoded only when the search is submitted. The same coordinates are reused throughout the search.

### 2. Load KMB network data

The browser loads KMB stops, routes, and route-stop sequences through `/api/kmb/*`. `public/routeEngine.js` builds:

- a stop map
- ordered stop lists for each route/direction/service type
- reverse stop-to-route indexes
- a spatial grid for nearby-stop lookup

### 3. Generate KMB candidates

Stops within walking range of the origin and destination form the entry and exit sets. The engine then generates:

- direct journeys where one route serves both sets in the correct stop order
- one-transfer journeys with a safe forward connection
- two-transfer journeys when no simpler connection covers the trip

Candidates are deduplicated before timing and display.

### 4. Validate service time

For **Now**, live KMB ETA data is checked. With strict ETA enabled, routes without a usable ETA are hidden. With strict ETA disabled, structurally valid KMB routes may remain even when no live ETA is returned.

For **Leave at** and **Arrive by**, the app loads only:

`public/operator-data/kmb_operation_time_slots.runtime.json`

The lookup key is route, bound, service type, and boarding stop. Service windows are grouped into:

- Monday-Friday
- Saturday
- Sunday and public holiday

KMB validation is authoritative at the boarding stop. Every segment is matched by route, bound, service type, boarding stop, and stop sequence. When a station (`rs`) profile exists, its active window decides validity and a negative result can never be overridden by route-level evidence. Sample count, sample days, and nearby observed 15-minute ETA slots determine high or medium confidence. If the station key is entirely absent, an explicitly enabled route-level (`r`) fallback may retain an exact route-stop candidate at low confidence; that fallback is blocked for route 110, loops, duplicated-stop patterns, and other ambiguous patterns.

Planned searches apply this local service evidence to the complete generated candidate pool before imposing the 120-candidate network-enrichment cap. This prevents inactive nearby route pairs from filling the cap and hiding a valid route that ranked lower on geographic heuristics alone.

### 5. Estimate journey time

Total time combines:

- walking time to, from, and between stops
- waiting/boarding allowance
- in-vehicle ride time

KMB in-vehicle time starts with an estimate from the geographic distance across the selected stop sequence plus stop intervals. This prevents long express/highway sections with few stops (for example, 968X to Tai Lam) from being incorrectly treated as only a few minutes. The app then uses Google Transit only for the bounded set of best KMB candidates whose route/stop/time-bucket reference is missing. A matching KMB bus duration is stored in a bounded browser reference cache (30-minute time buckets, 24-hour expiry) and reused by later searches; fallback estimates are never stored as Google references.

Candidate discovery uses geographic proximity, but the walking time shown and used for route timing/ranking comes from Google Directions walking routes for access, interchange, and destination legs. Duplicate walking requests are shared and processed with bounded concurrency. A straight-line estimate is retained only as a resilience fallback when Google Directions cannot return a walking route. Ride-time reference lookups are checked before any Google request; when a request is needed, only a bus step whose route number matches the KMB leg is accepted. If Google fails or returns another route, the local ride estimate is retained.

### 6. Optional Google Transit gap search

The option labelled **Use Google Transit for KMB unavailable gaps** is off by default. When enabled, normal KMB search still runs first. Google Transit is requested only for a whole trip with no usable KMB route or for a missing/no-ETA gap.

Returned transit legs may include KMB, Citybus, Tram, MTR, or other Google-supported operators. Operator fare data is enriched from `/api/operators/*` where available. Unknown fares remain unavailable and are never invented.

### 7. Rank and display

Normal KMB-only behavior remains the default. When mixed transport options are present, comparison is primarily:

1. total additional fare
2. total estimated time
3. fewer transfers

KMB legs count as HKD 0 for this user's monthly pass. Options with unknown non-KMB fare are placed after known-fare options when the other ranking factors are comparable. Operator badges make non-KMB legs explicit.

### 8. Draw the selected route

The selected result is drawn on the ArcGIS map. The app first requests the Transport Department **Bus Route** geometry from the official CSDI ArcGIS FeatureServer. It chooses the direction/variant whose line is closest to the selected KMB boarding and alighting stops, then trims the official shape to that travelled section.

CSDI responses are cached in browser storage for up to 30 days, while the server proxy exposes a seven-day shared cache. If Google services are enabled, Google Directions driving geometry can be used when CSDI is unavailable or has no safely matched line. Otherwise the app immediately draws the local KMB stop sequence.

## External Request Minimisation

- Google Maps is the only autocomplete suggestion source. It waits for three characters and a 400 ms typing pause and cancels stale requests. Predictions are not persistently cached.
- Access, interchange, destination, and live-GPS approach walking times use Google Directions. Identical walking legs share cached/in-flight requests, and requests run with bounded concurrency.
- While live GPS is enabled, the blue map marker uses on-device absolute orientation or the GPS movement course to show a smoothed direction arrow. This sensor display makes no Google request and falls back to the blue dot when no reliable heading is available.
- Google KMB ride-time references are capped at eight candidates per search and reused from the persistent browser cache whenever available.
- Planned service validation runs locally before paid Google walking enrichment. Only up to 120 diverse, service-supported candidates proceed to network enrichment, and the UI returns at most 30 ranked results.
- The 16 most recently used exact Leave-at/Arrive-by searches are retained in memory for the current app session, so repeating one does not issue the same Google requests again.
- CSDI and optional Google geometry responses use persistent browser caches.

## Service Disruption Logic

The app refreshes the Transport Department Special Traffic News feed every two minutes through `/api/kmb/service-alerts`. Closed incidents are ignored. An alert affects a journey only when its bilingual notice explicitly names one of that journey's KMB route numbers; generic district or road notices are not guessed onto routes.

- A notice explicitly reporting suspended service removes that journey option.
- A diversion, truncation, or stop-change notice keeps the option but adds a 20-minute ranking penalty.
- A delay or busy-traffic notice keeps the option but adds a 10-minute ranking penalty.
- The displayed journey estimate remains the ETA/schedule estimate; the separate warning explains any ranking penalty.
- If the official feed is unavailable, the app retains normal ETA/schedule planning and shows a transparent warning.

## Operation-Time Data

Raw ETA observation files belong in the ignored `KMB csv time slot/` directory. Regenerate the production schedule with:

```bash
python scripts/analyze_kmb_operation_time_slots.py
```

By default, the script writes only the small runtime file used by the app. Verbose review files are optional:

```bash
python scripts/analyze_kmb_operation_time_slots.py ^
  --db-output tmp/kmb_operation_time_slots.json ^
  --compact-output tmp/kmb_operation_time_slots.compact.json ^
  --summary-output tmp/kmb_operation_time_slot_summary.md
```

The script uses observed ETA percentiles rather than treating every observation as a timetable. Runtime version 3 stores observed 15-minute slots as compact daily bitmasks, preserving station-level gaps without loading verbose slot arrays. Public holidays are explicitly classified in `HK_GENERAL_HOLIDAYS`; update that set when adding observations from another year.

## Operator Data Maintenance

The live app requests operator data through `api/open_data.py`. Maintenance scripts can optionally prebuild compact JSON caches in `public/operator-data/` so the API does not need to reconstruct unchanged datasets.

```bash
python scripts/generate_operator_datasets.py
python scripts/validate_non_kmb_coordinates.py
```

Citybus and Tram HK1980 coordinates are converted to WGS84 during dataset generation. MTR and Light Rail coordinate seed files are kept in `api/` for stations not supplied with suitable coordinates by an official source.

## Deployment

### Vercel

Vercel is the simplest full-stack deployment. `vercel.json` routes:

- `/api/kmb/*` and `/api/google/*` to `api/kmb.py`
- `/api/operators/*` to `api/open_data.py`

Set `GCP_API_KEY` in the Vercel project environment and deploy the repository.

### GitHub Pages

The included workflow deploys the static frontend only. GitHub Pages cannot execute the Python API. Deploy the API separately, then create the repository Actions variable:

`VITE_API_BASE_URL=https://your-api-host.example`

Without an external API base, Google-backed and operator-enrichment features will not be complete.

### Cloudflare Pages

The `functions/api/` handlers can proxy KMB and Google requests. The current Cloudflare handlers do not implement `/api/operators/*`, so use a separate API base if operator fare enrichment is required.

## Project Structure

```text
src/App.jsx                         Main UI, search orchestration, ranking, map display
src/utils/apiBase.js               Same-origin or external API URL handling
src/utils/locationSearch.js        Google place-prediction normalization
src/utils/locationHeading.js       GPS/compass heading normalization and smoothing
src/utils/routePlanningRequests.js KMB data loading, validation, and ordered network indexes
public/routeEngine.js              KMB graph search, ETA/schedule validation, timing
public/operator-data/              Runtime schedules and compact operator datasets
api/kmb.py                         Vercel KMB, CSDI geometry, and Google proxy
api/open_data.py                   Operator datasets, coordinates, fares, rail metadata
functions/api/                     Optional Cloudflare Pages proxies
scripts/                           Data generation, validation, and API checks
```

## Data Sources and Limits

- KMB route, stop, route-stop, and ETA data: KMB open data
- Franchised-bus route geometry: Transport Department Bus Route dataset on CSDI
- Citybus, Tram, and road transport data: Hong Kong Transport Department open data
- MTR and Light Rail data: MTR open data
- Geocoding, walking/driving geometry, and transit duration: Google Maps Platform when configured
- Map display: ArcGIS Maps SDK and Hong Kong basemap services

Historical operation windows are evidence-based estimates, not published timetables. Live ETA and third-party APIs may be incomplete or temporarily unavailable, so the app retains local estimates where safe.
