import os
from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        path = parsed_path.path
        
        # Determine the target URL based on the path
        if '/api/google/' in path:
            # 1. Get the secret key from Vercel's environment
            api_key = os.environ.get('GCP_API_KEY', '')
            
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
            req = urllib.request.Request(target_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as response:
                data = response.read()
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())