# Route Finding Logic

This document explains how route search works in `public/routeEngine.js`, how KMB routes are rendered in `src/App.jsx`, and how optional Google Transit gap repair works for unavailable KMB segments.

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
- Google transit bus duration for in-vehicle ride time refinement

KMB timing rules:
- `Strict ETA ON` discards KMB routes when a valid next ETA cannot be found
- `Strict ETA OFF` keeps the route and falls back to frequency-based waiting
- Walking time still uses the current Google walking calls
- Waiting time still uses ETA when available, otherwise route frequency fallback
- In-vehicle ride time now prefers Google transit bus duration for each segment and falls back to the per-stop heuristic if Google cannot provide a usable match
- Final time includes walk, wait, ride, transfer walk, and destination walk

Final KMB sort:
1. `estimatedTime`
2. `transfers`
3. total walking time

Final return:
- `filteredCandidates.slice(0, MAX_FINAL)`
- `originStops`, `destStops`

## 4. Alternative Transport Options

Optional gap repair is handled directly in `src/App.jsx` through Google Directions Transit.

When the checkbox is off:
- Existing KMB-only behavior stays unchanged

When the checkbox is on:
- The app still runs normal KMB search first
- The KMB engine is allowed to return no-ETA candidates internally so the app can identify repairable gaps
- It inspects the first 3 fastest KMB candidates for no-ETA / unavailable KMB segments
- For each missing KMB segment, the app calls `/api/google/directions/json` with `mode=transit`
- Google is asked only for the gap between the KMB segment's start stop and end stop
- The returned Google route is inserted into the original KMB journey, so the card shows the whole method such as `KMB -> MTR -> KMB`
- The card/detail panel includes KMB legs before the gap, Google Transit legs for the gap, and KMB legs after the gap
- The displayed hybrid time is: original KMB route time minus the missing KMB segment estimate plus the Google gap duration
- If no KMB route is available at all, Google Transit is asked for the whole origin-to-destination journey
- The old local Citybus / Tram / MTR / MTR Bus / Light Rail dataset search is no longer used in the live app flow

## 5. Alternative Candidate Generation

Google gap candidates are generated from the Google Directions response:
- `routes[].legs[].steps[]` is scanned for `TRANSIT` steps
- Each transit step becomes one displayed leg
- KMB segments before and after the missing segment are converted into displayed legs and merged around the Google legs
- Operator labels are inferred from Google vehicle type, line name, and agency name
- MTR agency is checked before the generic Google `TRAM` vehicle type, so MTR Light Rail is labelled as `LRT` instead of Hong Kong Tramways
- Walking steps are not separately routed by our code; Google route duration already includes its own walking/waiting/transit timing
- If Google returns a walking-only option, it can be shown as a walk gap option

Candidate types:
- Google Transit gap repair for a KMB segment with no active ETA
- Google Transit whole-trip option when KMB has no usable route

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
- for gap repair: replaced KMB route, replaced segment index, original gap time, alternative gap time, and repair reason

Alternative timing model:
- Google provides the replacement gap route and total gap duration
- Google step durations are displayed for each transit leg
- The app does not locally compute non-KMB stop matching, route topology, waiting time, or transfer routing
- Fare enrichment avoids extra Google calls:
- KMB legs are treated as `HKD 0.0` because of the monthly pass rule
- Citybus / Tram / MTR Bus legs are priced through `/api/operators/fare`, which uses cached TD or MTR static fare data
- LRT is kept separate from Hong Kong Tramways; LRT fare remains unavailable unless Google supplies a fare because no LRT fare table is attached yet
- Google `route.fare` is used only when static fare lookup cannot provide a better local value
- Fare remains unavailable only when neither static fare data nor Google provides a usable fare

Alternative loading resilience:
- Google Transit gap responses are cached in memory/localStorage for a short time window
- Static operator fare lookups are cached in memory/localStorage for 14 days
- If Google fails but KMB routes exist, the app keeps the KMB results
- If no KMB route exists and Google also fails, the app shows a no-route error

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
- `Use Google Transit for KMB unavailable gaps`

When the checkbox changes:
- The current search is re-run with the selected mode
- KMB results remain in the list
- Google Transit gap options are shown alongside KMB when no-ETA / unavailable KMB segments exist

Display behavior:
- KMB cards keep their normal route styling
- Google gap cards show operator badges inferred from Google Transit data
- The selected Google gap route gets a dedicated detail panel

## 7. Map Rendering

KMB route rendering remains unchanged.

For Google Transit gap options:
- The app draws a simple WGS84 preview line through the Google-provided transit stops
- It reuses the Google Directions result already fetched during search
- It does not make an extra Google/GCP call just for map preview

## 8. Bookmark and ETA Behavior

Bookmark ETA polling is still handled in `public/bookmarks.js`.

Current behavior:
- Uses periodic polling with no-cache request options
- Adds timestamp query parameters to avoid stale cache responses

## 9. Summary

Current behavior is:
- Checkbox off: KMB-only search, unchanged
- Checkbox on: KMB search first, then Google Transit is used only to fill KMB no-ETA / unavailable gaps
- KMB remains the default path
- Google Transit gap options are cached briefly and clearly labeled
