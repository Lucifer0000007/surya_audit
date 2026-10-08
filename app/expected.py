"""Expected output: PVGIS long-term yield, scaled by the actual weather from NASA POWER.

Expected kWh for a day = PVGIS E_d for that month x weather index, where the weather
index = NASA POWER daily all-sky irradiance / NASA POWER climatological mean for the
month. Both come from NASA POWER, but not from the same product: the climatology is
SYN1DEG 2001-2020, while recent daily values are near-real-time FLASHFLUX. A constant
offset between them cancels out of the per-site baseline, but not out of the
low-from-day-one comparison with PVGIS.

When a day's irradiance is missing (POWER returns -999 for the most recent days, or POWER
cannot be reached), the index falls back to 1.0 and the reading is marked
weather_known=false; it is refreshed when a later reading is posted.

Sources (docs checked 2026-10-08):
- PVGIS 5.3 PVcalc: https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/api-non-interactive-service_en
  aspect convention 0=south, 90=west, -90=east.
- NASA POWER daily point API: https://power.larc.nasa.gov/docs/services/api/temporal/daily/
  ALLSKY_SFC_SW_DWN in kW-hr/m^2/day, fill value -999.

PVGIS_MODE / IRRADIANCE_MODE = "fixture" reads the recorded responses in fixtures/
(retrieved 2026-10-08 for lat 26.85, lon 80.95, 3 kW, tilt 20, south) instead of calling out.
"""

import json
import os
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from app import clock

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"
PVGIS_URL = "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc"
POWER_DAILY_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
POWER_CLIMATOLOGY_URL = "https://power.larc.nasa.gov/api/temporal/climatology/point"
POWER_PARAM = "ALLSKY_SFC_SW_DWN"
POWER_FILL = -999.0
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
DAYS = {"daily": 1, "weekly": 7}

# SAMPLE: total system loss used when the owner does not know it. Not from a cited source.
SAMPLE_DEFAULT_LOSS_PCT = 14.0


class UpstreamError(Exception):
    """PVGIS or NASA POWER could not be reached or returned something unusable."""


def _fixture(name: str) -> tuple[dict, dict]:
    data = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return data, {"url": data["_source"]["url"], "retrieved": data["_source"]["retrieved"], "fixture": True}


def _get_json(url: str, params: dict) -> tuple[dict, dict]:
    full = f"{url}?{urllib.parse.urlencode(params)}"
    try:
        # Short enough that two calls in a row fit in the 29 s the deployed function has.
        with urllib.request.urlopen(full, timeout=10) as resp:
            data = json.load(resp)
    except (OSError, ValueError) as e:
        raise UpstreamError(f"{url} failed: {e.__class__.__name__}") from e
    return data, {"url": full, "retrieved": clock.today().isoformat(), "fixture": False}


def pvgis_monthly(lat: float, lon: float, kw: float, tilt: float, azimuth: float, loss_pct: float) -> dict:
    """Monthly mean daily energy E_d (kWh/day) for months 1..12, plus the source."""
    if os.environ.get("PVGIS_MODE") == "fixture":
        data, source = _fixture("pvgis_pvcalc.json")
    else:
        data, source = _get_json(PVGIS_URL, {
            "lat": lat, "lon": lon, "peakpower": kw, "loss": loss_pct,
            "angle": tilt, "aspect": azimuth - 180, "outputformat": "json",
        })
    try:
        e_d = {str(m["month"]): float(m["E_d"]) for m in data["outputs"]["monthly"]["fixed"]}
    except (KeyError, TypeError, ValueError) as e:
        raise UpstreamError("PVGIS response had no monthly E_d") from e
    if len(e_d) != 12:
        raise UpstreamError("PVGIS response did not cover 12 months")
    return {"e_d": e_d, "source": source}


def power_climatology(lat: float, lon: float) -> dict:
    """NASA POWER monthly climatological irradiance (kWh/m^2/day) for months 1..12."""
    if os.environ.get("IRRADIANCE_MODE") == "fixture":
        data, source = _fixture("power_climatology.json")
    else:
        data, source = _get_json(POWER_CLIMATOLOGY_URL, {
            "parameters": POWER_PARAM, "community": "RE", "longitude": lon, "latitude": lat, "format": "JSON",
        })
    try:
        values = data["properties"]["parameter"][POWER_PARAM]
        ghi = {str(i + 1): float(values[m]) for i, m in enumerate(MONTHS)}
    except (KeyError, TypeError, ValueError) as e:
        raise UpstreamError("NASA POWER climatology had no monthly irradiance") from e
    return {"ghi": ghi, "source": source}


def power_daily(lat: float, lon: float, start: date, end: date) -> tuple[dict[str, float | None], dict]:
    """Daily irradiance by ISO date (None where POWER has no value yet), plus the source."""
    if os.environ.get("IRRADIANCE_MODE") == "fixture":
        data, source = _fixture("power_daily.json")
    else:
        data, source = _get_json(POWER_DAILY_URL, {
            "parameters": POWER_PARAM, "community": "RE", "longitude": lon, "latitude": lat,
            "start": start.strftime("%Y%m%d"), "end": end.strftime("%Y%m%d"), "format": "JSON",
        })
    try:
        values = data["properties"]["parameter"][POWER_PARAM]
        out = {}
        day = start
        while day <= end:
            v = values.get(day.strftime("%Y%m%d"))
            out[day.isoformat()] = None if v is None or float(v) <= POWER_FILL else float(v)
            day += timedelta(days=1)
    except (KeyError, TypeError, ValueError, AttributeError) as e:
        raise UpstreamError("NASA POWER daily had no irradiance") from e
    return out, source


def daily_irradiance(site: dict, periods: list[tuple[date, int]]) -> tuple[dict[str, float | None], dict | None]:
    """One POWER call covering every (end date, days) period. If POWER fails, every day is unknown."""
    start = min(end - timedelta(days=days - 1) for end, days in periods)
    end = max(end for end, _ in periods)
    try:
        return power_daily(site["lat"], site["lon"], start, end)
    except UpstreamError:
        return {}, None


def refresh_weather(site: dict, periods: list[tuple[date, int]] = ()) -> tuple[dict, dict | None]:
    """Refresh stored readings whose weather was not available yet, in one POWER call that also
    covers `periods` (e.g. a reading about to be added). Returns the irradiance and source for reuse;
    if POWER failed the source is None and the stored readings keep their old values."""
    stale = [r for r in site["readings"] if not r["weather_known"]]
    wanted = list(periods) + [(date.fromisoformat(r["date"]), DAYS[r["kind"]]) for r in stale]
    if not wanted:
        return {}, None
    ghi, source = daily_irradiance(site, wanted)
    if source is not None:
        for r in stale:
            r.update(expected_for_period(site, date.fromisoformat(r["date"]), DAYS[r["kind"]], ghi, source))
    return ghi, source


def expected_for_period(site: dict, end: date, days: int, ghi_by_day: dict, source: dict | None) -> dict:
    """Expected kWh for the `days` days ending on `end`, with the mean weather index and its source."""
    total, indexes, known = 0.0, [], True
    for i in range(days):
        day = end - timedelta(days=i)
        month = str(day.month)
        ghi, clim = ghi_by_day.get(day.isoformat()), site["climatology_ghi"][month]
        if ghi is None or clim <= 0:
            index, known = 1.0, False
        else:
            index = ghi / clim
        indexes.append(index)
        total += site["pvgis_e_d"][month] * index
    return {
        "expected_kwh": round(total, 3),
        "weather_index": round(sum(indexes) / len(indexes), 3),
        "weather_known": known,
        "weather_source": source,
    }
