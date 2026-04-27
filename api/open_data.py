import csv
import io
import json
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler

STATIC_TTL_SECONDS = 12 * 60 * 60
ETA_TTL_SECONDS = 20
GEO_TTL_SECONDS = 30 * 24 * 60 * 60

TD_ROUTE_BUS_XML = "https://static.data.gov.hk/td/routes-fares-xml/ROUTE_BUS.xml"
TD_RSTOP_BUS_XML = "https://static.data.gov.hk/td/routes-fares-xml/RSTOP_BUS.xml"
TD_STOP_BUS_XML = "https://static.data.gov.hk/td/routes-fares-xml/STOP_BUS.xml"
TD_FARE_BUS_XML = "https://static.data.gov.hk/td/routes-fares-xml/FARE_BUS.xml"

TD_ROUTE_TRAM_XML = "https://static.data.gov.hk/td/routes-fares-xml/ROUTE_TRAM.xml"
TD_RSTOP_TRAM_XML = "https://static.data.gov.hk/td/routes-fares-xml/RSTOP_TRAM.xml"
TD_STOP_TRAM_XML = "https://static.data.gov.hk/td/routes-fares-xml/STOP_TRAM.xml"
TD_FARE_TRAM_XML = "https://static.data.gov.hk/td/routes-fares-xml/FARE_TRAM.xml"

CITYBUS_ETA_URL = "https://rt.data.gov.hk/v2/transport/citybus/eta/ctb/{stop_id}/{route}"
CITYBUS_STOP_URL = "https://rt.data.gov.hk/v2/transport/citybus/stop/{stop_id}"

MTR_LINES_URL = "https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv"
MTR_FARES_URL = "https://opendata.mtr.com.hk/data/mtr_lines_fares.csv"
MTR_TRAIN_ETA_URL = "https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line={line}&sta={station}"

COORD_TRANSFORM_URL = "https://www.geodetic.gov.hk/transform/v2/?inSys=hkgrid&outSys=wgsgeog&n={northing}&e={easting}"

CACHE = {}


def make_cache_key(kind, url):
    return f"{kind}:{url}"


def get_cached_value(key):
    row = CACHE.get(key)
    if not row:
        return None
    if row["expires_at"] <= time.time():
        CACHE.pop(key, None)
        return None
    return row["value"]


def set_cached_value(key, value, ttl_seconds):
    CACHE[key] = {
        "value": value,
        "expires_at": time.time() + ttl_seconds,
    }
    return value


def fetch_text(url, ttl_seconds=STATIC_TTL_SECONDS):
    cache_key = make_cache_key("text", url)
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = response.read().decode("utf-8-sig")
    return set_cached_value(cache_key, payload, ttl_seconds)


def fetch_json(url, ttl_seconds=STATIC_TTL_SECONDS):
    cache_key = make_cache_key("json", url)
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached
    value = json.loads(fetch_text(url, ttl_seconds=ttl_seconds))
    return set_cached_value(cache_key, value, ttl_seconds)


def fetch_csv_rows(url, ttl_seconds=STATIC_TTL_SECONDS):
    cache_key = make_cache_key("csv", url)
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached
    text = fetch_text(url, ttl_seconds=ttl_seconds)
    rows = list(csv.DictReader(io.StringIO(text)))
    return set_cached_value(cache_key, rows, ttl_seconds)


def fetch_xml_rows(url, tag_name, ttl_seconds=STATIC_TTL_SECONDS):
    cache_key = make_cache_key(f"xml:{tag_name}", url)
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached
    text = fetch_text(url, ttl_seconds=ttl_seconds)
    root = ET.fromstring(text)
    rows = []
    for node in root.findall(tag_name):
        rows.append({child.tag: (child.text or "").strip() for child in node})
    return set_cached_value(cache_key, rows, ttl_seconds)


def parse_float(value):
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_int(value):
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def build_name_block(tc=None, en=None, sc=None):
    return {
        "tc": tc or None,
        "en": en or None,
        "sc": sc or None,
    }


