# KMB Route Master

A React route planner for Hong Kong. It searches KMB routes locally, validates live or planned service availability, estimates walking/waiting/ride time, and can optionally use Google Transit for gaps where KMB has no usable option.

## Features

- KMB direct, one-transfer, and two-transfer route generation
- Nearby-stop lookup through an in-browser spatial index
- Live KMB ETA filtering with a user-controlled strict ETA option
- Leave-at and arrive-by validation against compact historical service windows
- Walking, transit ride-time, and road-geometry refinement through Google Maps APIs
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

Enable the Places, Geocoding, and Directions APIs for that key. Do not expose the key through a `VITE_` variable.

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

The app converts the entered origin and destination into WGS84 coordinates. Google Geocoding is used through the server proxy when configured, with local/browser-safe fallbacks where available. The same coordinates are reused throughout the search.

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

KMB validation is strict at the boarding stop. Every segment must have an exact route, bound, service type, and boarding-stop entry in the route-stop (`rs`) index. The requested boarding time must be inside that station profile and within 20 minutes of an observed 15-minute ETA slot. Missing or rejecting station profiles reject the candidate; a broader route-level (`r`) profile is retained only for diagnostics and can never override station-level evidence. This prevents circular-route or bound ambiguity from making a route appear valid at a stop where KMB service was not observed.

### 5. Estimate journey time

Total time combines:

- walking time to, from, and between stops
- waiting/boarding allowance
- in-vehicle ride time

The local baseline estimates ride time from stop count. Google Directions Transit can refine the in-vehicle duration for a matched leg. Walking and waiting calculations remain local. If Google refinement fails, the local estimate is retained.

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

CSDI responses are cached in browser storage for up to 30 days, while the server proxy exposes a seven-day shared cache. Google Directions driving geometry is requested only when CSDI is unavailable or has no safely matched line. If both sources fail, the app draws the local KMB stop sequence.

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
