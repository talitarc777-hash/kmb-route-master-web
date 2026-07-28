import os
from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import json
import re
import time

CSDI_BUS_ROUTE_QUERY_URL = (
    "https://portal.csdi.gov.hk/server/rest/services/common/"
    "td_rcd_1638844988873_41214/FeatureServer/0/query"
)
TD_SERVICE_ALERTS_URL = "https://www.td.gov.hk/en/special_news/trafficnews.xml"
ALLOWED_GOOGLE_PATHS = {"geocode/json", "directions/json", "place/autocomplete/json"}
ALLOWED_DIRECTIONS_MODES = {"walking", "driving", "transit"}
HK_BOUNDS = {"min_lat": 21.8, "max_lat": 22.7, "min_lng": 113.7, "max_lng": 114.6}

def normalize_hk_coordinate(value):
    parts = str(value or "").split(",")
    if len(parts) != 2:
        return None
    try:
        lat, lng = (float(part) for part in parts)
    except (TypeError, ValueError):
        return None
    if not (HK_BOUNDS["min_lat"] <= lat <= HK_BOUNDS["max_lat"]):
        return None
    if not (HK_BOUNDS["min_lng"] <= lng <= HK_BOUNDS["max_lng"]):
        return None
    return f"{lat},{lng}"

def build_google_query(subpath, incoming_query, api_key):
    value = lambda name: str(incoming_query.get(name, [""])[0]).strip()
    if subpath == "place/autocomplete/json":
        input_text = value("input")
        if len(input_text) < 3 or len(input_text) > 200:
            return None
        return {
            "input": [input_text],
            "components": ["country:hk"],
            "language": ["zh-TW"],
            "location": ["22.3193,114.1694"],
            "radius": ["50000"],
            "key": [api_key],
        }
    if subpath == "geocode/json":
        place_id = value("place_id")
        if place_id:
            if not re.fullmatch(r"[A-Za-z0-9_-]{5,300}", place_id):
                return None
            return {"place_id": [place_id], "key": [api_key]}
        address = value("address")
        if not address or len(address) > 200:
            return None
        return {"address": [address], "components": ["country:hk"], "key": [api_key]}

    origin = normalize_hk_coordinate(value("origin"))
    destination = normalize_hk_coordinate(value("destination"))
    mode = value("mode").lower()
    if not origin or not destination or mode not in ALLOWED_DIRECTIONS_MODES:
        return None

    query = {
        "origin": [origin],
        "destination": [destination],
        "mode": [mode],
        "key": [api_key],
    }
    waypoints_text = value("waypoints")
    if waypoints_text:
        waypoints = [normalize_hk_coordinate(point) for point in waypoints_text.split("|")]
        if len(waypoints) > 23 or any(point is None for point in waypoints):
            return None
        query["waypoints"] = ["|".join(waypoints)]
    if mode == "transit":
        query["transit_mode"] = ["bus"]
    if value("alternatives") == "true":
        query["alternatives"] = ["true"]
    for time_key in ("departure_time", "arrival_time"):
        time_value = value(time_key)
        if re.fullmatch(r"\d{9,12}", time_value):
            query[time_key] = [time_value]
    return query

class handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status_code=200, cache_control="no-store"):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', cache_control)
        self.end_headers()
        self.wfile.write(body)

    def fetch_upstream_bytes(self, target_url, headers, timeout_sec=25, retries=2):
        last_error = None
        for attempt in range(retries + 1):
            try:
                req = urllib.request.Request(target_url, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout_sec) as response:
                    return response.read()
            except Exception as exc:
                last_error = exc
                if attempt < retries:
                    time.sleep(0.35 * (attempt + 1))
        raise last_error

    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        path = parsed_path.path
        cache_control = "no-store"
        content_type = "application/json; charset=utf-8"
        
        # Determine the target URL based on the path
        if '/api/google/' in path:
            # 1. Get the secret key from Vercel's environment
            api_key = os.environ.get('GCP_API_KEY', '')
            if not api_key:
                return self.send_json({
                    "status": "CONFIGURATION_ERROR",
                    "error_message": "GCP_API_KEY is not configured on the API server.",
                    "routes": [],
                }, status_code=503)
            
            # 2. Extract and restrict the Google Maps API sub-path.
            google_subpath = path.replace('/api/google/', '')
            if google_subpath not in ALLOWED_GOOGLE_PATHS:
                return self.send_json({
                    "status": "NOT_FOUND",
                    "error_message": "Unsupported Google Maps API path.",
                    "routes": [],
                }, status_code=404)
            
            # 3. Restrict parameters to the app's Hong Kong planning requests.
            google_query = build_google_query(google_subpath, query_params, api_key)
            if google_query is None:
                return self.send_json({
                    "status": "INVALID_REQUEST",
                    "error_message": "The Google request is outside the supported Hong Kong route-planning shape.",
                    "routes": [],
                }, status_code=400)
            new_query = urllib.parse.urlencode(google_query, doseq=True)
            
            target_url = f"https://maps.googleapis.com/maps/api/{google_subpath}?{new_query}"
        
        elif path.endswith('/api/kmb/service-alerts'):
            target_url = TD_SERVICE_ALERTS_URL
            cache_control = "public, max-age=30, s-maxage=60, stale-while-revalidate=120"
            content_type = "application/xml; charset=utf-8"

        elif path.endswith('/api/kmb/route-geometry'):
            route = str(query_params.get('route', [''])[0]).strip().upper()
            if not re.fullmatch(r'[A-Z0-9]{1,8}', route):
                return self.send_json({
                    "status": "INVALID_REQUEST",
                    "error_message": "A valid KMB route number is required.",
                    "features": [],
                }, status_code=400)

            csdi_query = {
                "f": "geojson",
                "where": f"ROUTE_NAMEE='{route}'",
                "outFields": (
                    "ROUTE_ID,ROUTE_SEQ,COMPANY_CODE,ROUTE_NAMEE,"
                    "ST_STOP_ID,ED_STOP_ID,ST_STOP_NAMEE,ED_STOP_NAMEE"
                ),
                "returnGeometry": "true",
                "outSR": "4326",
                "orderByFields": "ROUTE_ID,ROUTE_SEQ",
            }
            target_url = f"{CSDI_BUS_ROUTE_QUERY_URL}?{urllib.parse.urlencode(csdi_query)}"
            cache_control = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"

        elif '/api/kmb/' in path:
            # Keep your existing KMB Open Data logic here
            cache_control = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800"
            if 'route-stop' in path:
                target_url = "https://data.etabus.gov.hk/v1/transport/kmb/route-stop"
            elif 'stop' in path:
                target_url = "https://data.etabus.gov.hk/v1/transport/kmb/stop"
            else:
                target_url = "https://data.etabus.gov.hk/v1/transport/kmb/route"
        else:
            self.send_response(404)
            self.end_headers()
            return

        try:
            # Dynamically grab your Vercel URL
            host = self.headers.get('Host', 'localhost')
            
            # Add the Referer header so Google's security lets it pass
            headers = {
                'User-Agent': 'Mozilla/5.0',
                'Referer': f"https://{host}/"
            }
            timeout_sec = 25 if '/api/kmb/' in path else 12
            retries = 2 if '/api/kmb/' in path else 1
            data = self.fetch_upstream_bytes(target_url, headers, timeout_sec=timeout_sec, retries=retries)
            
            self.send_response(200)
            self.send_header('Content-type', content_type)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Cache-Control', cache_control)
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_json({
                "status": "UPSTREAM_ERROR",
                "error_message": str(e),
                "routes": [],
            }, status_code=502)
