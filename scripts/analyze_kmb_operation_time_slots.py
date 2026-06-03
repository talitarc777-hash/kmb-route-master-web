import argparse
import csv
import glob
import json
import os
import statistics
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone


DEFAULT_INPUT_DIR = "KMB csv time slot"
DEFAULT_LEGACY_INPUT = os.path.join(DEFAULT_INPUT_DIR, "kmb_eta_observations_full.csv")
DEFAULT_DB_OUTPUT = os.path.join("public", "operator-data", "kmb_operation_time_slots.json")
DEFAULT_COMPACT_OUTPUT = os.path.join("public", "operator-data", "kmb_operation_time_slots.compact.json")
DEFAULT_RUNTIME_OUTPUT = os.path.join("public", "operator-data", "kmb_operation_time_slots.runtime.json")
DEFAULT_SUMMARY_OUTPUT = os.path.join("logs", "kmb_operation_time_slot_summary.md")
DAY_CLASSES = ("weekday", "saturday", "sunday_public_holiday")

# 2026 Hong Kong general holidays, from GovHK's gazetted public holiday list.
HK_GENERAL_HOLIDAYS = {
    2026: {
        "2026-01-01",
        "2026-02-17",
        "2026-02-18",
        "2026-02-19",
        "2026-04-03",
        "2026-04-04",
        "2026-04-06",
        "2026-04-07",
        "2026-05-01",
        "2026-05-25",
        "2026-06-19",
        "2026-07-01",
        "2026-09-26",
        "2026-10-01",
        "2026-10-19",
        "2026-12-25",
        "2026-12-26",
    },
}


@dataclass(frozen=True)
class RouteStopKey:
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
    if not text or text == "no_eta":
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
    minutes = max(0, min(1439, int(minutes)))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def hhmm_to_minutes(value):
    hours, minutes = str(value).split(":", 1)
    return int(hours) * 60 + int(minutes)


def slot_label(minutes, slot_minutes):
    slot_start = (minutes // slot_minutes) * slot_minutes
    return format_hhmm(slot_start)


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    idx = int(round((len(ordered) - 1) * p))
    return ordered[idx]


def classify_day(local_dt):
    date_key = local_dt.date().isoformat()
    if date_key in HK_GENERAL_HOLIDAYS.get(local_dt.year, set()):
        return "sunday_public_holiday"
    if local_dt.weekday() == 5:
        return "saturday"
    if local_dt.weekday() == 6:
        return "sunday_public_holiday"
    return "weekday"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build all-KMB route-stop observed time-slot profiles for leave-at/arrive-by planning.",
    )
    parser.add_argument(
        "--input",
        action="append",
        help=(
            "Input CSV/JSONL file or folder. Can be passed more than once. "
            "Defaults to JSONL files in 'KMB csv time slot', then the legacy CSV if present."
        ),
    )
    parser.add_argument("--db-output", default=DEFAULT_DB_OUTPUT)
    parser.add_argument("--compact-output", default=DEFAULT_COMPACT_OUTPUT)
    parser.add_argument("--runtime-output", default=DEFAULT_RUNTIME_OUTPUT)
    parser.add_argument("--summary-output", default=DEFAULT_SUMMARY_OUTPUT)
    parser.add_argument("--slot-minutes", type=int, default=15)
    parser.add_argument("--min-samples", type=int, default=4)
    parser.add_argument("--min-slot-samples", type=int, default=1)
    return parser.parse_args()


