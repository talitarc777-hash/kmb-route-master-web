import json
import os
import sys

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
API_DIR = os.path.join(ROOT_DIR, "api")
OUTPUT_DIR = os.path.join(ROOT_DIR, "public", "operator-data")

sys.path.insert(0, API_DIR)

import open_data  # noqa: E402


def write_dataset(name, payload):
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    path = os.path.join(OUTPUT_DIR, f"{name}.compact.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(path) / 1024
    print(f"{name}: {size_kb:.1f} KiB")


def main():
    datasets = {
        "citybus": open_data.compact_operator_dataset(
            open_data.build_citybus_dataset(include_fares=False),
        ),
        "tram": open_data.compact_operator_dataset(
            open_data.build_tram_dataset(include_fares=False),
        ),
        "mtr": open_data.compact_operator_dataset(
            open_data.build_mtr_dataset(),
            include_fares=True,
        ),
        "mtr-bus": open_data.compact_operator_dataset(
            open_data.build_mtr_bus_dataset(),
            include_fares=True,
        ),
        "lrt": open_data.compact_operator_dataset(
            open_data.build_lrt_dataset(),
        ),
    }
    for name, payload in datasets.items():
        write_dataset(name, payload)


if __name__ == "__main__":
    main()