def company_matches(company_code, operator_code):
    parts = [part.strip().upper() for part in (company_code or "").replace("/", "+").split("+")]
    return operator_code.upper() in parts


def normalize_td_route(row, operator):
    route_id = row.get("ROUTE_ID")
    return {
        "id": f"{operator}:{route_id}",
        "operator": operator,
        "route_id": route_id,
        "route": row.get("ROUTE_NAMEE") or row.get("ROUTE_NAMEC") or row.get("ROUTE_NAMES"),
        "line": row.get("ROUTE_NAMEE") or row.get("ROUTE_NAMEC") or row.get("ROUTE_NAMES"),
        "display_route": row.get("ROUTE_NAMEE") or row.get("ROUTE_NAMEC") or row.get("ROUTE_NAMES"),
        "route_name": build_name_block(row.get("ROUTE_NAMEC"), row.get("ROUTE_NAMEE"), row.get("ROUTE_NAMES")),
        "direction": None,
        "service_type": row.get("SERVICE_MODE") or None,
        "route_type": row.get("ROUTE_TYPE") or None,
        "special_type": row.get("SPECIAL_TYPE") or None,
        "journey_time_minutes": parse_int(row.get("JOURNEY_TIME")),
        "origin": build_name_block(row.get("LOC_START_NAMEC"), row.get("LOC_START_NAMEE"), row.get("LOC_START_NAMES")),
        "destination": build_name_block(row.get("LOC_END_NAMEC"), row.get("LOC_END_NAMEE"), row.get("LOC_END_NAMES")),
        "full_fare": parse_float(row.get("FULL_FARE")),
        "fare": parse_float(row.get("FULL_FARE")),
        "fare_currency": "HKD" if row.get("FULL_FARE") else None,
        "source": "TD routes and fares XML",
        "source_updated_at": row.get("LAST_UPDATE_DATE") or None,
    }


def normalize_td_route_stop(row, operator):
    route_id = row.get("ROUTE_ID")
    route_seq = row.get("ROUTE_SEQ") or "1"
    stop_id = row.get("STOP_ID")
    return {
        "id": f"{operator}:{route_id}:{route_seq}:{row.get('STOP_SEQ')}:{stop_id}",
        "operator": operator,
        "route_id": route_id,
        "route_variant_id": f"{operator}:{route_id}:{route_seq}",
        "direction": route_seq,
        "service_type": None,
        "sequence": parse_int(row.get("STOP_SEQ")),
        "stop_id": stop_id,
        "pickup_dropoff": row.get("STOP_PICK_DROP") or None,
        "stop_name": build_name_block(row.get("STOP_NAMEC"), row.get("STOP_NAMEE"), row.get("STOP_NAMES")),
        "source_updated_at": row.get("LAST_UPDATE_DATE") or None,
    }


def normalize_td_stop(stop_id, operator, stop_row, stop_name_row=None):
    stop_row = stop_row or {}
    stop_name_row = stop_name_row or {}
    return {
        "id": f"{operator}:{stop_id}",
        "operator": operator,
        "stop_id": stop_id,
        "name": build_name_block(
            stop_name_row.get("STOP_NAMEC"),
            stop_name_row.get("STOP_NAMEE"),
            stop_name_row.get("STOP_NAMES"),
        ),
        "lat": None,
        "lng": None,
        "grid_northing": parse_float(stop_row.get("Y")),
        "grid_easting": parse_float(stop_row.get("X")),
        "coordinate_system": "HK1980_GRID" if stop_row.get("X") and stop_row.get("Y") else None,
        "stop_type": stop_row.get("STOP_TYPE") or None,
        "source_updated_at": stop_row.get("LAST_UPDATE_DATE") or stop_name_row.get("LAST_UPDATE_DATE") or None,
    }


