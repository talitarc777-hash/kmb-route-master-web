"""
Local proxy server for KMB Route Master.
Serves static files AND proxies KMB + CSDI APIs to bypass CORS.
"""
import http.server
import urllib.request
import json
import os
from datetime import datetime

PORT = 8080
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(BASE_DIR, 'search_logs.txt')

# Clear old log file on start
with open(LOG_FILE, 'w', encoding='utf-8') as f:
    f.write(f"--- KMB Route Master API Log ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')}) ---\n")

# API proxy routes
PROXY_ROUTES = {
    '/api/kmb/': 'https://data.etabus.gov.hk/v1/transport/kmb/',
    '/api/geo/': 'https://geodata.gov.hk/gs/api/v1.0.0/',
    '/api/google/': 'https://maps.googleapis.com/maps/api/',
}

class ProxyHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        # Check if this is a proxy request
        for prefix, target in PROXY_ROUTES.items():
            if self.path.startswith(prefix):
                self._proxy(prefix, target)
                return
        # Otherwise serve static files
        super().do_GET()

    def _proxy(self, prefix, target):
        remote_path = self.path[len(prefix):]
        url = target + remote_path
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'KMB-Route-Master/1.0',
                'Accept': 'application/json',
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'public, max-age=3600')
                self.end_headers()
                self.wfile.write(data)
                
                # Log successful API calls
                with open(LOG_FILE, 'a', encoding='utf-8') as f:
                    timestamp = datetime.now().strftime('%H:%M:%S')
                    f.write(f"[{timestamp}] GET {url}\n")
                    f.flush()
                    
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def log_message(self, format, *args):
        # Quieter logging
        if '/api/' in str(args[0]):
            print(f"[PROXY] {args[0]}")

import socketserver

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Handle requests in a separate thread."""
    daemon_threads = True

if __name__ == '__main__':
    with ThreadedHTTPServer(('', PORT), ProxyHandler) as httpd:
        print(f"KMB Route Master server running on http://localhost:{PORT}/preview.html (Threaded)")
        print(f"API proxy: /api/kmb/* -> data.etabus.gov.hk")
        print(f"API proxy: /api/geo/* -> geodata.gov.hk")
        httpd.serve_forever()
