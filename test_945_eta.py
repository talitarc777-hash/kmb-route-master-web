import urllib.request
import json

# Fetch route stops for 945
try:
    req = urllib.request.Request("https://data.etabus.gov.hk/v1/transport/kmb/route-stop/945/outbound/1")
    with urllib.request.urlopen(req) as response:
        route_stops = json.loads(response.read())["data"]
        first_stop = route_stops[0]["stop"]
        print("First Stop ID:", first_stop)
        
        # Fetch ETA for this stop
        eta_req = urllib.request.Request(f"https://data.etabus.gov.hk/v1/transport/kmb/eta/{first_stop}/945/1")
        with urllib.request.urlopen(eta_req) as eta_res:
            etas = json.loads(eta_res.read())["data"]
            print(f"ETAs for 945 at {first_stop}:")
            print(json.dumps(etas, indent=2))
except Exception as e:
    print("Error:", e)
