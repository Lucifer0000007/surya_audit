# Backend changes the page wants but did not make

Routes and response shapes are frozen during the UI phases (5-8), so these wait for a later phase.

- **`WATCH_BELOW` for the Today traffic light** (Phase 7). The light card's states all come from the audit's own
  verdict: "well below usual" (the dip flag), "near usual, but the audit points to a possible cause" (the top
  cause at the audit's suggestion level with nothing flagged), "looks fine" (neither), plus "still learning"
  before the baseline exists and "a very dim day" for a last reading that was not judged. A middle "a little low, worth watching" tier was built and then
  removed because it needed a threshold of its own, and every threshold lives in `app/heuristics.py` as
  `HEURISTIC_UNVALIDATED`. To bring the amber tier back: add `WATCH_BELOW` to `heuristics.py`, expose it in the
  audit response as `watch_below` next to `flag_below`, document it in the README table, and the page can show the
  tier from that field alone, with a shape of its own (the half-covered sun now marks "near usual, but the audit
  points to a possible cause").

- **Codes and parameters next to the audit's English sentences** (Phase 9). Hindi and Punjabi pages translate the
  backend's sentences by matching the exact English text (`SERVER` in `app/index.html`, 32 patterns). That breaks
  silently when a sentence is reworded, and every new sentence needs a new pattern. An additive field would remove the
  matching: next to each `why` line, suggestion and verification reason, return `{code, params}` and keep the English
  `text` for English pages and the complaint draft. Proposed codes and parameters (all numbers are what the sentence
  already contains):

  | code | params |
  |---|---|
  | `not_enough_readings` | |
  | `no_dip_run` | `min_dips` |
  | `needs_readings_before_dip` | `needed` |
  | `sudden_step` | `since, run, drop_pct, before, entry_pct` |
  | `dip_not_steady` | `since` |
  | `dip_too_small` | `since, entry_pct` |
  | `gradual_slide` | `per_day_pct, readings, below_pct` |
  | `step_also_present` | |
  | `no_decline` | `trend_pct_per_day, below_pct` |
  | `needs_readings_to_learn` | `needed` |
  | `low_start_present` / `low_start_gone` / `low_start_fine` | `first` (`start` or `after_inspection` with `date`), `pct`, `recent_pct` or `recent_unknown` |
  | `within_noise` | `within_pct, deviation_pct` |
  | `weather_unpublished` | `pct` |
  | `below_with_known_weather` | `below_pct` |
  | `not_learnt_yet` | `have, needed` |
  | `weather_not_a_start_gap` | |
  | `suggest_clean` / `suggest_inverter` / `suggest_inspection` | |
  | `verify_pending` | `have, needed, after` |
  | `verify_result` | `count, after, still, pct, reference` (`pvgis` or `usual`), `back_later`, `unpublished` |
  | `escalation_line` | `action, approved_on, verification` (nested) |
  | `category_note` | |
  | error codes | `photo_unavailable`, `photo_busy`, `photo_unreadable`, `plant_changed`, `date_in_future`, `reading_too_large` (`kwh, kw, days`), `source_unavailable` |

  Not translated today (shown in English, `lang="en"`): Gemini's own note about what it read (`what_was_read`), the
  complaint draft (English by design), the errors `image_base64 is not valid base64`, `image must be between 1 byte
  and N bytes`, `site not found`, `action not found`, `action is already ...` and `approved_on must be between ... and
  today`, and any sentence the backend gains. The screen check counts these.

- **Delete my data** (Step 4 of the surface upgrade). The page can only forget a plant in this browser ("Forget this
  plant on this device"); the plant's location, readings and suggestions stay in DynamoDB until someone deletes the
  item, and the frozen routes have no delete. Proposed: `DELETE /api/sites/{id}` (the id is the only key, as for every
  other route). It removes the one DynamoDB item `{id}` (`app/store.py` keeps one item per site), answers 204, and the
  daily refresh (`app/refresh.py`) skips a plant that is gone. Two things it needs: neither `MemoryStore` nor `DynamoStore`
  has a delete method yet, and a delete must be safe against a concurrent save: `DynamoStore.put` is conditional on
  `attribute_not_exists(#id) OR #v = :v` (`app/store.py:65`), which is true for a deleted item, so a refresh that read the plant
  just before the delete would put it back. Either write only while the item exists (`attribute_exists(id) AND version = :v`) or
  leave a tombstone, and add a test where the refresh races a delete. No IAM change is needed: the table policy already
  grants delete (`DynamoDBCrudPolicy` "grants create, read, update, and delete permissions to an Amazon DynamoDB table
  and its indexes", https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-policy-template-list.html,
  retrieved 2026-10-10) and the permissions boundary allows `dynamodb:DeleteItem` on `surya-audit-*` tables
  (`infra/boundary-policy.json`, statement `SitesTableItems`). Nothing else holds owner data (`docs/PRIVACY_EVIDENCE.md`):
  photos are never stored, `template.yaml` defines no access log, and Lambda logs carry no readings, coordinates or
  images. The page would then add "Delete this plant's data from the server" beside "Forget this plant on this device",
  with a confirmation that says the plant's link stops working. Not built: it needs a route and a test, and the routes
  are frozen.

- **Serve the page compressed** (v3 Step 1). `app/index.html` is 249,563 bytes raw; gzip -9 gives 82,059 bytes and brotli 71,013 (measured
  2026-10-10 with Node's zlib). The app served locally answers a request that accepts gzip and br with no `Content-Encoding` header, so
  the page travels at its raw size. Proposed: compress the page response (in the handler, or in a layer in front of it) and send
  `Content-Encoding` with `Vary: Accept-Encoding`. It would cut the bytes sent by about two thirds (the time saved was not measured).
  Measured with Chromium on the offline app: 500 kbit/s each way, 400 ms latency, 4x CPU slowdown, 375 px phone emulation, no console
  error: Today is usable (the headline number shown) after 5.9 s, Log (the energy field shown) after 6.4 s; DOMContentLoaded at 4.4 s.
  Not measured: the deployed stack (the live URL is not used for the app flow).

## Performance proposals (master prompt v4). Nothing here is implemented; the numbers are in docs/PERF_BASELINE.md

- **Compression for the page and the audit JSON.** API Gateway HTTP APIs do not compress responses by themselves. The options are to
  compress in the Lambda handler (gzip or brotli, with `Content-Encoding` and `Vary: Accept-Encoding`) or to put CloudFront in front,
  which compresses for you. At commit `35ef6f3` the page is 263,472 bytes raw and 86,466 bytes gzip -9 (measured with `gzip -9`); the
  uncompressed transfer is most of the load time at 2 Mbps in `docs/PERF_BASELINE.md`.
- **ETag with `Cache-Control: no-cache` on the page.** Today the page is sent in full on every visit. With an ETag the browser asks
  "has it changed?" and gets a 304 with no body. Needs a change to `app/main.py` (protected).
- **CloudFront in front of the API** (the owner's decision, not made here): compression, caching of the page at the edge, and a lower
  latency for users far from `ap-south-1`.
- **A smaller audit payload, only if measurements show it matters.** The audit response carries the whole timeline each time; it was not
  measured on its own, and the page keeps the last one on the device so the first draw does not wait for it.
- **Read the Lambda Init Duration from the CloudWatch `REPORT` lines** to separate a cold start from the request time. Not read here:
  the deployed stack is not used for the app flow.
- **Codes and parameters for server sentences** (see the Phase 9 entry above): the page now draws a saved audit that was written in
  an earlier language; the sentences it translates are matched on exact English patterns, so a new server wording stays English until
  it is added to the table.
