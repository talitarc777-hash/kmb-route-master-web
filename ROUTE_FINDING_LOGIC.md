# Route Finding Logic

This document explains how route search works in `public/routeEngine.js`, how KMB routes are rendered in `src/App.jsx`, and how the optional non-KMB comparison path works through `src/data/fallbackRouteGenerator.js`.

## 1. Inputs and Setup

Main KMB entry point: `window.routeEngine.findRoutes(params)`.

Key KMB inputs:
- `originLoc`, `destLoc`: resolved lat/lng coordinates
- `stopMap`, `routeMap`, `routeStops`, `stopRoutes`: KMB data indexes
- `timeMode`, `dateValue`, `timeValue`: trip timing mode
- `excludedRoutesText`: routes to hide

Important KMB constants:
- `WALK_RADIUS_KM = 0.6`
- `TRANSFER_WALK_KM = 0.6`
- `RIDE_MIN_PER_STOP = 1.5`
- `MAX_FINAL = 100`

At the start of each KMB search:
- ETA cache is cleared with `clearETACache()`
- A spatial grid is built with `buildSpatialGrid()`
- Nearby stop lookups stay local and fast

## 2. KMB Candidate Generation

The KMB engine generates candidates in three tiers:

1. Direct routes
- Same route key exists in both origin and destination sets
- Direction is validated by stop index order (`oIdx < dIdx`)

2. One-transfer routes
- Walk forward along origin route stops
- For each possible transfer stop, search nearby stops via grid
- Match nearby stops against `destStopIndex`

3. Two-transfer routes
- Seed from one-transfer results
- Extend from the second-leg dropoff to a third leg that can reach the destination

Deduplication:
- Uses `dedupKey` to keep unique route combinations
- For one-transfer duplicates, keep the better heuristic score

## 3. KMB Enrichment and Timing

KMB candidates are then enriched with:
- Walking times from `fetchGCPRoute(...)`
- ETA from `fetchETA(fromStop, route, service_type)`
- Active ETA filtering from `getActiveEtas(...)`

KMB timing rules:
- If ETA records exist, the route can still remain even if the next ETA is not currently active
- If there are no ETA records for the first segment, the route is discarded
- Final time includes walk, wait, ride, transfer walk, and destination walk

Final KMB sort:
1. `estimatedTime`
2. `transfers`
3. total walking time

Final return:
- `filteredCandidates.slice(0, MAX_FINAL)`
- `originStops`, `destStops`

## 4. Alternative Transport Options

Optional non-KMB comparison is handled by `src/data/fallbackRouteGenerator.js`.

When the checkbox is off:
- Existing KMB-only behavior stays unchanged

When the checkbox is on:
- The app still runs normal KMB search first
- It then loads cached enriched operator datasets for:
  - Citybus
  - Tram
  - MTR
- It builds local indexes from the enriched WGS84 data and generates direct comparison candidates
- The current live UI uses direct alternatives first so the comparison stays responsive

Alternative transport data source notes:
- Citybus and Tram use enriched TD stop data with cached WGS84 coordinates
- MTR uses enriched station coordinates from official/open sources plus the manual seed file fallback
- No Google Transit shortcut is used

## 5. Alternative Candidate Generation

The generator builds a local operator index from the cached datasets:
- Stops are filtered to records with valid WGS84 coordinates
- Route variants are grouped by `route_variant_id`
- Stop-to-route lookups are prepared once and reused

Candidate types:
- Citybus direct
- Tram direct
- MTR direct
- Limited 1-transfer support remains in the generator, but the live comparison path currently keeps transfers off for speed

Candidate metadata:
- `operator`
- `mode`
- `route` / `line`
- origin stop
- destination stop
- walk distance
- estimated time
- fare if available
- confidence
- data source

Ranking when comparison mode is enabled:
1. Known total fare
2. Estimated time
3. Fewer transfers

If fare is unavailable:
- The candidate is not assigned a fake value
- It sorts after known-fare options

## 6. UI Integration

The checkbox appears in two places:
- Search form
- Results panel

The label is:
- `Include other transport options with KMB`

When the checkbox changes:
- The current search is re-run with the selected mode
- KMB results remain in the list
- Alternative transport options are shown alongside KMB instead of waiting for KMB failure

Display behavior:
- KMB cards keep their normal route styling
- Alternative cards show an operator badge and the label `Alternative transport option`
- The selected alternative route gets a dedicated detail panel

## 7. Map Rendering

KMB route rendering remains unchanged.

For alternative transport options:
- The app draws a simple local WGS84 preview line
- It does not call Google Transit
- It does not add paid Google/GCP route calls for the alternative preview

## 8. Bookmark and ETA Behavior

Bookmark ETA polling is still handled in `public/bookmarks.js`.

Current behavior:
- Uses periodic polling with no-cache request options
- Adds timestamp query parameters to avoid stale cache responses

## 9. Summary

Current behavior is:
- Checkbox off: KMB-only search, unchanged
- Checkbox on: KMB plus Citybus, Tram, and MTR options for direct comparison
- KMB remains the default path
- Alternative transport options are local, cached, and clearly labeled
