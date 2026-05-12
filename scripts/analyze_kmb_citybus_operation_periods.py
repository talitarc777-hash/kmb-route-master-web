import argparse
import csv
import json
import os
import statistics
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone


DEFAULT_INPUT = os.path.join("KMB csv time slot", "kmb_eta_observations_full.csv")
DEFAULT_DB_OUTPUT = os.path.join("public", "operator-data", "kmb_citybus_operation_periods.json")
DEFAULT_SUMMARY_OUTPUT = os.path.join("logs", "kmb_citybus_operation_period_summary.md")
HOLIDAY_URLS = [
    "https://www.1823.gov.hk/common/ical/en.json",
    "https://www.1823.gov.hk/common/ical/tc.json",
]


@dataclass(frozen=True)
class Key:
    route: str
    bound: str
    service_type: str
    stop_id: str
    stop_seq: str


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read().decode("utf-8-sig"))


def parse_iso(value):
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def minutes_since_midnight(dt):
    return dt.hour * 60 + dt.minute


def format_hhmm(minutes):
    if minutes is None:
        return None
    minutes = max(0, min(1439, int(minutes)))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * p))
    return ordered[idx]


def normalize_route_label(value):
    return "".join(ch for ch in str(value or "").upper().strip() if ch.isalnum())


def load_hk_public_holidays(years):
    wanted_years = {int(y) for y in years if y is not None}
    holidays = set()
    for url in HOLIDAY_URLS:
        try:
            payload = fetch_json(url)
            for row in payload:
                date_str = (row or {}).get("dtstart") or (row or {}).get("date")
                if not date_str:
                    continue
                try:
                    dt = datetime.fromisoformat(date_str[:10])
                except ValueError:
                    continue
                if dt.year in wanted_years:
                    holidays.add(dt.date())
            if holidays:
                break
        except Exception:
            continue
    return holidays


def classify_day(local_dt, public_holidays):
    day = local_dt.date()
    if day in public_holidays:
        return "sunday_public_holiday"
    wd = local_dt.weekday()
    if wd == 5:
        return "saturday"
    if wd == 6:
        return "sunday_public_holiday"
    return "weekday"


def parse_args():
    parser = argparse.ArgumentParser(description="Analyze operation periods for KMB routes that overlap with Citybus routes.")
    parser.add_argument("--input", default=DEFAULT_INPUT, help="Input observation CSV path")
    parser.add_argument("--min-samples", type=int, default=6, help="Minimum samples per day-class to keep a period")
    parser.add_argument("--db-output", default=DEFAULT_DB_OUTPUT, help="Output JSON database path")
    parser.add_argument("--summary-output", default=DEFAULT_SUMMARY_OUTPUT, help="Output markdown summary path")
    return parser.parse_args()


