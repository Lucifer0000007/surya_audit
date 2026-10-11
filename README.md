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
uv run uvicorn app.main:app --reload            # live PVGIS / NASA POWER; the page is at http://127.0.0.1:8000/
bash scripts/verify.sh                          # offline end-to-end check, including the Playwright screen check
uv run python scripts/make_synthetic_site.py    # regenerate the synthetic scenario
uv run python scripts/load_demo.py http://127.0.0.1:8000   # load the SYNTHETIC scenario, prints the page link
```

The screen check (`e2e/`, Playwright 1.64.0) needs Node; `verify.sh` installs it and Chromium on first run and saves screenshots to the git-ignored `local_screens/`.

## Deploy (AWS, ap-south-1)

Stack `surya-audit` (`template.yaml`): one Lambda serves the page and the API behind an HTTP API; a DynamoDB table keeps one item per site; EventBridge Scheduler runs a second Lambda daily at 09:00 IST to fill in weather NASA POWER has published since a reading was saved. S3 is only SAM's managed artifact bucket: photos are never stored. Dates are judged in India time (`app/clock.py`), not Lambda's UTC.

Before the first deploy (an account admin does steps 2 and 3 once):

1. Install the AWS CLI v2 and the AWS SAM CLI. AWS's install page recommends, for the current user in PowerShell, `irm https://awscli.amazonaws.com/v2/install.ps1 | iex`, or the MSI `msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi` (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html, retrieved 2026-10-08). SAM CLI: https://github.com/aws/aws-sam-cli/releases/latest/download/AWS_SAM_CLI_64_PY3.msi. Docker is not needed (see the build note below).
2. Create the managed policy `surya-audit-boundary` from `infra/boundary-policy.json`. Every role the stack creates carries it as a permissions boundary, so those roles can only write logs, use the sites table, read and decrypt (through Parameter Store) the `/surya-audit/` key, and invoke the refresh function.
3. Give the deploying identity `infra/deployer-policy.json`, not admin rights. It can create and change roles only when they carry that boundary, and works on `surya-audit` resources in `ap-south-1`, with one exception: API Gateway access cannot be narrowed by name, so it covers every HTTP API in `ap-south-1`. Use an account whose `ap-south-1` has no other HTTP APIs. In both files, replace `ACCOUNT_ID`, and configure a CLI profile for `ap-south-1`. The first real deploy may show a permission this policy lacks; add exactly that one. A missing role action that creates a role or changes its policies goes in `RoleWritesOnlyWithTheBoundary`; a missing read, list or tag role action goes in `RoleReadsAndCleanup`. Never add `iam:PutRolePermissionsBoundary`, `iam:DeleteRolePermissionsBoundary` or policy-version actions.
4. Store the Gemini key as the SSM Parameter Store SecureString `/surya-audit/gemini-api-key` (default `aws/ssm` key). Create it in the Systems Manager console so the key never sits in shell history.

```bash
bash scripts/build_lambda.sh
sam deploy --template-file template.yaml --stack-name surya-audit --region ap-south-1 --resolve-s3 --capabilities CAPABILITY_IAM --profile <your-profile>
```

Build note: `sam build` is not used. On Windows its pip builder resolves dependencies for Windows, where `mcp` (via strands-agents) needs `pywin32`, which has no Linux wheel. `scripts/build_lambda.sh` uses uv to install Linux x86_64 wheels for Python 3.12 into `.lambda-build/` (AWS documents building functions outside SAM and deploying the result directly).

The `AppUrl` output is the page. To show the synthetic demo there: `uv run python scripts/load_demo.py <AppUrl>`.

`sam delete --stack-name surya-audit --region ap-south-1` removes the stack: both functions, the HTTP API, the schedule and the table with its readings. It leaves the Gemini key parameter, the Lambda log groups (`/aws/lambda/surya-audit-*`), the `surya-audit-boundary` policy and SAM's managed artifact stack and bucket; delete those in the console if you no longer need them.

Limits behind two settings: Lambda takes "6 MB each for request and response (synchronous)" (https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), so the image cap is 4 MB before base64; the HTTP API "Maximum integration timeout" is 30 seconds (https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-quotas.html), so the API function has 29 s and each PVGIS or NASA POWER call 10 s. Both retrieved 2026-10-08.

## The page

`GET /` serves one self-contained `app/index.html`: no external scripts, styles or fonts and a Content-Security-Policy that only allows calls back to the same server; its only two additions since the first version are `manifest-src data:` (the inline web-app manifest) and `font-src data:` (the inlined Hindi/Punjabi font subsets), both non-executable resources carried by the page itself, with no remote origin allowed anywhere. On it the owner sets up the plant, logs a reading (typed, or filled from a photo and then confirmed), sees each reading as a share of the plant's usual output with dips flagged, reads the ranked possible causes, approves suggestions, and drafts the complaint. The browser's `localStorage` holds only conveniences: the site id, the language, the text-size choice, the owner's edited assumptions, and readings queued while offline; `/?site=<id>` opens a specific site. That link is the only key to the plant: anyone who has it can see and change its readings, so keep it private and share evidence with Copy text, Download evidence or the WhatsApp draft instead.

