from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import json

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        path = parsed_path.path
        
        # 1. Map our internal paths to the Official KMB Open Data API
        # These endpoints allow downloading the WHOLE list at once.
        if 'route-stop' in path:
            kmb_url = "https://data.etabus.gov.hk/v1/transport/kmb/route-stop"
        elif 'stop' in path:
            kmb_url = "https://data.etabus.gov.hk/v1/transport/kmb/stop"
        elif 'route' in path:
            kmb_url = "https://data.etabus.gov.hk/v1/transport/kmb/route"
        else:
            kmb_url = "https://data.etabus.gov.hk/v1/transport/kmb/route"

        try:
            # 2. Fetch the data
            req = urllib.request.Request(kmb_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=15) as response:
                data = response.read()
                
            # 3. Send the data back to your React app
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*') 
            self.end_headers()
            self.wfile.write(data)

        except Exception as e:
            # 4. If it fails, return the error message so you can see it in 'Inspect'
            self.send_response(500)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            self.wfile.write(f"Python Error: {str(e)}".encode())