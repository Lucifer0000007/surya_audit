# Questions a judge may ask, answered against the code

Written read-only on 2026-10-10 for the Surya Audit hackathon entry. Every answer is tagged and carries file:line evidence
from this repository. The audit engine, the API and the infrastructure are frozen at the deployed commit `f54a173`, so
their line numbers are stable; the page is cited by function name.

- **Built**: implemented, and exercised by a test.
- **Partial**: part of it is implemented; the limit is stated.
- **Roadmap**: not built. Nothing in the product, the page or these docs claims it.

Read everything below with the product's own caveat: results are **possible causes with a confidence level, not a
diagnosis**; every threshold is an **unvalidated design parameter** (`app/heuristics.py:3,12`), tuned only on the synthetic
scenario; nothing has been validated against real plants or by real users.

## The nine topics

### Seasonality: **Built** (as a monthly expectation), with a stated limit

The expected output of a day is PVGIS's long-term mean daily yield **for that month**, scaled by the weather of that day
(`app/expected.py:3-4`, `:66-81` for the PVGIS monthly `E_d`, `:147-165` for the day's expectation). A plant's "usual" is
then a *ratio* of actual to expected, so a winter dip in the PVGIS curve is already in the expectation, not in the ratio
(`app/audit.py:96-114`). The limit, in the engine's own words (`app/expected.py:3-8`): "Expected kWh for a day = PVGIS E_d
for that month x weather index, where the weather index = NASA POWER daily all-sky irradiance / NASA POWER climatological
mean for the month. Both come from NASA POWER, but not from the same product: the climatology is SYN1DEG 2001-2020, while
recent daily values are near-real-time FLASHFLUX. A constant offset between them cancels out of the per-site baseline, but
not out of the low-from-day-one comparison with PVGIS." The baseline is learnt from the first 14 usable readings in one
season (`app/heuristics.py:18`), so a PVGIS monthly shape that is wrong for the site shifts it.

### Rain: **Partial**

Rain reaches the audit through the sky: NASA POWER's daily all-sky irradiance (`ALLSKY_SFC_SW_DWN`, `app/expected.py:37`,
`:100-119`) lowers the expected output on a cloudy or rainy day, so such a day is not flagged as a loss. Days whose
irradiance is under 0.4 of the climatological mean are shown but **not judged** (`app/heuristics.py:15`,
`app/audit.py:67-78`). **Not built:** rain washing the panels. A dust slide that rain interrupts would look like a
recovery, and the audit has no rain input to tell the two apart.

### Temperature: **Roadmap**

The audit reads no temperature. The only weather parameter requested is irradiance (`app/expected.py:37`), and nothing
in the audit corrects for a hot day, so a hot day can read as low output.

### Shading: **Roadmap** (not detected)

The audit does not detect shading. The word appears once, in the sentence for a plant that was low from its first
readings, as one possible reason alongside under-sized or mis-installed equipment and dust already present
(`app/audit.py:192-195`). That sentence is a list of possibilities with the statement "the estimate itself is approximate",
not a finding.

### Curtailment: **Roadmap**

Grid outages and export limits are not modelled; the audit has no input about grid availability. A curtailed day is just
a low reading and is treated like any other (it may rank "sudden fault" if it starts a run of dips, or "weather or normal
variation" if the deficit is small, `app/audit.py:133-161`, `:205-217`).

### Panel degradation: **Partial**

There is no age or degradation-rate model. What exists: a steady decline of at least 0.2% a day over the last 14 readings,
with output at least 5% below usual, ranks "soiling" (`app/audit.py:163-177`, `app/heuristics.py:36-38`), which is a
possible cause, not a degradation finding. The plant's usual is **re-learnt only after an approved inspection that brought
output back** (`app/audit.py:84-93`), never because years have passed.

### Cold start (7 readings): **Built**

The usual level needs at least 7 usable readings and uses up to the first 14 (`app/heuristics.py:18-19`;
`app/audit.py:106`). Before that, every cause stays at low confidence (`app/audit.py:219-228`,
`app/heuristics.py:53`), flags and the impact figures compare with the weather-adjusted PVGIS estimate
(`app/audit.py:110-112`), and the page says "Still learning" with the count (`renderHeadline` in `app/index.html`;
`e2e/audit.spec.js`, "traffic light" tests). "Usable" excludes the dim days that are not judged.

### False positives: **Partial**

What limits them: a dip is a reading more than 15% below the plant's *own* usual, after the weather adjustment
(`app/heuristics.py:22`); a "sudden fault" needs a run of at least 2 dips after 7 steady readings
(`:26,:30,:33`); dim days are not judged (`:15`); a deficit under 10% ranks "weather or normal variation" (`:46`); readings
whose weather is not yet published cap every other cause at "medium" (`:54`); a suggestion appears only at "medium" or
above and is never carried out for the owner (`:57`, `app/audit.py:284-299`). What is **not known**: the false-positive rate
on real plants. The thresholds were tuned only on the synthetic scenarios and are marked `HEURISTIC_UNVALIDATED`.

### Privacy and what is stored: **Built**, with one gap

The sentence-by-sentence evidence is in `docs/PRIVACY_EVIDENCE.md`. In short: one DynamoDB item per plant (location, size,
tilt, direction, loss, readings, suggestions; `app/store.py:42-64`); photos are never stored (`app/main.py:165-190`,
`"saved": False`); the plant id is a random 122-bit token and the only key (`app/main.py:149`); the Gemini key is in SSM
Parameter Store (`template.yaml:58-70`); Lambda logs carry no readings, coordinates or images (`app/main.py:45-63`,
`tests/test_loop.py:479`). **Gap:** there is no way to delete a plant's data from the server (**Roadmap**,
`NEXT_BACKEND.md`); the page can only forget it in the browser.

