# Review of 2026-10-11: security, bugs and performance

Three read-only reviews (security, bugs and oddities, performance) of the branch `loop/work`. Every finding below was checked against the code before it was acted on;
a few line numbers in the reviewers' reports were wrong and a claim that could not be reproduced was dropped. Nothing here needed a new route or a new response shape.

## Fixed
| Area | Finding | Fix | Test |
|---|---|---|---|
| Security | The API had no rate ceiling, and `/extract` spends the Gemini key's quota | API Gateway throttle: 10 requests a second, bursts of 20 (`template.yaml`, the HttpApi event's `RouteSettings`) | validated with `sam validate`; the effect is only visible on AWS |
| Security | A plant id of any shape went to the store (a 3,000-character id raised a 500) | `SITE_ID` (32 hex characters, what `create_site` makes): anything else is a 404 and never reaches the store | `tests/surface/test_hardening.py` |
| Security | A reading dated far in the past made NASA POWER be asked for years of days (an overflow for the year 1), and the readings were not capped | a reading may be at most 400 days old and a plant keeps at most 900 readings (about 344 bytes each, so well under DynamoDB's 400 KB item limit), both a clean 422 | same |
| Security | One failing plant stopped the whole daily weather refresh for the plants after it | per-plant `try/except` (class name logged, never data) and a stop with 15 s to spare | same |
| Security | A cut-off upstream answer (IncompleteRead) was a 500, and the upstream read was unbounded | caught as `UpstreamError`; the read is capped at 2 MB | same |
| Security | The key redaction knew only the `AIza` shape; new Google keys start `AQ.` | both shapes are cut out of logged error text | same |
| Security | API answers carry the plant's location and could be cached; no HSTS; no Permissions-Policy | `Cache-Control: no-store` on `/api/*`, `nosniff` and HSTS on every answer, `Permissions-Policy: geolocation=(self), microphone=(self), camera=(self)` on the page | same |
| Performance | The page (about 290 KB) and the audit JSON (about 30 KB) were sent uncompressed | gzip (Starlette's middleware, no new dependency): about 93 KB and 3 KB. Checked through the Lambda (Mangum) path: base64 body, decodes to the page | same |
| Performance | `toLocaleString` with options built a new formatter on every call (about 1,000 calls for a year of readings) | four `Intl` formatters built once | existing e2e |
| Performance | The chart tooltip redid layout on every pointermove over the same bar | returns early for the same bar | existing e2e |
| Bug | A queued reading was marked refused when the server answered 409 (the plant being written, for example by the 09:00 refresh) | 409 now waits like a 5xx | `e2e/hardening.spec.js` |
| Bug | Forget while the first read was on its way brought the plant back | a navigation counter: a load for a plant that was just left is dropped | same |
| Bug | A failed Approve left the button without its label and tick | the busy state keeps the button's children and restores them whole | same |
| Bug | Creating a plant timed out on the page (20 s) before the server could (29 s), leaving an orphan plant | that call waits 28 s | read, not tested |
| Bug | A corrupt queue key (not a list) crashed the render | read as an empty queue | same |
| Bug | A near-zero baseline gave ratios in the hundreds and a thousand gridlines | the chart scale is capped at 300% | same |
| Bug | The `:has()` fallback classes were in the same CSS rule as `:has()`, so an older browser dropped both | separate rules | existing e2e |
| Bug (found by a flaky test) | Late speech voices redrew the Fix cards and dropped an edited date | redraw only when a voice for the language appears or goes | `e2e/design.spec.js` |

## Not fixed, with the reason
- **CSP `script-src 'unsafe-inline'`** (the page has one inline script). A hash would be stricter, but the CSP string is asserted in `tests/test_loop.py` (a protected test) and the page's script changes on every edit. Proposed in `NEXT_BACKEND.md`.
- **IAM least privilege** (`DynamoDBCrudPolicy` includes Scan and Delete the API function does not use). Narrowing it needs the boundary policy changed too and was not worth a rollback risk on the deploy. Proposed.
- **Retention and deletion.** A plant's location and readings are kept forever behind its private link; there is no delete route or TTL. A TTL deletes owners' data, which is a product decision. Proposed (with the delete-my-data route that was already there).
- **A weekly reading counts as evidence after an approval** if its date is after the approval, although it covers days before it (`_verify` in `app/audit.py`). It changes verdicts, so it is left for the owner. Proposed.
- **Per-IP rate limits** need AWS WAF (a new resource). The throttle above is a ceiling for the whole API.
- **A cap on Gemini spend** is a setting in Google's console (budget alert), not in this repository.
- **Dates use the device's clock** (a device far from IST around midnight can send tomorrow's date and get a 422). Rare; proposed.
- **`weather_source` repeated in every reading** (shape change), **`--no-hashes` in the Lambda build**, **strands' large transitive set** in the package, **parallel PVGIS and POWER calls**, **a per-container NASA cache**, **lazy-building hidden tabs**, **a smaller photo upload** (affects reading accuracy) and **more Lambda memory for a faster cold start**: proposals in `NEXT_BACKEND.md`, none measured.
- **Capability-link model.** The plant's 122-bit id is the only credential (read, write, complaint draft). A link someone sends you opens their plant if you have none stored. That is the product's design ("no accounts"); the privacy band says so.
