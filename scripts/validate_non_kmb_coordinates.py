import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(__file__))
API_DIR = os.path.join(ROOT, "api")

if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

import open_data


def pick_sample(records):
    for record in records:
        if record.get("lat") is not None and record.get("lng") is not None:
            return {
                "id": record.get("id"),
                "stop_id": record.get("stop_id"),
                "station_code": record.get("station_code"),
                "name": record.get("name"),
                "lat": record.get("lat"),
                "lng": record.get("lng"),
                "coordinate_source": record.get("coordinate_source"),
            }
    return None


def main():
    citybus = open_data.build_citybus_dataset()
    tram = open_data.build_tram_dataset()
    mtr = open_data.build_mtr_dataset()

    report = {
        "generated_at": citybus.get("generated_at"),
        "counts": {
            "total_citybus_stops": citybus["validation"]["total_stops"],
            "citybus_stops_with_wgs84": citybus["validation"]["stops_with_wgs84"],
            "total_tram_stops": tram["validation"]["total_stops"],
            "tram_stops_with_wgs84": tram["validation"]["stops_with_wgs84"],
            "total_mtr_stations": mtr["validation"]["total_stations"],
            "mtr_stations_with_wgs84": mtr["validation"]["stations_with_wgs84"],
        },
        "unresolved": {
            "citybus": citybus["validation"]["unresolved_stops"],
            "tram": tram["validation"]["unresolved_stops"],
            "mtr": mtr["validation"]["unresolved_stations"],
        },
        "invalid": {
            "citybus": citybus["validation"]["invalid_stops"],
            "tram": tram["validation"]["invalid_stops"],
            "mtr": mtr["validation"]["invalid_stations"],
        },
        "samples": {
            "citybus": pick_sample(citybus["stops"]),
            "tram": pick_sample(tram["stops"]),
            "mtr": pick_sample(mtr["stops"]),
        },
    }

    logs_dir = os.path.join(ROOT, "logs")
    os.makedirs(logs_dir, exist_ok=True)
    report_path = os.path.join(logs_dir, "non_kmb_coordinate_validation.json")
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nSaved validation report to {report_path}")


if __name__ == "__main__":
    main()