def main():
    args = parse_args()
    input_path = os.path.abspath(args.input)
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input CSV not found: {input_path}")

    print(f"[1/5] Scanning observation CSV years: {input_path}")
    years = set()
    total_rows = 0
    with open(input_path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            total_rows += 1
            dt = parse_iso(row.get("eta"))
            if dt:
                years.add(dt.year)
    print(f"  rows={total_rows:,}, years={sorted(years)}")

    print("[2/5] Loading KMB / Citybus route catalogs and KMB stop names")
    kmb_routes = fetch_json("https://data.etabus.gov.hk/v1/transport/kmb/route").get("data", [])
    citybus_routes = fetch_json("https://rt.data.gov.hk/v2/transport/citybus/route/ctb").get("data", [])
    kmb_stops_payload = fetch_json("https://data.etabus.gov.hk/v1/transport/kmb/stop").get("data", [])
    kmb_stops = {
        row.get("stop"): {
            "name_en": row.get("name_en"),
            "name_tc": row.get("name_tc"),
        }
        for row in kmb_stops_payload
    }

    kmb_route_set = {normalize_route_label(row.get("route")) for row in kmb_routes}
    citybus_route_set = {normalize_route_label(row.get("route")) for row in citybus_routes}
    cooperative_route_set = {route for route in kmb_route_set.intersection(citybus_route_set) if route}
    print(f"  kmb_routes={len(kmb_route_set):,}, citybus_routes={len(citybus_route_set):,}, overlap={len(cooperative_route_set):,}")

    public_holidays = load_hk_public_holidays(years)
    if public_holidays:
        print(f"  public_holidays_loaded={len(public_holidays)}")
    else:
        print("  public_holidays_loaded=0 (sun/PH class falls back to Sundays only)")

    print("[3/5] Aggregating cooperative-route stop windows")
    aggregator = defaultdict(lambda: defaultdict(list))
    days_seen = defaultdict(set)
    rows_used = 0
    coop_stops = set()
    coop_routes_seen = set()

    with open(input_path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            route = normalize_route_label(row.get("route"))
            if route not in cooperative_route_set:
                continue
            dt = parse_iso(row.get("eta"))
            if not dt:
                continue
            day_class = classify_day(dt, public_holidays)
            key = Key(
                route=(row.get("route") or "").strip(),
                bound=(row.get("bound") or "").strip(),
                service_type=(row.get("service_type") or "").strip(),
                stop_id=(row.get("stop_id") or "").strip(),
                stop_seq=(row.get("stop_seq") or "").strip(),
            )
            aggregator[key][day_class].append(minutes_since_midnight(dt))
            days_seen[(key, day_class)].add(dt.date().isoformat())
            rows_used += 1
            coop_stops.add(key.stop_id)
            coop_routes_seen.add(route)
    print(f"  rows_used={rows_used:,}, cooperative_routes_seen={len(coop_routes_seen):,}, cooperative_stops_seen={len(coop_stops):,}")

    print("[4/5] Building schedule profile records")
    records = []
    first_mins = defaultdict(list)
    last_mins = defaultdict(list)
    windows = defaultdict(list)

    for key, classes in aggregator.items():
        periods = {}
        for day_class in ("weekday", "saturday", "sunday_public_holiday"):
            values = classes.get(day_class, [])
            if len(values) < args.min_samples:
                continue
            start_min = percentile(values, 0.05)
            end_min = percentile(values, 0.95)
            if start_min is None or end_min is None:
                continue
            periods[day_class] = {
                "start_time": format_hhmm(start_min),
                "end_time": format_hhmm(end_min),
                "sample_count": len(values),
                "sample_days": len(days_seen[(key, day_class)]),
            }
            first_mins[day_class].append(start_min)
            last_mins[day_class].append(end_min)
            windows[day_class].append(max(0, end_min - start_min))
        if not periods:
            continue
        stop = kmb_stops.get(key.stop_id, {})
        records.append({
            "route": key.route,
            "bound": key.bound,
            "service_type": key.service_type,
            "stop_id": key.stop_id,
            "stop_seq": key.stop_seq,
            "kmb_stop_name_en": stop.get("name_en"),
            "kmb_stop_name_tc": stop.get("name_tc"),
            "periods": periods,
        })

    def day_stats(day_class):
        starts = first_mins.get(day_class, [])
        ends = last_mins.get(day_class, [])
        span = windows.get(day_class, [])
        if not starts:
            return None
        return {
            "records": len(starts),
            "typical_start_median": format_hhmm(statistics.median(starts)),
            "typical_start_p10": format_hhmm(percentile(starts, 0.10)),
            "typical_start_p90": format_hhmm(percentile(starts, 0.90)),
            "typical_end_median": format_hhmm(statistics.median(ends)),
            "typical_end_p10": format_hhmm(percentile(ends, 0.10)),
            "typical_end_p90": format_hhmm(percentile(ends, 0.90)),
            "typical_window_hours_median": round(statistics.median(span) / 60.0, 2),
        }

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "input_csv": input_path,
        "total_observation_rows": total_rows,
        "cooperation_model": "route_overlap_between_kmb_and_citybus",
        "kmb_route_count": len(kmb_route_set),
        "citybus_route_count": len(citybus_route_set),
        "cooperative_route_count": len(cooperative_route_set),
        "cooperative_routes_seen_in_observation": len(coop_routes_seen),
        "cooperative_stops_seen_in_observation": len(coop_stops),
        "rows_used_for_cooperative_aggregation": rows_used,
        "period_record_count": len(records),
        "day_class_summary": {
            "weekday": day_stats("weekday"),
            "saturday": day_stats("saturday"),
            "sunday_public_holiday": day_stats("sunday_public_holiday"),
        },
        "public_holidays_detected": sorted(d.isoformat() for d in public_holidays),
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.db_output)), exist_ok=True)
    with open(args.db_output, "w", encoding="utf-8") as handle:
        json.dump({"summary": summary, "records": records}, handle, ensure_ascii=False, indent=2)

    print(f"[5/5] Writing outputs: {args.db_output} and {args.summary_output}")
    os.makedirs(os.path.dirname(os.path.abspath(args.summary_output)), exist_ok=True)
    with open(args.summary_output, "w", encoding="utf-8") as handle:
        handle.write("# KMB x Citybus Cooperative Route-Stop Operation Period Study\n\n")
        handle.write(f"- Input CSV: `{input_path}`\n")
        handle.write(f"- Total observation rows: **{total_rows:,}**\n")
        handle.write(f"- KMB routes: **{len(kmb_route_set):,}**\n")
        handle.write(f"- Citybus routes: **{len(citybus_route_set):,}**\n")
        handle.write(f"- Cooperative routes (route overlap): **{len(cooperative_route_set):,}**\n")
        handle.write(f"- Cooperative routes seen in observation: **{len(coop_routes_seen):,}**\n")
        handle.write(f"- Cooperative stops seen in observation: **{len(coop_stops):,}**\n")
        handle.write(f"- Rows used for aggregation: **{rows_used:,}**\n")
        handle.write(f"- Period records emitted: **{len(records):,}**\n\n")
        handle.write("## Day-Class Trends\n\n")
        for day_class in ("weekday", "saturday", "sunday_public_holiday"):
            row = summary["day_class_summary"].get(day_class)
            if not row:
                handle.write(f"- {day_class}: no sufficient samples\n")
                continue
            handle.write(
                f"- {day_class}: records={row['records']:,}, "
                f"start median={row['typical_start_median']} (P10 {row['typical_start_p10']} / P90 {row['typical_start_p90']}), "
                f"end median={row['typical_end_median']} (P10 {row['typical_end_p10']} / P90 {row['typical_end_p90']}), "
                f"median window={row['typical_window_hours_median']}h\n"
            )
        handle.write("\n## Usage for Leave-At / Arrive-By\n\n")
        handle.write("- Use `periods.weekday|saturday|sunday_public_holiday` as timetable guardrails per route-stop segment.\n")
        handle.write("- In `now` mode, ETA remains primary.\n")
        handle.write("- In `leave at/arrive by`, reject segments that violate the day-class operation window before trying alternatives.\n")
        handle.write("- Keep ETA override: if live ETA exists outside historical window, trust live ETA and log anomaly for model refresh.\n")

    print("Done.")


if __name__ == "__main__":
    main()
