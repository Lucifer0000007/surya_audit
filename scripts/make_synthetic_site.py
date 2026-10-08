"""Generate the SYNTHETIC scenario: fixtures/synthetic_site.json and fixtures/synthetic_site.csv.

Run: uv run python scripts/make_synthetic_site.py

The readings are made up (synthetic=true); only the weather behind them is real NASA POWER
data for the site (fixtures/power_daily.json, retrieved 2026-10-08). 60 daily readings,
2026-08-05 to 2026-10-03:
  days  0-20  healthy
  days 21-41  dust builds up: output slides 0.6% per day
  days 42-54  panels cleaned, healthy again
  days 55-59  sudden fault: output drops to 55% (the scenario ends inside this window)
"""

import csv
import json
import random
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "fixtures"
START = date(2026, 8, 5)
DAYS = 60
PLANT_FACTOR = 0.92  # this synthetic plant's usual output vs the PVGIS expectation
NOISE = 0.03
SITE = {"lat": 26.85, "lon": 80.95, "kw": 3, "tilt": 20, "azimuth": 180, "synthetic": True}


def condition(i: int) -> float:
    if 21 <= i <= 41:
        return 1.0 - 0.006 * (i - 20)
    if i >= 55:
        return 0.55
    return 1.0


def main() -> None:
    pvgis = json.loads((FIX / "pvgis_pvcalc.json").read_text(encoding="utf-8"))
    e_d = {m["month"]: m["E_d"] for m in pvgis["outputs"]["monthly"]["fixed"]}
    clim_raw = json.loads((FIX / "power_climatology.json").read_text(encoding="utf-8"))
    clim = clim_raw["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"]
    months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    daily = json.loads((FIX / "power_daily.json").read_text(encoding="utf-8"))
    ghi = daily["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"]

    rng = random.Random(42)
    rows = []
    for i in range(DAYS):
        d = START + timedelta(days=i)
        index = ghi[d.strftime("%Y%m%d")] / clim[months[d.month - 1]]
        kwh = e_d[d.month] * index * PLANT_FACTOR * condition(i) * (1 + rng.uniform(-NOISE, NOISE))
        rows.append({"date": d.isoformat(), "kwh": f"{kwh:.1f}", "kind": "daily"})

    (FIX / "synthetic_site.json").write_text(json.dumps(SITE, indent=1) + "\n", encoding="utf-8")
    with open(FIX / "synthetic_site.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["date", "kwh", "kind"], lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
