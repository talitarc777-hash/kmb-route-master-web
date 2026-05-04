import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
API_DIR = os.path.join(ROOT_DIR, "api")
MTR_SEED_PATH = os.path.join(API_DIR, "mtr_station_coordinates.manual.json")
LRT_SEED_PATH = os.path.join(API_DIR, "lrt_stop_coordinates.manual.json")

sys.path.insert(0, API_DIR)

import open_data  # noqa: E402

MAX_WORKERS = 12


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def write_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def seed_entry_from_location(record, location, source_prefix):
    grid_easting = open_data.parse_float(location["result"].get("x"))
    grid_northing = open_data.parse_float(location["result"].get("y"))
    coords = open_data.convert_hk80_to_wgs84(grid_easting, grid_northing)
    if not coords:
        return None
    return {
        **record,
        "name_tc": location["result"].get("nameZH") or record.get("name_tc"),
        "name_en": location["result"].get("nameEN") or record.get("name_en"),
        "lat": coords["lat"],
        "lng": coords["lng"],
        "grid_easting": grid_easting,
        "grid_northing": grid_northing,
        "source": f"{source_prefix}: LandsD Location Search API ({location['query']})",
    }


def generate_mtr_seed():
    existing = read_json(MTR_SEED_PATH, {"stations": {}})
    stations = dict(existing.get("stations") or {})
    rows = open_data.fetch_csv_rows(open_data.MTR_LINES_URL)
    seen_station_ids = set()
    unresolved = []
    tasks = []

    for row in rows:
        station_id = str(open_data.parse_int(row.get("Station ID")) or row.get("Station ID") or "").strip()
        station_code = (row.get("Station Code") or "").strip()
        if not station_id or station_id in seen_station_ids:
            continue
        seen_station_ids.add(station_id)

        name_block = open_data.build_name_block(row.get("Chinese Name"), row.get("English Name"), None)
        if stations.get(station_id) and stations[station_id].get("lat") is not None and stations[station_id].get("lng") is not None:
            if station_code and station_code not in stations:
                stations[station_code] = dict(stations[station_id])
            continue

        tasks.append((station_id, station_code, name_block))

    def resolve(task):
        station_id, station_code, name_block = task
        location = open_data.find_mtr_station_location(name_block)
        if not location:
            return task, None

        entry = seed_entry_from_location(
            {
                "station_code": station_code,
                "name_tc": name_block.get("tc"),
                "name_en": name_block.get("en"),
            },
            location,
            "Offline MTR coordinate seed",
        )
        return task, entry

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(resolve, task) for task in tasks]
        for future in as_completed(futures):
            (station_id, station_code, name_block), entry = future.result()
            if not entry:
                unresolved.append({"station_id": station_id, "station_code": station_code, "name": name_block})
                continue
            stations[station_id] = entry
            if station_code:
                stations[station_code] = dict(entry)

    write_json(MTR_SEED_PATH, {
        "_comment": "Offline WGS84 seed for MTR station coordinates. Generated from MTR station CSV names matched against the official LandsD Location Search API; keys include station_id and station_code where available.",
        "stations": dict(sorted(stations.items())),
        "unresolved": unresolved,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    return len(seen_station_ids), len(unresolved)


def generate_lrt_seed():
    existing = read_json(LRT_SEED_PATH, {"stops": {}})
    stops = dict(existing.get("stops") or {})
    rows = open_data.fetch_csv_rows(open_data.LIGHT_RAIL_ROUTES_STOPS_URL)
    seen_stop_ids = set()
    unresolved = []
    tasks = []

    for row in rows:
        stop_id = str(open_data.first_non_empty(row, ["Stop ID", "STOP_ID", "STATION_ID"]) or "").strip()
        stop_code = str(open_data.first_non_empty(row, ["Stop Code", "STOP_CODE", "STATION_CODE"]) or "").strip()
        if not stop_id or stop_id in seen_stop_ids:
            continue
        seen_stop_ids.add(stop_id)

        name_block = open_data.build_name_block(
            open_data.first_non_empty(row, ["Chinese Name", "STOP_NAME_CHI", "STATION_NAME_CHI"]),
            open_data.first_non_empty(row, ["English Name", "STOP_NAME_ENG", "STATION_NAME_ENG"]),
            None,
        )
        tasks.append((stop_id, stop_code, name_block))

    def resolve(task):
        stop_id, stop_code, name_block = task
        location = open_data.find_lrt_stop_location(name_block)
        if not location:
            return task, None

        entry = seed_entry_from_location(
            {
                "stop_code": stop_code,
                "name_tc": name_block.get("tc"),
                "name_en": name_block.get("en"),
            },
            location,
            "Offline LRT coordinate seed",
        )
        return task, entry

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [executor.submit(resolve, task) for task in tasks]
        for future in as_completed(futures):
            (stop_id, stop_code, name_block), entry = future.result()
            if not entry:
                unresolved.append({"stop_id": stop_id, "stop_code": stop_code, "name": name_block})
                continue
            stops[stop_id] = entry
            if stop_code:
                stops[stop_code] = dict(entry)

    write_json(LRT_SEED_PATH, {
        "_comment": "Offline WGS84 seed for Light Rail stop coordinates. Generated from MTR Light Rail CSV names matched against the official LandsD Location Search API; keys include stop_id and stop_code where available.",
        "stops": dict(sorted(stops.items())),
        "unresolved": unresolved,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    })
    return len(seen_stop_ids), len(unresolved)


def main():
    mtr_total, mtr_unresolved = generate_mtr_seed()
    lrt_total, lrt_unresolved = generate_lrt_seed()
    print(f"MTR stations processed: {mtr_total}, unresolved: {mtr_unresolved}")
    print(f"LRT stops processed: {lrt_total}, unresolved: {lrt_unresolved}")


if __name__ == "__main__":
    main()
