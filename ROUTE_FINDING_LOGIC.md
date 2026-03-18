# Route Finding Logic

This document explains how route search works in `public/routeEngine.js` and how results are shown in `src/App.jsx`.

## 1) Inputs and Setup

Main entry point: `window.routeEngine.findRoutes(params)`.

Key inputs:
- `originLoc`, `destLoc`: resolved lat/lng coordinates
- `stopMap`, `routeMap`, `routeStops`, `stopRoutes`: KMB data indexes
- `timeMode`, `dateValue`, `timeValue`: trip timing mode
- `excludedRoutesText`: routes to hide

Important constants:
- `WALK_RADIUS_KM = 0.6`
- `TRANSFER_WALK_KM = 0.6`
- `RIDE_MIN_PER_STOP = 1.5`
- `MAX_FINAL = 100`

At the start of each search:
- ETA cache is cleared (`clearETACache()`), so each search gets fresh ETA calls.
- A spatial grid is built (`buildSpatialGrid`) for fast nearby-stop lookups.

## 2) Nearby Stops and Route Sets

1. Find nearby origin stops and destination stops within 600m using `nearbyFromGrid`.
2. Build `originRouteSet`:
- Routes that can be boarded near origin.
- Keep best entry (closest origin stop) per `route|bound|service_type`.
3. Build `destRouteSet`:
- Routes that can drop near destination.
- Keep best entry (closest destination stop) per `route|bound|service_type`.
4. Build `destStopIndex`:
- Reverse index of stops that appear before each destination drop point.
- Used to quickly detect transfer opportunities.

## 3) Candidate Generation

The engine generates candidates in three tiers:

1. Direct routes (`transfers = 0`)
- Same route key exists in both origin and destination sets.
- Direction is validated by stop index order (`oIdx < dIdx`).

2. One-transfer routes (`transfers = 1`)
- Walk forward along origin route stops.
- For each possible transfer stop, search nearby stops via grid.
- Match nearby stops against `destStopIndex`.

3. Two-transfer routes (`transfers = 2`)
- Seed from one-transfer results.
- Extend from second leg dropoff to a third leg that can reach destination.

Deduplication:
- Uses `dedupKey` to keep unique route combinations.
- For one-transfer duplicates, keep better heuristic score.

## 4) Pre-Ranking Before Enrichment

Candidates are sorted by a heuristic that prioritizes:
- Fewer transfers
- Lower walking penalties
- Stop count with low weight

Then a capped set is selected for enrichment:
- Up to 200 candidates
- Max 6 combinations per same first-leg route

## 5) Enrichment (Walking + ETA)

Walking times:
- Google Directions is called by `fetchGCPRoute(...)` for:
- Origin to first boarding stop
- Last alighting stop to destination
- Transfer walks
- GCP responses are cached in memory + localStorage with TTL.

ETA:
- ETA is fetched per segment by `fetchETA(fromStop, route, service_type)`.
- `getActiveEtas(...)` keeps only upcoming ETAs within active window.
- Segment fields are attached:
- `nextEta`, `hasActiveEta`, `activeEtaCount`, `busInterval`

Important filter:
- Route is discarded only if first segment ETA API returns an empty array.
- If ETA records exist but no active ETA, route is still kept (scheduled service fallback).

## 6) Time Estimation

Total time is computed as:
- Walk to first stop
- Initial wait (real-time ETA if available, otherwise route frequency fallback)
- Ride time (`stops * RIDE_MIN_PER_STOP`) for each segment
- Transfer walk + transfer wait for transfer segments
- Final walk to destination

Outputs:
- `estimatedTime`
- `originWaitTime`
- full enriched route object per candidate

Final sort:
1. `estimatedTime`
2. `transfers`
3. total walking time

Final return:
- `filteredCandidates.slice(0, MAX_FINAL)`
- `originStops`, `destStops`

## 7) UI Grouping and Display

In `src/App.jsx`, results are further grouped into cards:
- Group key uses transfers + stop pattern (fromStop->toStop per segment)
- Routes sharing same physical path are grouped together

For each grouped segment:
- `routeOptions` is built (each bus option with service type and ETA)
- `routeLabel` is combined, for example `269B/269C/69X`

When user clicks a result card:
- The detail view receives the grouped model, not only one representative route
- ETA is refreshed for each bus option in the segment
- Card and detail stay consistent

ETA text in card/detail:
- Uses `getEtaText(...)` and chip styling (`getEtaChipClass(...)`) for scanability.

## 8) Bookmark ETA Behavior

Bookmark ETA polling is handled in `public/bookmarks.js`.

Current behavior:
- Uses periodic polling (`ETAPoller`)
- Fetches ETA with explicit no-cache request options:
- `cache: 'no-store'`
- `cache-control: no-cache`
- `pragma: no-cache`
- Adds timestamp query (`?_=`) to avoid stale cache responses.

