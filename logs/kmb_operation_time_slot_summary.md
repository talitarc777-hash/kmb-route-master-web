# KMB Operation Time Slot Study

- Input files:
  - `C:\Users\CKCHAN05\Documents\self\KMB routing\KMB-Routing_web_2_codex\KMB csv time slot\kmb_eta_observations.jsonl`
  - `C:\Users\CKCHAN05\Documents\self\KMB routing\KMB-Routing_web_2_codex\KMB csv time slot\kmb_eta_observations_001 (Copy).jsonl`
- Observed ETA range: `2026-04-26T15:19:59+08:00` to `2026-06-01T08:00:00+08:00`
- Total rows: **3,047,405**
- Usable ETA rows: **2,025,274**
- Blank ETA rows skipped: **1,004,464**
- `no_eta` rows skipped: **17,667**
- Route profiles: **1,536**
- Route-stop profiles: **28,773**
- Slot size: **15 minutes**

## Generated Files

- Full review JSON: `public\operator-data\kmb_operation_time_slots.json` (**35.53 MB**)
- Compact review JSON: `public\operator-data\kmb_operation_time_slots.compact.json` (**16.28 MB**)
- Runtime app JSON: `public\operator-data\kmb_operation_time_slots.runtime.json` (**2.02 MB**)
- Runtime JSON is the only operation-slot file fetched by the app.
- Runtime JSON stores start/end times as minutes since midnight.
- Runtime JSON omits stop names, coordinates, active slots, and verbose metadata to reduce planned-search load time.

## Day-Class Trends

- weekday: profiles=28,086, median start=06:32 (P10 00:43 / P90 09:19), median end=21:50 (P10 07:55 / P90 23:17)
- saturday: profiles=21,217, median start=07:59 (P10 00:42 / P90 13:12), median end=20:58 (P10 16:21 / P90 23:39)
- sunday_public_holiday: profiles=22,731, median start=06:57 (P10 00:33 / P90 10:01), median end=22:01 (P10 17:44 / P90 23:33)

## Route Planning Use

- For planned time searches, lookup route + bound + service_type + stop_id + day class.
- Reject a candidate when a known profile says the planned board time is outside `start_time`/`end_time`.
- Use route-level profiles as fallback if a specific route-stop profile is missing.
- Reject candidates with missing station and route-level historical profiles.
- In Now mode, live ETA should still override this historical profile.
