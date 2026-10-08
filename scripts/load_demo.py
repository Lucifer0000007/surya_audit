"""Load the SYNTHETIC scenario into a running Surya Audit server and print the page link.

Run: uv run python scripts/load_demo.py http://127.0.0.1:8000

The site is created with synthetic=true, so the page shows the synthetic-data banner.
Standard library only, like scripts/verify.sh's scenario step.
"""

import csv
import json
import sys
import urllib.request
from pathlib import Path

FIX = Path(__file__).resolve().parent.parent / "fixtures"


def post(base: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: load_demo.py <base url, e.g. http://127.0.0.1:8000>")
    base = sys.argv[1].rstrip("/")
    site = post(base, "/api/sites", json.loads((FIX / "synthetic_site.json").read_text(encoding="utf-8")))
    with open(FIX / "synthetic_site.csv", newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            post(base, f"/api/sites/{site['id']}/readings", {**row, "kwh": float(row["kwh"])})
    print(f"{base}/?site={site['id']}")


if __name__ == "__main__":
    main()
