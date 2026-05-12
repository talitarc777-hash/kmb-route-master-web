# KMB x Citybus Cooperative Route-Stop Operation Period Study

- Input CSV: `C:\Users\CKCHAN05\Documents\self\KMB routing\KMB-Routing_web_2_codex\KMB csv time slot\kmb_eta_observations_full.csv`
- Total observation rows: **2,006,619**
- KMB routes: **796**
- Citybus routes: **405**
- Cooperative routes (route overlap): **148**
- Cooperative routes seen in observation: **139**
- Cooperative stops seen in observation: **2,649**
- Rows used for aggregation: **252,517**
- Period records emitted: **5,502**

## Day-Class Trends

- weekday: records=5,492, start median=06:53 (P10 00:36 / P90 10:22), end median=21:41 (P10 08:43 / P90 23:25), median window=13.82h
- saturday: records=2,833, start median=09:29 (P10 00:45 / P90 15:09), end median=19:55 (P10 14:32 / P90 23:11), median window=11.53h
- sunday_public_holiday: records=2,992, start median=09:25 (P10 05:48 / P90 15:34), end median=19:54 (P10 15:30 / P90 23:28), median window=11.47h

## Usage for Leave-At / Arrive-By

- Use `periods.weekday|saturday|sunday_public_holiday` as timetable guardrails per route-stop segment.
- In `now` mode, ETA remains primary.
- In `leave at/arrive by`, reject segments that violate the day-class operation window before trying alternatives.
- Keep ETA override: if live ETA exists outside historical window, trust live ETA and log anomaly for model refresh.
