import csv
import io
import json
import math
import os
import re
import subprocess
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
LOCATION_SEARCH_URL = "https://geodata.gov.hk/gs/api/v1.0.0/locationSearch?q={query}"

COORD_TRANSFORM_URL = "https://www.geodetic.gov.hk/transform/v2/?inSys=hkgrid&outSys=wgsgeog&n={northing}&e={easting}"
MTR_MANUAL_COORDINATE_FILE = os.path.join(os.path.dirname(__file__), "mtr_station_coordinates.manual.json")

CACHE = {}

HK80_A = 6378388.0
HK80_RF = 297.0
HK80_B = HK80_A * (1.0 - 1.0 / HK80_RF)
HK80_E2 = (HK80_A**2 - HK80_B**2) / (HK80_A**2)
HK80_LAT0 = math.radians(22.312133333333334)
HK80_LON0 = math.radians(114.17855555555556)
HK80_FALSE_EASTING = 836694.05
HK80_FALSE_NORTHING = 819069.8
HK80_SCALE = 1.0

WGS84_A = 6378137.0
WGS84_RF = 298.257223563
WGS84_B = WGS84_A * (1.0 - 1.0 / WGS84_RF)
WGS84_E2 = (WGS84_A**2 - WGS84_B**2) / (WGS84_A**2)

HK80_TO_WGS84_TX = -162.619
HK80_TO_WGS84_TY = -276.959
HK80_TO_WGS84_TZ = -161.764
HK80_TO_WGS84_RX = math.radians(-0.067753 / 3600.0)
HK80_TO_WGS84_RY = math.radians(2.243648 / 3600.0)
HK80_TO_WGS84_RZ = math.radians(1.158828 / 3600.0)
HK80_TO_WGS84_SCALE = -1.094246 * 1e-6


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
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = response.read().decode("utf-8-sig")
    except Exception:
        if os.name != "nt":
            raise
        safe_url = str(url).replace("'", "''")
        command = (
            f"$content = (Invoke-WebRequest -UseBasicParsing -Uri '{safe_url}' -TimeoutSec 30).Content; "
            "Write-Output $content"
        )
        payload = subprocess.check_output(
            ["powershell", "-Command", command],
            text=True,
            encoding="utf-8",
            timeout=40,
        ).lstrip("\ufeff")
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


def canonicalize_name(value):
    if value in (None, ""):
        return ""
    return re.sub(r"[^a-z0-9]+", "", str(value).strip().lower())


def build_name_block(tc=None, en=None, sc=None):
    return {
        "tc": tc or None,
        "en": en or None,
        "sc": sc or None,
    }


