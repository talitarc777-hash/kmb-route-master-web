from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse
import json

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        path = parsed_path.path

        # Safety: Get parameters, but default to empty string if missing
        route = query_params.get('route', [''])[0]
        bound = query_params.get('bound', ['1'])[0]
        stop_id = query_params.get('stop', [''])[0]
        service_type = query_params.get('service_type', ['1'])[0]

        # 1. Determine which KMB URL to use
        if 'route-stop' in path:
            # If no route is specified, get the full relationship list
            if not route:
                kmb_url = "https://search.kmb.hk/KMBWebSite/Function/GetRouteStop.ashx?action=getRouteStop"
            else:
                kmb_url = f"https://search.kmb.hk/KMBWebSite/Function/GetRouteStop.ashx?action=getRouteStop&route={route}&bound={bound}&service_type={service_type}"
        
        elif 'stop' in path:
            kmb_url = "https://search.kmb.hk/KMBWebSite/Function/GetStop.ashx?action=getStop"
        
        elif 'route' in path:
            kmb_url = "https://search.kmb.hk/KMBWebSite/Function/GetBaseData.ashx?action=getRoute"
            
        else:
            # Fallback
            kmb_url = "https://search.kmb.hk/KMBWebSite/Function/GetBaseData.ashx?action=getRoute"

        try:
            # 2. Fetch from KMB
            req = urllib.request.Request(kmb_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as response:
                data = response.read()
                
            # 3. Successful Response
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*') # Essential for browsers
            self.end_headers()
            self.wfile.write(data)

        except Exception as e:
            # 4. If it fails, send the actual error message so we can see it in Inspect
            self.send_response(500)
            self.send_header('Content-type', 'text/plain')
            self.end_headers()
            error_message = f"Python Error: {str(e)}"
            self.wfile.write(error_message.encode())