def normalize_td_fare(row, operator):
    route_id = row.get("ROUTE_ID")
    route_seq = row.get("ROUTE_SEQ") or "1"
    return {
        "id": f"{operator}:{route_id}:{route_seq}:{row.get('ON_SEQ')}:{row.get('OFF_SEQ')}",
        "operator": operator,
        "route_id": route_id,
        "route_variant_id": f"{operator}:{route_id}:{route_seq}",
        "direction": route_seq,
        "on_sequence": parse_int(row.get("ON_SEQ")),
        "off_sequence": parse_int(row.get("OFF_SEQ")),
        "amount": parse_float(row.get("PRICE")),
        "currency": "HKD" if row.get("PRICE") else None,
        "source": "TD section fare XML",
        "source_updated_at": row.get("LAST_UPDATE_DATE") or None,
    }


def build_citybus_dataset():
    cache_key = "dataset:citybus"
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached

    route_rows = fetch_xml_rows(TD_ROUTE_BUS_XML, "ROUTE")
    route_rows = [row for row in route_rows if company_matches(row.get("COMPANY_CODE"), "CTB")]
    route_ids = {row.get("ROUTE_ID") for row in route_rows}

    route_stop_rows = fetch_xml_rows(TD_RSTOP_BUS_XML, "RSTOP")
    route_stop_rows = [row for row in route_stop_rows if row.get("ROUTE_ID") in route_ids]
    stop_name_rows = {}
    for row in route_stop_rows:
        stop_name_rows.setdefault(row.get("STOP_ID"), row)

    stop_ids = set(stop_name_rows.keys())
    stop_rows = fetch_xml_rows(TD_STOP_BUS_XML, "STOP")
    stop_rows = [row for row in stop_rows if row.get("STOP_ID") in stop_ids]
    stop_map = {row.get("STOP_ID"): row for row in stop_rows}

    fare_rows = fetch_xml_rows(TD_FARE_BUS_XML, "FARE")
    fare_rows = [row for row in fare_rows if row.get("ROUTE_ID") in route_ids]

    dataset = {
        "operator": "CTB",
        "sources": {
            "routes": TD_ROUTE_BUS_XML,
            "route_stops": TD_RSTOP_BUS_XML,
            "stops": TD_STOP_BUS_XML,
            "fares": TD_FARE_BUS_XML,
            "eta": "https://rt.data.gov.hk/v2/transport/citybus/eta/ctb/{stop_id}/{route}",
        },
        "routes": [normalize_td_route(row, "CTB") for row in route_rows],
        "route_stops": [normalize_td_route_stop(row, "CTB") for row in route_stop_rows],
        "stops": [normalize_td_stop(stop_id, "CTB", stop_map.get(stop_id), stop_name_rows.get(stop_id)) for stop_id in sorted(stop_ids)],
        "fares": [normalize_td_fare(row, "CTB") for row in fare_rows],
        "limitations": [
            "Static Citybus stop coordinates are provided in HK1980 grid from TD data; WGS84 lat/lng can be resolved on demand through the geo helper.",
            "Live ETA comes from Citybus V2 by stop and route; exact matching still depends on the Citybus stop ID used for the ETA query.",
        ],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return set_cached_value(cache_key, dataset, STATIC_TTL_SECONDS)


def build_tram_dataset():
    cache_key = "dataset:tram"
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached

    route_rows = fetch_xml_rows(TD_ROUTE_TRAM_XML, "ROUTE")
    route_ids = {row.get("ROUTE_ID") for row in route_rows}

    route_stop_rows = fetch_xml_rows(TD_RSTOP_TRAM_XML, "RSTOP")
    route_stop_rows = [row for row in route_stop_rows if row.get("ROUTE_ID") in route_ids]
    stop_name_rows = {}
    for row in route_stop_rows:
        stop_name_rows.setdefault(row.get("STOP_ID"), row)

    stop_ids = set(stop_name_rows.keys())
    stop_rows = fetch_xml_rows(TD_STOP_TRAM_XML, "STOP")
    stop_rows = [row for row in stop_rows if row.get("STOP_ID") in stop_ids]
    stop_map = {row.get("STOP_ID"): row for row in stop_rows}

    fare_rows = fetch_xml_rows(TD_FARE_TRAM_XML, "FARE")
    fare_rows = [row for row in fare_rows if row.get("ROUTE_ID") in route_ids]

    dataset = {
        "operator": "TRAM",
        "sources": {
            "routes": TD_ROUTE_TRAM_XML,
            "route_stops": TD_RSTOP_TRAM_XML,
            "stops": TD_STOP_TRAM_XML,
            "fares": TD_FARE_TRAM_XML,
        },
        "routes": [normalize_td_route(row, "TRAM") for row in route_rows],
        "route_stops": [normalize_td_route_stop(row, "TRAM") for row in route_stop_rows],
        "stops": [normalize_td_stop(stop_id, "TRAM", stop_map.get(stop_id), stop_name_rows.get(stop_id)) for stop_id in sorted(stop_ids)],
        "fares": [normalize_td_fare(row, "TRAM") for row in fare_rows],
        "limitations": [
            "Hong Kong Tramways stop coordinates are provided in HK1980 grid from TD data; WGS84 lat/lng can be resolved on demand through the geo helper.",
            "No operator ETA feed is integrated for Hong Kong Tramways in this pass.",
        ],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return set_cached_value(cache_key, dataset, STATIC_TTL_SECONDS)


def build_mtr_dataset():
    cache_key = "dataset:mtr"
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached

    line_rows = fetch_csv_rows(MTR_LINES_URL)
    fare_rows = fetch_csv_rows(MTR_FARES_URL)

    route_groups = {}
    stops = {}
    route_stops = []

    for row in line_rows:
        line_code = (row.get("Line Code") or "").strip()
        direction = (row.get("Direction") or "").strip()
        station_code = (row.get("Station Code") or "").strip()
        station_id = str(parse_int(row.get("Station ID")) or row.get("Station ID") or "").strip()
        route_variant_id = f"MTR:{line_code}:{direction}"

        route_groups.setdefault(route_variant_id, {
            "id": route_variant_id,
            "operator": "MTR",
            "route_id": line_code,
            "route": line_code,
            "line": line_code,
            "display_route": line_code,
            "route_name": build_name_block(None, line_code, None),
            "direction": direction or None,
            "service_type": "RAIL",
            "route_type": "RAIL",
            "special_type": None,
            "journey_time_minutes": None,
            "origin": None,
            "destination": None,
            "fare": None,
            "fare_currency": None,
            "source": "MTR lines and stations CSV",
            "source_updated_at": None,
        })

        if station_id and station_id not in stops:
            stops[station_id] = {
                "id": f"MTR:{station_id}",
                "operator": "MTR",
                "stop_id": station_id,
                "station_code": station_code or None,
                "name": build_name_block(row.get("Chinese Name"), row.get("English Name"), None),
                "lat": None,
                "lng": None,
                "grid_northing": None,
                "grid_easting": None,
                "coordinate_system": None,
                "stop_type": "station",
                "source_updated_at": None,
            }

        route_stops.append({
            "id": f"{route_variant_id}:{row.get('Sequence')}",
            "operator": "MTR",
            "route_id": line_code,
            "route_variant_id": route_variant_id,
            "direction": direction or None,
            "service_type": "RAIL",
            "sequence": parse_int(row.get("Sequence")),
            "stop_id": station_id,
            "station_code": station_code or None,
            "stop_name": build_name_block(row.get("Chinese Name"), row.get("English Name"), None),
            "pickup_dropoff": None,
            "source_updated_at": None,
        })

    route_stop_groups = {}
    for row in route_stops:
        route_stop_groups.setdefault(row["route_variant_id"], []).append(row)

    for route_variant_id, route in route_groups.items():
        ordered = sorted(route_stop_groups.get(route_variant_id, []), key=lambda item: item["sequence"] or 0)
        if ordered:
            route["origin"] = ordered[0]["stop_name"]
            route["destination"] = ordered[-1]["stop_name"]

    normalized_fares = []
    for row in fare_rows:
        src_station_id = str(parse_int(row.get("SRC_STATION_ID")) or row.get("SRC_STATION_ID") or "").strip()
        dest_station_id = str(parse_int(row.get("DEST_STATION_ID")) or row.get("DEST_STATION_ID") or "").strip()
        normalized_fares.append({
            "id": f"MTR:{src_station_id}:{dest_station_id}",
            "operator": "MTR",
            "src_stop_id": src_station_id,
            "dest_stop_id": dest_station_id,
            "fare_rule": {
                "octopus_adult": parse_float(row.get("OCT_ADT_FARE")),
                "single_adult": parse_float(row.get("SINGLE_ADT_FARE")),
                "octopus_student": parse_float(row.get("OCT_STD_FARE")),
                "joyyou_sixty": parse_float(row.get("OCT_JOYYOU_SIXTY_FARE")),
                "octopus_child": parse_float(row.get("OCT_CON_CHILD_FARE")),
                "octopus_elderly": parse_float(row.get("OCT_CON_ELDERLY_FARE")),
                "octopus_pwd": parse_float(row.get("OCT_CON_PWD_FARE")),
                "single_child": parse_float(row.get("SINGLE_CON_CHILD_FARE")),
                "single_elderly": parse_float(row.get("SINGLE_CON_ELDERLY_FARE")),
            },
            "currency": "HKD",
            "source": "MTR lines fares CSV",
        })

    dataset = {
        "operator": "MTR",
        "sources": {
            "lines_and_stations": MTR_LINES_URL,
            "fares": MTR_FARES_URL,
            "eta": "https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line={line}&sta={station}",
        },
        "routes": list(route_groups.values()),
        "route_stops": route_stops,
        "stops": list(stops.values()),
        "fares": normalized_fares,
        "limitations": [
            "The official line/station and fare CSVs do not include WGS84 station coordinates, so stop lat/lng remain null in this pass.",
            "Heavy rail ETA is available through MTR's real-time schedule API, but only for supported line/station combinations.",
        ],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return set_cached_value(cache_key, dataset, STATIC_TTL_SECONDS)


def citybus_stop_id_candidates(stop_id):
    raw = str(stop_id or "").strip()
    values = []
    for candidate in (raw, raw.zfill(6), raw.lstrip("0")):
        candidate = (candidate or "").strip()
        if candidate and candidate not in values:
            values.append(candidate)
    return values


def build_citybus_eta(stop_id, route):
    route = str(route or "").strip()
    for candidate in citybus_stop_id_candidates(stop_id):
        url = CITYBUS_ETA_URL.format(stop_id=urllib.parse.quote(candidate), route=urllib.parse.quote(route))
        try:
            payload = fetch_json(url, ttl_seconds=ETA_TTL_SECONDS)
        except Exception:
            continue
        items = payload.get("data") or []
        if items:
            return {
                "operator": "CTB",
                "stop_id": candidate,
                "route": route,
                "data": [
                    {
                        "operator": "CTB",
                        "route": item.get("route"),
                        "stop_id": item.get("stop"),
                        "direction": item.get("dir"),
                        "sequence": parse_int(item.get("seq")),
                        "eta_sequence": parse_int(item.get("eta_seq")),
                        "eta": item.get("eta") or None,
                        "destination": build_name_block(item.get("dest_tc"), item.get("dest_en"), item.get("dest_sc")),
                        "remark": build_name_block(item.get("rmk_tc"), item.get("rmk_en"), item.get("rmk_sc")),
                        "data_timestamp": item.get("data_timestamp") or None,
                    }
                    for item in items
                ],
                "source": url,
            }
    return {
        "operator": "CTB",
        "stop_id": str(stop_id or "").strip(),
        "route": route,
        "data": [],
        "source": "https://rt.data.gov.hk/v2/transport/citybus/eta/ctb/{stop_id}/{route}",
    }


def build_citybus_stop(stop_id):
    for candidate in citybus_stop_id_candidates(stop_id):
        url = CITYBUS_STOP_URL.format(stop_id=urllib.parse.quote(candidate))
        try:
            payload = fetch_json(url, ttl_seconds=STATIC_TTL_SECONDS)
        except Exception:
            continue
        data = payload.get("data") or {}
        if data.get("stop"):
            return {
                "operator": "CTB",
                "stop": {
                    "id": f"CTB:{data.get('stop')}",
                    "operator": "CTB",
                    "stop_id": data.get("stop"),
                    "name": build_name_block(data.get("name_tc"), data.get("name_en"), data.get("name_sc")),
                    "lat": parse_float(data.get("lat")),
                    "lng": parse_float(data.get("long")),
                    "grid_northing": None,
                    "grid_easting": None,
                    "coordinate_system": "WGS84",
                    "stop_type": "stop",
                    "source_updated_at": data.get("data_timestamp") or None,
                },
                "source": url,
            }
    return {"operator": "CTB", "stop": None, "source": "https://rt.data.gov.hk/v2/transport/citybus/stop/{stop_id}"}


def build_mtr_eta(line, station):
    safe_line = urllib.parse.quote(str(line or "").strip())
    safe_station = urllib.parse.quote(str(station or "").strip())
    url = MTR_TRAIN_ETA_URL.format(line=safe_line, station=safe_station)
    payload = fetch_json(url, ttl_seconds=ETA_TTL_SECONDS)
    return {
        "operator": "MTR",
        "line": str(line or "").strip(),
        "station": str(station or "").strip(),
        "data": payload,
        "source": url,
    }


def build_hk80_to_wgs84(easting, northing):
    safe_easting = parse_float(easting)
    safe_northing = parse_float(northing)
    if safe_easting is None or safe_northing is None:
        return {"error": "Missing or invalid easting/northing"}

    url = COORD_TRANSFORM_URL.format(
        northing=urllib.parse.quote(str(safe_northing)),
        easting=urllib.parse.quote(str(safe_easting)),
    )
    payload = fetch_json(url, ttl_seconds=GEO_TTL_SECONDS)
    return {
        "grid_easting": safe_easting,
        "grid_northing": safe_northing,
        "lat": parse_float(payload.get("wgsLat")),
        "lng": parse_float(payload.get("wgsLong")),
        "source": url,
    }


class handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status_code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "public, max-age=60")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        path = parsed_path.path
        query_params = urllib.parse.parse_qs(parsed_path.query)

        try:
            if path == "/api/operators/citybus/dataset":
                return self.send_json(build_citybus_dataset())
            if path == "/api/operators/tram/dataset":
                return self.send_json(build_tram_dataset())
            if path == "/api/operators/mtr/dataset":
                return self.send_json(build_mtr_dataset())
            if path.startswith("/api/operators/citybus/eta/"):
                eta_path = path.replace("/api/operators/citybus/eta/", "", 1)
                stop_id, _, route = eta_path.partition("/")
                return self.send_json(build_citybus_eta(stop_id, route))
            if path.startswith("/api/operators/citybus/stop/"):
                stop_id = path.rsplit("/", 1)[-1]
                return self.send_json(build_citybus_stop(stop_id))
            if path == "/api/operators/mtr/eta":
                line = (query_params.get("line") or [""])[0]
                station = (query_params.get("station") or [""])[0]
                return self.send_json(build_mtr_eta(line, station))
            if path == "/api/operators/geo/hk80-to-wgs84":
                easting = (query_params.get("e") or [""])[0]
                northing = (query_params.get("n") or [""])[0]
                payload = build_hk80_to_wgs84(easting, northing)
                status = 400 if payload.get("error") else 200
                return self.send_json(payload, status_code=status)

            self.send_response(404)
            self.end_headers()
        except Exception as exc:
            self.send_json({"error": str(exc)}, status_code=500)
