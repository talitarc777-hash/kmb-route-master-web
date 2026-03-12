from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.parse

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query_params = urllib.parse.parse_qs(parsed_path.query)
        
        # Determine which KMB action to take based on the URL path
        # Vercel sends the path as /api/kmb/route-stop, etc.
        path = parsed_path.path
        
        # Default KMB parameters
        route = query_params.get('route', [''])[0]
        bound = query_params.get('bound', ['1'])[0]
        stop_id = query_params.get('stop', [''])[0]

        # Route to the correct KMB Function
        if 'route-stop' in path:
            action = "getRouteStop"
            kmb_url = f"https://search.kmb.hk/KMBWebSite/Function/GetRouteStop.ashx?action={action}&route={route}&bound={bound}"
        elif 'stop' in path:
            action = "getStop" # Example action name
            kmb_url = f"https://search.kmb.hk/KMBWebSite/Function/GetStop.ashx?action={action}&stop={stop_id}"
        else:
            # Fallback for general route info
            kmb_url = f"https://search.kmb.hk/KMBWebSite/Function/GetBaseData.ashx?action=getRoute&route={route}"

        try:
            req = urllib.request.Request(kmb_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req) as response:
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