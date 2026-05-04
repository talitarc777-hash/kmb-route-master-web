import os
from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import json
import time

class handler(BaseHTTPRequestHandler):
    def send_json(self, payload, status_code=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
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
            
            # 2. Extract the sub-path (e.g., place/autocomplete/json)
            google_subpath = path.replace('/api/google/', '')
            
            # 3. Rebuild the query parameters and add the key
            query_params['key'] = [api_key]
            new_query = urllib.parse.urlencode(query_params, doseq=True)
            
            target_url = f"https://maps.googleapis.com/maps/api/{google_subpath}?{new_query}"
        
        elif '/api/kmb/' in path:
            # Keep your existing KMB Open Data logic here
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
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_json({
                "status": "UPSTREAM_ERROR",
                "error_message": str(e),
                "routes": [],
            }, status_code=502)