Today also carries an impact strip: the output shortfall in kWh on the days the audit flags as dips over the last 30 logged days, its rupee value, the grid CO₂ it would have displaced (worded as "avoided grid CO₂", never "lost CO₂"), a cleaning payback shown only while dust is a supported cause, and cleanings avoided against a fixed schedule. Every figure comes from editable assumptions, each labelled "assumption": the tariff, the emission factor (with its CEA database version and factor type as labels), the cost of a clean and the cleans a month. Each carries a default with its source in `SOURCES.md` and in the "How we calculated this" expander. The emission factor default (0.710 kg CO₂ per unit, CEA CO₂ Baseline Database v21.0, FY 2024-25) is PROVISIONAL: it was supplied by the project owner and not verified against a CEA document, and a newer version is not ruled out. There is no water figure. Why adds a chart of units made against units expected. Two "Share on WhatsApp" links (the Today verdict with its SYNTHETIC and SAMPLE labels, and the complaint draft with its placeholders) only open WhatsApp with the text prefilled; nothing is sent by the page. A reading saved while offline waits in the browser. It is the one exception to "the page never sends a write twice": it is sent only when the browser comes online, when a plant loads, or on Try now, one at a time, removed only after the server confirms it, and a day the server already holds waits for review and the overwrite question (`docs/JUDGE_QA.md`).

Photo reading uses Gemini (`gemini-3.5-flash-lite`) through the Strands Agents SDK and needs `GEMINI_API_KEY` in the environment (deployed: an SSM SecureString, see Deploy). Without it, `/extract` answers 503 and the owner types the reading by hand. When Gemini reports high demand (Google's 503) or a rate limit (429), the page says so and the owner can retry or type the reading. The API takes PNG or JPEG up to 4 MB (base64 grows it by a third, and Lambda takes at most 6 MB per request); the page re-encodes the photo on the device as a JPEG of at most 1600 px, which also drops photo metadata such as location. Images are not stored or logged.

Languages and accessibility: the interface is in English, Hindi and Punjabi. The browser's own language picks Hindi or Punjabi on a first visit (English otherwise); only a choice the owner makes with the buttons is remembered. Dates use month names from the translations, not the browser's. The audit's own sentences (cause reasons, suggestions, verification and escalation lines, the complaint category note) and the server's error messages are written in English by the backend; the page matches each exact sentence and writes it again in Hindi or Punjabi with the same numbers and dates (32 sentences). A sentence it does not know is shown as the server wrote it, marked `lang="en"`, with a note; `NEXT_BACKEND.md` lists those and proposes codes and parameters that would replace the matching. The complaint draft stays English by design and is labelled so; the impact method and its source citations also stay English, marked the same way. A screen check scans every tab in both languages and fails on English text outside brand and source names, units and labels kept verbatim, and on a known sentence left untranslated; it reports how many sentences fell back to English. Hindi and Punjabi use Noto Sans Devanagari and Gurmukhi inlined as base64 `@font-face` data URLs (fonts, licence and method in `SOURCES.md`), which is why the CSP allows `font-src data:`. They hold only the glyphs for the words the page writes: `scripts/subset_fonts.py` shapes each word with HarfBuzz, keeps what that uses, and refuses to finish unless the pruned font shapes every word exactly like the full one. After any Hindi or Punjabi text change, run `bash scripts/build_fonts.sh`; a test fails while the page has a word the fonts were not built from. On Today a traffic-light card gives one sentence before any number, each taken from the audit's own verdict: "well below usual" on a flagged dip; "near usual, but the audit points to a possible cause" when the top cause reaches the level at which the audit suggests actions although nothing is flagged (a plant low since day one is never flagged against its own baseline; "weather or normal variation" is the audit's benign verdict and never counts); "looks fine" only when neither holds; "still learning" until the baseline is learnt; and "a very dim day" when the last reading was not judged. The page adds no threshold of its own (a middle tier would need one: `NEXT_BACKEND.md`). Read-aloud uses the browser's voices and appears only when one exists for the chosen language; voice input on the energy field uses the browser's speech recognition where it exists, and the page says that Chrome sends the audio to Google. Setup is three questions with "Use my location" first and the tilt pre-filled from the latitude as a labelled assumption. A single strip above the tabs names each honesty flag that applies (Synthetic data, Sample values in use) in its always-visible line, the synthetic one in amber; the explanations, with their wording unchanged, sit behind its Details expander. The Log tab leads with an outlined drop zone for the photo (tap to take one or pick a saved screenshot, or drop one on a computer), then Today, Yesterday and Other date chips (an overwrite still asks first), the energy field (a decimal keyboard, an example, a units label, no spinner buttons) and Save, the one solid button, which stays `aria-disabled` with a hint until there is a value and takes the owner to the field when tapped. Photos are not kept by Surya Audit; Gemini reads them under Google's own terms. Text is never under 13 px, help text is 15 px, body leading is 1.65, and "Bigger text" scales every size including help text; buttons, tabs, fields, link-buttons and expanders are at least 48 px tall (links inside running text are the exception); text and control borders meet WCAG contrast in light and dark, meaning never rests on colour alone (the light card changes shape), hover states exist only where a pointer does, and every animation stops under the system's reduced-motion setting. From 1100 px the column sits on a slightly darker backdrop (tone only, no shadow). A skip link is the first stop.

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
