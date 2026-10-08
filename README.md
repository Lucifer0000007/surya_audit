# Surya Audit

For one rooftop-solar household owner who cannot tell whether their plant produces what they paid for. Log a daily or weekly reading; Surya Audit compares it with a weather-adjusted expectation, ranks possible causes with confidence levels, suggests one step for the owner to approve, checks whether output recovered, and, if not, drafts a complaint with an evidence pack for the owner to file themselves.

Built for Environmental Hacks (Waste and Energy track), Oct 8-11, 2026.

> **Synthetic data.** The demo scenario in `fixtures/synthetic_site.csv` is made up (`synthetic=true`). Only the weather behind it is real NASA POWER data.

## What it does and does not claim

- Causes are **possible causes with a confidence level** (`low`, `medium`, `high`), never a diagnosis.
- Actions are **suggestions**. Nothing happens until the owner approves, and approving only records the decision. Record what you did by approving it: for example, the plant's usual level is only re-learnt after an approved inspection.
- The complaint is a **draft**. It is never sent. Names, serial numbers and installer details are left as `<<OWNER TO FILL: ...>>`.
- Every data response (site, extract, readings, audit, complaint) carries three flags: `synthetic` (the site's data is synthetic), `sample` (a SAMPLE-labelled constant was used), `heuristic` (always `true`: thresholds are unvalidated).

## How expected output is worked out

Expected kWh for a day = PVGIS monthly mean daily yield `E_d` x weather index, where weather index = NASA POWER all-sky irradiance for that day / NASA POWER climatological mean for that month.

- PVGIS 5.3 `PVcalc` (EU JRC), docs retrieved 2026-10-08: https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/api-non-interactive-service_en. The owner gives azimuth as a compass bearing (180 = south); PVGIS uses 0 = south, so `aspect = azimuth - 180`.
- NASA POWER daily point API, `ALLSKY_SFC_SW_DWN` (kWh/m²/day), docs retrieved 2026-10-08: https://power.larc.nasa.gov/docs/services/api/temporal/daily/. The most recent days come back as `-999` (and POWER can be unreachable); those days fall back to the monthly average (`weather_known=false`) and are refreshed when a later reading is posted. Each timeline point carries the request URL and retrieval date of its weather (`weather_source`).
- Approximations: a horizontal-irradiance ratio is applied to tilted-panel yield, and the two sides of the ratio are different NASA POWER products (SYN1DEG 2001-2020 climatology vs near-real-time FLASHFLUX daily values). A constant offset between them cancels out of the plant's own baseline, but not out of the low-from-day-one comparison with PVGIS.
- SAMPLE: when the owner does not know the system loss, 14% is used and the response says `sample=true`.

Recorded responses in `fixtures/` (retrieved 2026-10-08, lat 26.85, lon 80.95, 3 kW, tilt 20°, south) let tests and `scripts/verify.sh` run offline with `PVGIS_MODE=fixture IRRADIANCE_MODE=fixture`.

## Heuristics (HEURISTIC_UNVALIDATED)

All thresholds live in `app/heuristics.py`. They are design parameters tuned only against the synthetic scenario; changes are logged in `LOOP_LOG.md`.

| Step | Rule |
|---|---|
| Too dim to judge | weather index below 0.4: shown, not used |
| Learn | baseline = median actual/expected over the first 14 usable readings. It needs 7; until then every cause, weather/noise included, stays `low`. It is re-learnt from the readings after an inspection that brought output up to the estimate (judged on readings with published weather); earlier readings keep their own baseline, and the audit and complaint keep the earlier figures |
| Flag a dip | output below 85% of the plant's own baseline. While no baseline is learnt (the first 7 usable readings, or while re-learning), below 85% of the PVGIS estimate instead; each point says which in `compared_with` |
| Sudden fault | 2+ dips in a row at the end, the first already 15% below the 7 readings before, which were steady (slope under 1%/day). Score saturates at a 30% drop |
| Soiling | over the last 14 readings, output slides at least 0.2%/day and is 5%+ below usual. Once detected it starts at `medium` (score 0.4) and saturates at 0.8%/day; scaled by 0.3 if a sudden step is also present |
| Low from day one | baseline below 80% of the PVGIS expectation, and the last 3 readings still below 80% (only readings with published weather count; unpublished ones cannot clear the gap). Once detected it starts at `medium` and saturates at 60%. Weather/noise is never ranked above it, because weather explains day-to-day changes, not a gap present from the start |
| Weather / noise | last 3 readings within 10% of usual. Unpublished weather alone lifts it to `medium` at most; while recent weather is unpublished, no other cause goes above `medium` |
| Confidence | score ≥ 0.7 high, ≥ 0.4 medium, else low. Ties rank the cause the owner can act on first |
| Suggest | only for the top cause at `medium` or above, and not while the same suggestion is still open (awaiting approval, being verified, verdict still provisional, or failed with output not back since) |
| Verify | judged once, on the first 3 usable readings after approval: median ≥ 95% of usual counts as recovered. An inspection is judged on the ratio to the PVGIS expectation instead: ≥ 80%. While weather for any of those readings is unpublished, the verdict is provisional |
| Escalate | suggested when a verified action did not bring output back, it has not come back since (judged on readings with published weather), and the verdict is not provisional (otherwise listed under `waiting_for_weather`). The draft complaint lists causes at `medium` or above |

## Run locally

Needs [uv](https://docs.astral.sh/uv/) and Python 3.12.

```bash
uv sync
uv run uvicorn app.main:app --reload            # live PVGIS / NASA POWER
bash scripts/verify.sh                          # offline end-to-end check
uv run python scripts/make_synthetic_site.py    # regenerate the synthetic scenario
```

Photo reading uses Gemini (`gemini-3.8-flash`) through the Strands Agents SDK and needs `GEMINI_API_KEY` in the environment. Without it, `/extract` answers 503 and the owner types the reading by hand. PNG and JPEG only, up to 5 MB. Images are not stored or logged.

## API

| Route | Does |
|---|---|
| `POST /api/sites` | create the site (`lat, lon, kw, tilt, azimuth`, optional `loss_pct`, `synthetic`) |
| `POST /api/sites/{id}/extract` | image (base64 JSON) to candidate values; nothing saved |
| `POST /api/sites/{id}/readings` | confirmed `date, kwh, kind (daily/weekly)`; returns the audit |
| `POST /api/sites/{id}/actions/{action_id}/approve` | owner approves a suggestion (optional `approved_on`) |
| `GET /api/sites/{id}/audit` | timeline, flagged dips, ranked causes, actions with verification, escalation |
| `POST /api/sites/{id}/complaint` | draft complaint and evidence pack |
| `GET /health` | liveness |

Complaint category names are SAMPLE placeholders with no verified source yet, so the complaint response is always `sample=true`.