def load_manual_mtr_coordinate_seed():
    cache_key = "manual:mtr-coordinate-seed"
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached

    try:
        with open(MTR_MANUAL_COORDINATE_FILE, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        payload = {"stations": {}}

    stations = payload.get("stations") or {}
    return set_cached_value(cache_key, stations, STATIC_TTL_SECONDS)


def meridional_arc(lat_rad):
    n = (HK80_A - HK80_B) / (HK80_A + HK80_B)
    n2 = n * n
    n3 = n2 * n
    n4 = n2 * n2
    return HK80_B * HK80_SCALE * (
        (1 + n + (5.0 / 4.0) * (n2 + n3) + (81.0 / 64.0) * n4) * (lat_rad - HK80_LAT0)
        - (3 * n + 3 * n2 + (21.0 / 8.0) * n3 + (55.0 / 8.0) * n4) * math.sin(lat_rad - HK80_LAT0) * math.cos(lat_rad + HK80_LAT0)
        + ((15.0 / 8.0) * (n2 + n3) + (35.0 / 24.0) * n4) * math.sin(2 * (lat_rad - HK80_LAT0)) * math.cos(2 * (lat_rad + HK80_LAT0))
        - ((35.0 / 24.0) * n3 + (105.0 / 64.0) * n4) * math.sin(3 * (lat_rad - HK80_LAT0)) * math.cos(3 * (lat_rad + HK80_LAT0))
        + (315.0 / 512.0) * n4 * math.sin(4 * (lat_rad - HK80_LAT0)) * math.cos(4 * (lat_rad + HK80_LAT0))
    )


def hk80_grid_to_geodetic(easting, northing):
    lat = ((northing - HK80_FALSE_NORTHING) / (HK80_A * HK80_SCALE)) + HK80_LAT0
    for _ in range(8):
        lat += (northing - HK80_FALSE_NORTHING - meridional_arc(lat)) / (HK80_A * HK80_SCALE)

    sin_lat = math.sin(lat)
    cos_lat = math.cos(lat)
    tan_lat = math.tan(lat)
    nu = HK80_A * HK80_SCALE / math.sqrt(1 - HK80_E2 * sin_lat * sin_lat)
    rho = HK80_A * HK80_SCALE * (1 - HK80_E2) / ((1 - HK80_E2 * sin_lat * sin_lat) ** 1.5)
    eta2 = nu / rho - 1
    d_east = easting - HK80_FALSE_EASTING

    vii = tan_lat / (2 * rho * nu)
    viii = tan_lat / (24 * rho * (nu**3)) * (5 + 3 * tan_lat * tan_lat + eta2 - 9 * tan_lat * tan_lat * eta2)
    ix = tan_lat / (720 * rho * (nu**5)) * (61 + 90 * tan_lat * tan_lat + 45 * (tan_lat**4))
    x = 1 / (cos_lat * nu)
    xi = (1 / (cos_lat * (nu**3))) * (nu / rho + 2 * tan_lat * tan_lat) / 6
    xii = (1 / (cos_lat * (nu**5))) * (5 + 28 * tan_lat * tan_lat + 24 * (tan_lat**4)) / 120
    xiia = (1 / (cos_lat * (nu**7))) * (61 + 662 * tan_lat * tan_lat + 1320 * (tan_lat**4) + 720 * (tan_lat**6)) / 5040

    lat_rad = lat - vii * (d_east**2) + viii * (d_east**4) - ix * (d_east**6)
    lon_rad = HK80_LON0 + x * d_east - xi * (d_east**3) + xii * (d_east**5) - xiia * (d_east**7)
    return lat_rad, lon_rad


def geodetic_to_cartesian(lat_rad, lon_rad, height, semi_major, eccentricity2):
    sin_lat = math.sin(lat_rad)
    cos_lat = math.cos(lat_rad)
    sin_lon = math.sin(lon_rad)
    cos_lon = math.cos(lon_rad)
    nu = semi_major / math.sqrt(1 - eccentricity2 * sin_lat * sin_lat)
    x = (nu + height) * cos_lat * cos_lon
    y = (nu + height) * cos_lat * sin_lon
    z = (nu * (1 - eccentricity2) + height) * sin_lat
    return x, y, z


def cartesian_to_geodetic(x, y, z, semi_major, eccentricity2):
    lon = math.atan2(y, x)
    p = math.sqrt(x * x + y * y)
    lat = math.atan2(z, p * (1 - eccentricity2))
    for _ in range(8):
        sin_lat = math.sin(lat)
        nu = semi_major / math.sqrt(1 - eccentricity2 * sin_lat * sin_lat)
        lat = math.atan2(z + eccentricity2 * nu * sin_lat, p)
    return lat, lon


def apply_helmert_transform(x, y, z):
    scale = 1 + HK80_TO_WGS84_SCALE
    new_x = HK80_TO_WGS84_TX + scale * (x + HK80_TO_WGS84_RZ * y - HK80_TO_WGS84_RY * z)
    new_y = HK80_TO_WGS84_TY + scale * (-HK80_TO_WGS84_RZ * x + y + HK80_TO_WGS84_RX * z)
    new_z = HK80_TO_WGS84_TZ + scale * (HK80_TO_WGS84_RY * x - HK80_TO_WGS84_RX * y + z)
    return new_x, new_y, new_z


def convert_hk80_to_wgs84(easting, northing):
    cache_key = f"coord:{easting}:{northing}"
    cached = get_cached_value(cache_key)
    if cached is not None:
        return cached

    safe_easting = parse_float(easting)
    safe_northing = parse_float(northing)
    if safe_easting is None or safe_northing is None:
        return None

    hk_lat, hk_lon = hk80_grid_to_geodetic(safe_easting, safe_northing)
    x, y, z = geodetic_to_cartesian(hk_lat, hk_lon, 0.0, HK80_A, HK80_E2)
    wgs_x, wgs_y, wgs_z = apply_helmert_transform(x, y, z)
    wgs_lat, wgs_lon = cartesian_to_geodetic(wgs_x, wgs_y, wgs_z, WGS84_A, WGS84_E2)
    return set_cached_value(
        cache_key,
        {
            "lat": round(math.degrees(wgs_lat), 9),
            "lng": round(math.degrees(wgs_lon), 9),
        },
        GEO_TTL_SECONDS,
    )


def enrich_wgs84_coordinates(record):
    if not isinstance(record, dict):
        return record
    if record.get("lat") is not None and record.get("lng") is not None:
        return record
    coords = convert_hk80_to_wgs84(record.get("grid_easting"), record.get("grid_northing"))
    if not coords:
        return record
    enriched = dict(record)
    enriched["lat"] = coords["lat"]
    enriched["lng"] = coords["lng"]
    enriched["coordinate_system"] = "WGS84"
    enriched["coordinate_source"] = "TD HK1980 grid converted locally to WGS84"
    return enriched


def fetch_location_search(query):
    query = str(query or "").strip()
    if not query:
        return []
    url = LOCATION_SEARCH_URL.format(query=urllib.parse.quote(query))
    payload = fetch_json(url, ttl_seconds=STATIC_TTL_SECONDS)
    return payload if isinstance(payload, list) else []


def station_query_variants(name_block):
    english = (name_block or {}).get("en")
    chinese = (name_block or {}).get("tc")
    variants = []
    for candidate in (
        f"{english} Station" if english and not english.lower().endswith("station") else english,
        english,
        chinese,
        f"{chinese}{station_suffix}" if chinese and not str(chinese).endswith(station_suffix) else chinese,
    ):
        candidate = str(candidate or "").strip()
        if candidate and candidate not in variants:
            variants.append(candidate)
    return variants


def score_location_result(result, name_block, query):
    english = (name_block or {}).get("en") or ""
    chinese = (name_block or {}).get("tc") or ""
    name_en = result.get("nameEN") or ""
    address_en = result.get("addressEN") or ""
    name_zh = result.get("nameZH") or ""
    address_zh = result.get("addressZH") or ""

    exact_en_targets = {
        english,
        f"{english} Station" if english and not english.lower().endswith("station") else english,
    }
    exact_zh_targets = {chinese, f"{chinese}{station_suffix}" if chinese and not chinese.endswith(station_suffix) else chinese}

    score = 0
    if name_en in exact_en_targets:
        score += 80
    if address_en in exact_en_targets:
        score += 60
    if name_zh in exact_zh_targets:
        score += 80
    if address_zh in exact_zh_targets:
        score += 60
    if "MTR" in name_en or "Mass Transit Railway" in address_en:
        score += 10
    if canonicalize_name(query) and canonicalize_name(query) == canonicalize_name(name_en):
        score += 25
    if canonicalize_name(english) and canonicalize_name(english) == canonicalize_name(name_en):
        score += 20
    if chinese and chinese == name_zh:
        score += 20
    if "Exit" in name_en or "Access" in name_en:
        score -= 25
    if "Other Name" in name_en or "Previous Name" in name_en:
        score -= 20
    return score


def station_query_variants(name_block):
    english = (name_block or {}).get("en")
    chinese = (name_block or {}).get("tc")
    station_suffix = "\u7ad9"
    variants = []
    for candidate in (
        f"{english} Station" if english and not english.lower().endswith("station") else english,
        english,
        chinese,
        f"{chinese}{station_suffix}" if chinese and not str(chinese).endswith(station_suffix) else chinese,
    ):
        candidate = str(candidate or "").strip()
        if candidate and candidate not in variants:
            variants.append(candidate)
    return variants


def score_location_result(result, name_block, query):
    english = (name_block or {}).get("en") or ""
    chinese = (name_block or {}).get("tc") or ""
    station_suffix = "\u7ad9"
    name_en = result.get("nameEN") or ""
    address_en = result.get("addressEN") or ""
    name_zh = result.get("nameZH") or ""
    address_zh = result.get("addressZH") or ""

    exact_en_targets = {
        english,
        f"{english} Station" if english and not english.lower().endswith("station") else english,
    }
    exact_zh_targets = {chinese, f"{chinese}{station_suffix}" if chinese and not chinese.endswith(station_suffix) else chinese}

    score = 0
    if name_en in exact_en_targets:
        score += 80
    if address_en in exact_en_targets:
        score += 60
    if name_zh in exact_zh_targets:
        score += 80
    if address_zh in exact_zh_targets:
        score += 60
    if "MTR" in name_en or "Mass Transit Railway" in address_en:
        score += 10
    if canonicalize_name(query) and canonicalize_name(query) == canonicalize_name(name_en):
        score += 25
    if canonicalize_name(english) and canonicalize_name(english) == canonicalize_name(name_en):
        score += 20
    if chinese and chinese == name_zh:
        score += 20
    if "Exit" in name_en or "Access" in name_en:
        score -= 25
    if "Other Name" in name_en or "Previous Name" in name_en:
        score -= 20
    return score


def find_mtr_station_location(name_block):
    best_result = None
    best_score = float("-inf")
    best_query = None

    for query in station_query_variants(name_block):
        for result in fetch_location_search(query):
            score = score_location_result(result, name_block, query)
            if score > best_score:
                best_result = result
                best_score = score
                best_query = query

    if best_result is None or best_score < 80:
        return None

    return {
        "query": best_query,
        "result": best_result,
    }


def enrich_mtr_station(stop):
    manual_seed = load_manual_mtr_coordinate_seed()
    manual = manual_seed.get(stop.get("stop_id")) or manual_seed.get(stop.get("station_code"))
    if manual:
        enriched = dict(stop)
        enriched["lat"] = parse_float(manual.get("lat"))
        enriched["lng"] = parse_float(manual.get("lng"))
        enriched["coordinate_system"] = "WGS84" if enriched["lat"] is not None and enriched["lng"] is not None else stop.get("coordinate_system")
        enriched["coordinate_source"] = manual.get("source") or "Manual MTR station seed"
        return enriched

    location = find_mtr_station_location(stop.get("name"))
    if not location:
        return stop

    grid_easting = parse_float(location["result"].get("x"))
    grid_northing = parse_float(location["result"].get("y"))
    coords = convert_hk80_to_wgs84(grid_easting, grid_northing)
    if not coords:
        return stop

    enriched = dict(stop)
    enriched["grid_easting"] = grid_easting
    enriched["grid_northing"] = grid_northing
    enriched["lat"] = coords["lat"]
    enriched["lng"] = coords["lng"]
    enriched["coordinate_system"] = "WGS84"
    enriched["coordinate_source"] = f"LandsD Location Search API ({location['query']})"
    return enriched


def build_coordinate_validation(operator_key, records, noun):
    total = len(records)
    with_wgs84 = []
    unresolved = []
    invalid = []
    for record in records:
        lat = parse_float(record.get("lat"))
        lng = parse_float(record.get("lng"))
        if lat is None or lng is None:
            unresolved.append({
                "id": record.get("id"),
                "stop_id": record.get("stop_id"),
                "station_code": record.get("station_code"),
                "name": record.get("name"),
                "grid_easting": record.get("grid_easting"),
                "grid_northing": record.get("grid_northing"),
            })
            continue
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            invalid.append({
                "id": record.get("id"),
                "stop_id": record.get("stop_id"),
                "station_code": record.get("station_code"),
                "lat": lat,
                "lng": lng,
            })
            continue
        with_wgs84.append(record)

    return {
        "operator": operator_key,
        f"total_{noun}": total,
        f"{noun}_with_wgs84": len(with_wgs84),
        f"unresolved_{noun}": unresolved,
        f"invalid_{noun}": invalid,
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
    return enrich_wgs84_coordinates({
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
    })


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
    normalized_stops = [normalize_td_stop(stop_id, "CTB", stop_map.get(stop_id), stop_name_rows.get(stop_id)) for stop_id in sorted(stop_ids)]

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
        "stops": normalized_stops,
        "fares": [normalize_td_fare(row, "CTB") for row in fare_rows],
        "validation": build_coordinate_validation("citybus", normalized_stops, "stops"),
        "limitations": [
            "Static Citybus stop coordinates are enriched to WGS84 at dataset build time from TD HK1980 grid coordinates.",
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

    normalized_stops = [normalize_td_stop(stop_id, "TRAM", stop_map.get(stop_id), stop_name_rows.get(stop_id)) for stop_id in sorted(stop_ids)]

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
        "stops": normalized_stops,
        "fares": [normalize_td_fare(row, "TRAM") for row in fare_rows],
        "validation": build_coordinate_validation("tram", normalized_stops, "stops"),
        "limitations": [
            "Hong Kong Tramways stop coordinates are enriched to WGS84 at dataset build time from TD HK1980 grid coordinates.",
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

    manual_seed = load_manual_mtr_coordinate_seed()
    # Keep the route API fast: station coordinates should come from the cached/manual
    # seed file, not from 100+ live LandsD lookups during a user search.
    if manual_seed:
        enriched_stops = []
        for stop in stops.values():
            manual = manual_seed.get(stop.get("stop_id")) or manual_seed.get(stop.get("station_code"))
            if manual:
                enriched = dict(stop)
                enriched["lat"] = parse_float(manual.get("lat"))
                enriched["lng"] = parse_float(manual.get("lng"))
                enriched["coordinate_system"] = "WGS84" if enriched["lat"] is not None and enriched["lng"] is not None else stop.get("coordinate_system")
                enriched["coordinate_source"] = manual.get("source") or "Manual MTR station seed"
                enriched_stops.append(enriched)
            else:
                enriched_stops.append(stop)
    else:
        enriched_stops = list(stops.values())

    dataset = {
        "operator": "MTR",
        "sources": {
            "lines_and_stations": MTR_LINES_URL,
            "fares": MTR_FARES_URL,
            "eta": "https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line={line}&sta={station}",
        },
        "routes": list(route_groups.values()),
        "route_stops": route_stops,
        "stops": enriched_stops,
        "fares": normalized_fares,
        "validation": build_coordinate_validation("mtr", enriched_stops, "stations"),
        "limitations": [
            "The official line/station CSV does not include coordinates, so station WGS84 values come from the manual/open-source seed file when available.",
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

    payload = convert_hk80_to_wgs84(safe_easting, safe_northing)
    if not payload:
        return {"error": "Failed to convert coordinates"}

    url = COORD_TRANSFORM_URL.format(
        northing=urllib.parse.quote(str(safe_northing)),
        easting=urllib.parse.quote(str(safe_easting)),
    )
    return {
        "grid_easting": safe_easting,
        "grid_northing": safe_northing,
        "lat": parse_float(payload.get("lat")),
        "lng": parse_float(payload.get("lng")),
        "source": "Local HK1980 -> WGS84 transform using HK80 TM inverse + 7-parameter Helmert",
        "reference": url,
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


