# KMB Operation Time Slot Study

- Input CSV: `C:\Users\CKCHAN05\Documents\self\KMB routing\KMB-Routing_web_2_codex\KMB csv time slot\kmb_eta_observations_full.csv`
- Observed ETA range: `2026-04-26T15:19:59+08:00` to `2026-05-12T15:09:59+08:00`
- Total rows: **2,006,619**
- Usable ETA rows: **1,342,625**
- Blank ETA rows skipped: **656,230**
- `no_eta` rows skipped: **7,764**
- Route profiles: **1,529**
- Route-stop profiles: **27,383**
- Slot size: **15 minutes**

## Day-Class Trends

- weekday: profiles=26,349, median start=06:44 (P10 00:38 / P90 11:01), median end=21:35 (P10 08:17 / P90 23:25)
- saturday: profiles=20,202, median start=10:00 (P10 03:38 / P90 15:38), median end=18:33 (P10 13:43 / P90 23:09)
- sunday_public_holiday: profiles=21,092, median start=07:55 (P10 01:00 / P90 13:00), median end=21:00 (P10 16:51 / P90 23:30)

## Route Planning Use

- For planned time searches, lookup route + bound + service_type + stop_id + day class.
- Accept a candidate when the requested minute is inside `start_time`/`end_time` and close to an `active_slots` bucket.
- Use route-level profiles as fallback if a specific route-stop profile is missing.
- In Now mode, live ETA should still override this historical profile.
