import urllib.request
import urllib.parse
import json

api_key = "AIzaSyD2JDKPfhDErK6nhBaM-rLLQwzPGiBdgzc"

# simulate 25 waypoints
points = []
lat, lng = 22.3167, 114.1706
for i in range(23):
    points.append(f"{lat - i*0.001:.4f},{lng + i*0.001:.4f}")

waypoints = "%7C".join(points)

url = f"https://maps.googleapis.com/maps/api/directions/json?origin=22.3167,114.1706&destination=22.2988,114.1722&mode=driving&waypoints={waypoints}&key={api_key}"

try:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read())
        print("Status:", data.get("status"))
        if data.get("status") != "OK":
            print("Error:", data.get("error_message"))
        else:
            print("OK.")
except Exception as e:
    print("Request failed:", e)

