"""Load the SYNTHETIC demo plant into a running Surya Audit server, with the readings shifted so the last one is yesterday (India time).

Run: python scripts/load_demo_shifted.py http://127.0.0.1:8124      (or the deployed URL, once the owner has deployed)

The site is created with synthetic=true, so the page shows the synthetic-data banner. The scenario ends inside its fault window; shifting it keeps that
shape and puts it at today's date, so the live weather, the "latest reading" dates and the daily refresh all behave as they would for a real plant.
Standard library only. Prints the page link (and only that).
"""

import csv
import json
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

FIX = Path(__file__).resolve().parent.parent / "fixtures"
IST = timezone(timedelta(hours=5, minutes=30))


def post(base: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: load_demo_shifted.py <base url, e.g. http://127.0.0.1:8124>")
    base = sys.argv[1].rstrip("/")
    yesterday = datetime.now(IST).date() - timedelta(days=1)
    site = post(base, "/api/sites", json.loads((FIX / "synthetic_site.json").read_text(encoding="utf-8")))
    with open(FIX / "synthetic_site.csv", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    shift = yesterday - date.fromisoformat(rows[-1]["date"])
    for row in rows:
        day = (date.fromisoformat(row["date"]) + shift).isoformat()
        post(base, f"/api/sites/{site['id']}/readings", {"date": day, "kwh": float(row["kwh"]), "kind": row.get("kind") or "daily"})
    print(f"{base}/?site={site['id']}")


if __name__ == "__main__":
    main()