def discover_input_paths(input_values):
    raw_values = input_values or []
    if not raw_values:
        jsonl_files = sorted(glob.glob(os.path.join(DEFAULT_INPUT_DIR, "*.jsonl")))
        if jsonl_files:
            raw_values = [DEFAULT_INPUT_DIR]
        else:
            raw_values = [DEFAULT_LEGACY_INPUT]

    paths = []
    for value in raw_values:
        abs_value = os.path.abspath(value)
        if os.path.isdir(abs_value):
            matches = (
                sorted(glob.glob(os.path.join(abs_value, "*.jsonl"))) +
                sorted(glob.glob(os.path.join(abs_value, "*.csv")))
            )
            paths.extend(matches)
        else:
            paths.append(abs_value)

    deduped = []
    seen = set()
    for path in paths:
        abs_path = os.path.abspath(path)
        if abs_path in seen:
            continue
        seen.add(abs_path)
        deduped.append(abs_path)

    missing = [path for path in deduped if not os.path.exists(path)]
    if missing:
        raise FileNotFoundError("Input file(s) not found: " + ", ".join(missing))
    if not deduped:
        raise FileNotFoundError(f"No CSV/JSONL inputs found in {os.path.abspath(DEFAULT_INPUT_DIR)}")
    return deduped


def iter_csv_rows(input_path):
    with open(input_path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            yield row


def iter_jsonl_rows(input_path):
    with open(input_path, "r", encoding="utf-8-sig") as handle:
        for line_no, line in enumerate(handle, start=1):
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            try:
                row = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSONL at {input_path}:{line_no}: {exc}") from exc
            if isinstance(row, dict):
                yield row


def iter_input_rows(input_paths):
    for input_path in input_paths:
        ext = os.path.splitext(input_path)[1].lower()
        if ext == ".jsonl":
            yield from iter_jsonl_rows(input_path)
        elif ext == ".csv":
            yield from iter_csv_rows(input_path)
        else:
            raise ValueError(f"Unsupported input type for {input_path}; expected .csv or .jsonl")


def build_route_lookup():
    try:
        rows = fetch_json("https://data.etabus.gov.hk/v1/transport/kmb/route").get("data", [])
    except Exception:
        return {}
    return {
        (row.get("route"), row.get("bound"), str(row.get("service_type"))): {
            "origin_en": row.get("orig_en"),
            "origin_tc": row.get("orig_tc"),
            "destination_en": row.get("dest_en"),
            "destination_tc": row.get("dest_tc"),
        }
        for row in rows
    }


def build_stop_lookup():
    try:
        rows = fetch_json("https://data.etabus.gov.hk/v1/transport/kmb/stop").get("data", [])
    except Exception:
        return {}
    return {
        row.get("stop"): {
            "name_en": row.get("name_en"),
            "name_tc": row.get("name_tc"),
            "lat": row.get("lat"),
            "lng": row.get("long"),
        }
        for row in rows
    }


def main():
    args = parse_args()
    input_paths = discover_input_paths(args.input)

    print(f"[1/4] Loading route and stop metadata")
    route_lookup = build_route_lookup()
    stop_lookup = build_stop_lookup()
    print(f"  routes={len(route_lookup):,}, stops={len(stop_lookup):,}")

    print("[2/4] Aggregating observed ETA slots from:")
    for input_path in input_paths:
        print(f"  - {input_path}")
    values = defaultdict(lambda: defaultdict(list))
    day_seen = defaultdict(set)
    slot_counts = defaultdict(lambda: defaultdict(Counter))
    hour_counts = defaultdict(lambda: defaultdict(Counter))
    route_level_minutes = defaultdict(lambda: defaultdict(list))
    route_level_slots = defaultdict(lambda: defaultdict(Counter))
    total_rows = 0
    usable_rows = 0
    no_eta_rows = 0
    blank_eta_rows = 0
    min_dt = None
    max_dt = None

    for row in iter_input_rows(input_paths):
        total_rows += 1
        dt = parse_iso(row.get("eta"))
        if dt is None:
            raw_eta = (row.get("eta") or "").strip()
            if raw_eta == "no_eta":
                no_eta_rows += 1
            elif not raw_eta:
                blank_eta_rows += 1
            continue
        min_dt = dt if min_dt is None or dt < min_dt else min_dt
        max_dt = dt if max_dt is None or dt > max_dt else max_dt
        day_class = classify_day(dt)
        minute = minutes_since_midnight(dt)
        key = RouteStopKey(
            route=(row.get("route") or "").strip(),
            bound=(row.get("bound") or "").strip(),
            service_type=(row.get("service_type") or "").strip(),
            stop_id=(row.get("stop_id") or "").strip(),
            stop_seq=str(row.get("stop_seq") or "").strip(),
        )
        if not key.route or not key.bound or not key.service_type or not key.stop_id:
            blank_eta_rows += 1
            continue
        route_key = (key.route, key.bound, key.service_type)
        values[key][day_class].append(minute)
        day_seen[(key, day_class)].add(dt.date().isoformat())
        slot_counts[key][day_class][slot_label(minute, args.slot_minutes)] += 1
        hour_counts[key][day_class][f"{dt.hour:02d}:00"] += 1
        route_level_minutes[route_key][day_class].append(minute)
        route_level_slots[route_key][day_class][slot_label(minute, args.slot_minutes)] += 1
        usable_rows += 1

    print(
        f"  total_rows={total_rows:,}, usable_eta_rows={usable_rows:,}, "
        f"blank_eta_rows={blank_eta_rows:,}, no_eta_rows={no_eta_rows:,}"
    )

    print("[3/4] Building route-stop and route-level profiles")
    records = []
    starts_by_day = defaultdict(list)
    ends_by_day = defaultdict(list)
    route_stop_count_by_route = Counter()

    for key, classes in values.items():
        route_meta = route_lookup.get((key.route, key.bound, key.service_type), {})
        stop_meta = stop_lookup.get(key.stop_id, {})
        periods = {}
        for day_class in DAY_CLASSES:
            minutes = classes.get(day_class, [])
            if len(minutes) < args.min_samples:
                continue
            start = percentile(minutes, 0.05)
            end = percentile(minutes, 0.95)
            starts_by_day[day_class].append(start)
            ends_by_day[day_class].append(end)
            periods[day_class] = {
                "start_time": format_hhmm(start),
                "end_time": format_hhmm(end),
                "active_hours": [
                    hour for hour, count in sorted(hour_counts[key][day_class].items())
                    if count >= args.min_slot_samples
                ],
                "active_slots": [
                    slot for slot, count in sorted(slot_counts[key][day_class].items())
                    if count >= args.min_slot_samples
                ],
                "sample_count": len(minutes),
                "sample_days": len(day_seen[(key, day_class)]),
            }
        if not periods:
            continue
        route_stop_count_by_route[(key.route, key.bound, key.service_type)] += 1
        records.append({
            "route": key.route,
            "bound": key.bound,
            "service_type": key.service_type,
            "origin_en": route_meta.get("origin_en"),
            "origin_tc": route_meta.get("origin_tc"),
            "destination_en": route_meta.get("destination_en"),
            "destination_tc": route_meta.get("destination_tc"),
            "stop_id": key.stop_id,
            "stop_seq": key.stop_seq,
            "stop_name_en": stop_meta.get("name_en"),
            "stop_name_tc": stop_meta.get("name_tc"),
            "lat": stop_meta.get("lat"),
            "lng": stop_meta.get("lng"),
            "periods": periods,
        })

    routes = []
    for route_key, classes in route_level_minutes.items():
        route, bound, service_type = route_key
        route_meta = route_lookup.get(route_key, {})
        periods = {}
        for day_class in DAY_CLASSES:
            minutes = classes.get(day_class, [])
            if len(minutes) < args.min_samples:
                continue
            periods[day_class] = {
                "start_time": format_hhmm(percentile(minutes, 0.05)),
                "end_time": format_hhmm(percentile(minutes, 0.95)),
                "active_slots": [
                    slot for slot, count in sorted(route_level_slots[route_key][day_class].items())
                    if count >= args.min_slot_samples
                ],
                "sample_count": len(minutes),
            }
        if periods:
            routes.append({
                "route": route,
                "bound": bound,
                "service_type": service_type,
                "origin_en": route_meta.get("origin_en"),
                "origin_tc": route_meta.get("origin_tc"),
                "destination_en": route_meta.get("destination_en"),
                "destination_tc": route_meta.get("destination_tc"),
                "profiled_stop_count": route_stop_count_by_route[route_key],
                "periods": periods,
            })

    def day_summary(day_class):
        starts = starts_by_day.get(day_class, [])
        ends = ends_by_day.get(day_class, [])
        if not starts:
            return None
        return {
            "profile_count": len(starts),
            "median_start": format_hhmm(statistics.median(starts)),
            "p10_start": format_hhmm(percentile(starts, 0.10)),
            "p90_start": format_hhmm(percentile(starts, 0.90)),
            "median_end": format_hhmm(statistics.median(ends)),
            "p10_end": format_hhmm(percentile(ends, 0.10)),
            "p90_end": format_hhmm(percentile(ends, 0.90)),
        }

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "input_files": input_paths,
        "observed_eta_range": {
            "from": min_dt.isoformat() if min_dt else None,
            "to": max_dt.isoformat() if max_dt else None,
        },
        "slot_minutes": args.slot_minutes,
        "min_samples": args.min_samples,
        "min_slot_samples": args.min_slot_samples,
        "total_rows": total_rows,
        "usable_eta_rows": usable_rows,
        "blank_eta_rows": blank_eta_rows,
        "no_eta_rows": no_eta_rows,
        "route_profile_count": len(routes),
        "route_stop_profile_count": len(records),
        "day_class_summary": {day_class: day_summary(day_class) for day_class in DAY_CLASSES},
        "holiday_model": {
            "source": "GovHK 2026 general holiday list; Sundays are also grouped into sunday_public_holiday",
            "years": sorted(HK_GENERAL_HOLIDAYS.keys()),
        },
    }

    payload = {
        "summary": summary,
        "routes": sorted(routes, key=lambda item: (item["route"], item["bound"], item["service_type"])),
        "route_stops": sorted(records, key=lambda item: (
            item["route"],
            item["bound"],
            item["service_type"],
            int(item["stop_seq"]) if str(item["stop_seq"]).isdigit() else 9999,
            item["stop_id"],
        )),
    }
    compact_route_stops = {}
    for record in payload["route_stops"]:
        key = "|".join([
            record["route"],
            record["bound"],
            record["service_type"],
            record["stop_id"],
        ])
        compact_route_stops[key] = {
            day_class: {
                "s": period["start_time"],
                "e": period["end_time"],
                "a": period["active_slots"],
                "n": period["sample_count"],
                "d": period["sample_days"],
            }
            for day_class, period in record["periods"].items()
        }

    compact_routes = {}
    for route in payload["routes"]:
        key = "|".join([route["route"], route["bound"], route["service_type"]])
        compact_routes[key] = {
            day_class: {
                "s": period["start_time"],
                "e": period["end_time"],
                "a": period["active_slots"],
                "n": period["sample_count"],
            }
            for day_class, period in route["periods"].items()
        }

    compact_payload = {
        "summary": {
            **summary,
            "format": "compact route/route-stop schedule lookup",
            "period_fields": {
                "s": "start_time",
                "e": "end_time",
                "a": "active_slots",
                "n": "sample_count",
                "d": "sample_days",
            },
        },
        "routes": compact_routes,
        "route_stops": compact_route_stops,
    }

    def runtime_periods(periods, include_days):
        rows = []
        for day_class in DAY_CLASSES:
            period = periods.get(day_class)
            if not period:
                rows.append(None)
                continue
            row = [hhmm_to_minutes(period["s"]), hhmm_to_minutes(period["e"]), period["n"]]
            if include_days:
                row.append(period.get("d"))
            rows.append(row)
        return rows

    runtime_payload = {
        "v": 2,
        "d": list(DAY_CLASSES),
        "r": {
            key: runtime_periods(periods, False)
            for key, periods in compact_routes.items()
        },
        "rs": {
            key: runtime_periods(periods, True)
            for key, periods in compact_route_stops.items()
        },
    }

    print("[4/4] Writing outputs")
    os.makedirs(os.path.dirname(os.path.abspath(args.db_output)), exist_ok=True)
    with open(args.db_output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))

    os.makedirs(os.path.dirname(os.path.abspath(args.compact_output)), exist_ok=True)
    with open(args.compact_output, "w", encoding="utf-8") as handle:
        json.dump(compact_payload, handle, ensure_ascii=False, separators=(",", ":"))

    os.makedirs(os.path.dirname(os.path.abspath(args.runtime_output)), exist_ok=True)
    with open(args.runtime_output, "w", encoding="utf-8") as handle:
        json.dump(runtime_payload, handle, ensure_ascii=False, separators=(",", ":"))

    os.makedirs(os.path.dirname(os.path.abspath(args.summary_output)), exist_ok=True)
    generated_files = [
        ("Full review JSON", args.db_output),
        ("Compact review JSON", args.compact_output),
        ("Runtime app JSON", args.runtime_output),
    ]
    with open(args.summary_output, "w", encoding="utf-8") as handle:
        handle.write("# KMB Operation Time Slot Study\n\n")
        handle.write("- Input files:\n")
        for input_path in input_paths:
            handle.write(f"  - `{input_path}`\n")
        handle.write(f"- Observed ETA range: `{summary['observed_eta_range']['from']}` to `{summary['observed_eta_range']['to']}`\n")
        handle.write(f"- Total rows: **{total_rows:,}**\n")
        handle.write(f"- Usable ETA rows: **{usable_rows:,}**\n")
        handle.write(f"- Blank ETA rows skipped: **{blank_eta_rows:,}**\n")
        handle.write(f"- `no_eta` rows skipped: **{no_eta_rows:,}**\n")
        handle.write(f"- Route profiles: **{len(routes):,}**\n")
        handle.write(f"- Route-stop profiles: **{len(records):,}**\n")
        handle.write(f"- Slot size: **{args.slot_minutes} minutes**\n\n")
        handle.write("## Generated Files\n\n")
        for label, path in generated_files:
            size_mb = os.path.getsize(path) / 1024 / 1024
            handle.write(f"- {label}: `{path}` (**{size_mb:.2f} MB**)\n")
        handle.write("- Runtime JSON is the only operation-slot file fetched by the app.\n")
        handle.write("- Runtime JSON stores start/end times as minutes since midnight.\n")
        handle.write("- Runtime JSON omits stop names, coordinates, active slots, and verbose metadata to reduce planned-search load time.\n\n")
        handle.write("## Day-Class Trends\n\n")
        for day_class in DAY_CLASSES:
            row = summary["day_class_summary"].get(day_class)
            if not row:
                handle.write(f"- {day_class}: no sufficient samples\n")
                continue
            handle.write(
                f"- {day_class}: profiles={row['profile_count']:,}, "
                f"median start={row['median_start']} (P10 {row['p10_start']} / P90 {row['p90_start']}), "
                f"median end={row['median_end']} (P10 {row['p10_end']} / P90 {row['p90_end']})\n"
            )
        handle.write("\n## Route Planning Use\n\n")
        handle.write("- For planned time searches, lookup route + bound + service_type + stop_id + day class.\n")
        handle.write("- Reject a candidate when a known profile says the planned board time is outside `start_time`/`end_time`.\n")
        handle.write("- Use route-level profiles as fallback if a specific route-stop profile is missing.\n")
        handle.write("- Keep candidates with missing historical profiles, but mark them as partially validated in the app.\n")
        handle.write("- In Now mode, live ETA should still override this historical profile.\n")

    print(f"  wrote {args.db_output}")
    print(f"  wrote {args.compact_output}")
    print(f"  wrote {args.runtime_output}")
    print(f"  wrote {args.summary_output}")


if __name__ == "__main__":
    main()