## Where the pitch differs from the code

The 12 claims of the pitch were checked against the code on 2026-10-10 and accepted by the user with the wording below.
Use the right-hand column.

| # | Pitch | Verdict | Say instead (evidence) |
|---|---|---|---|
| 1 | Flags readings below 85% of the plant's own learned normal | Precision | "Below 85% of the plant's own weather-adjusted normal." **Before 7 usable readings the flag compares with the PVGIS estimate** (`app/audit.py:110-113`). Very dim days are shown but not judged (`app/heuristics.py:15`). |
| 2 | Ranks four possible causes, low/medium/high, never a diagnosis | Holds | (`app/audit.py:14`, `app/heuristics.py:51-52`, `app/audit.py:355`) |
| 3 | The owner approves every suggestion; nothing is automatic | Overreach | "**Nothing is acted on without the owner's approval.**" Suggestions are proposed automatically, **also by the daily job** while the owner is away (`app/refresh.py:26`, `app/main.py:209`); approval is the owner's (`app/main.py:214-228`). |
| 4 | After approval, the next 3 readings check whether output came back | Precision | "**The first 3 usable readings dated after the approval date**; the verdict is provisional while weather for any of them is unpublished." (`app/heuristics.py:58-59`, `app/audit.py:244-273`) |
| 5 | If output does not recover, a complaint draft is produced and never sent | Overreach | "**The complaint draft is made only when the owner asks**, and the app suggests it after a failed, non-provisional verdict; it is never sent (`app/main.py:236-239`, `app/audit.py:314,342`, `app/complaint.py:19-45,109`). Category names are SAMPLE and unverified (`app/complaint.py:10-16`); they do not match any real portal." |
| 6 | Expected output = PVGIS adjusted by each day's NASA POWER sunshine; unpublished days use the monthly average and are refreshed | Precision | "Sunshine" is all-sky solar irradiance. A missing day uses the PVGIS monthly yield (index 1.0) and is refreshed later (`app/expected.py:10-12`, `app/refresh.py:19-26`). **The known limit, verbatim:** "Both come from NASA POWER, but not from the same product: the climatology is SYN1DEG 2001-2020, while recent daily values are near-real-time FLASHFLUX. A constant offset between them cancels out of the per-site baseline, but not out of the low-from-day-one comparison with PVGIS." (`app/expected.py:5-8`) |
| 7 | The plant's normal is learned from its first readings; "Still learning" before 7; re-learned after an inspection that fixed it | Precision | The 7 and the 14 count **usable** readings. Re-learning follows only an **inspection** that brought output back, not a cleaning or an inverter check (`app/heuristics.py:18-19`, `app/audit.py:84-113`). |
| 8 | Runs in AWS Mumbai: Lambda, HTTP API, DynamoDB, EventBridge daily refresh at 09:00 IST, Gemini key in SSM | Precision | Mumbai comes from the **deploy command**, not the code (`README.md:72`: `sam deploy ... --region ap-south-1`; `template.yaml` is region-neutral), and the page states a region only when served from an API Gateway host. The schedule is exactly `cron(0 9 * * ? *)` with `ScheduleExpressionTimezone: Asia/Kolkata` (`template.yaml:93-94`): every day at 09:00 India time. Photos go to Google and weather requests to NASA and the EU JRC, outside AWS. |
| 9 | Photos are shrunk and location-stripped on the phone, read by Gemini, not kept by us | Holds | (`photoToJpegBase64`; `e2e/surface.spec.js` checks the bytes that leave; `app/extract.py:4`; `app/main.py:165-190`) |
| 10 | English, Hindi and Punjabi | Precision | The **interface and the audit's own sentences** are in three languages; the **complaint draft, the method and source notes, Gemini's read-out note and a few server errors stay English**, marked as such (`NEXT_BACKEND.md`). |
| 11 | When weather or normal variation ranks first, the app does not suggest cleaning | Precision | **No new cleaning is proposed** (`app/audit.py:16-30` has no action for "weather or normal variation"; `:286-289`). A cleaning suggested earlier stays on Fix, labelled earlier. |
| 12 | Honesty flags: synthetic data, sample values, retrieval dates | Holds | (`app/audit.py:320-322`; the strip above the tabs in the page) |

### Not claimed, and confirmed not implied

Rain-wash modelling, temperature, panel age, curtailment, accounts, data deletion, inverter integration, user validation
and real-world accuracy are claimed nowhere in the page, the README, `SOURCES.md` or these docs. Three near misses a
reader could take for a claim, so they are named here:

- The low-start sentence names shading as one possible reason (`app/audit.py:192-195`); nothing detects shading.
- "Inverter" appears in a suggestion ("look at the inverter display or app for an error code", `app/audit.py:24-25`) and as
  the source of a photo or screenshot the owner takes; no inverter is connected to anything.
- `README.md:79` describes `sam delete` for the operator. It removes the stack; it is not a way for an owner to delete data.
