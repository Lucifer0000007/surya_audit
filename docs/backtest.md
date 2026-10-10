# Synthetic backtest: generator specification (v1, FROZEN on first use)

Written from the physical definitions of the causes, before the engine's
thresholds were looked at. This file specifies the plant generator only. It
does not describe how the engine detects anything, and the generator must not
be shaped by how it does.

## 1. Purpose and the honesty label

Purpose: measure how often the audit engine ranks the true cause first (and in
its top three) on plants whose cause is known by construction, and how often it
raises a false alarm on healthy plants.

Every output of the backtest (generated files, tables, plots, README or blog
text, video captions) must carry this label verbatim:

> Synthetic data. Validates the logic, not real-world accuracy. Thresholds unvalidated.

All generated plants are `synthetic=true`. Every constant in this file is a
SAMPLE assumption (no external retrieval, no source, no retrieval date) and is
labelled as such wherever it is quoted.

## 2. The plant model

### 2.1 Physical relation

For plant i on day t, daily AC energy delivered to the meter is

    E[t] = kW * O * H(doy_t) * PR_i * k[t] * (1 - S[t]) * (1 - F[t]) * (1 + e[t])

- `kW`: DC nameplate, kWp.
- `O`: orientation factor for tilt and azimuth (2.4).
- `H(doy)`: clear-sky plane-of-array peak-sun-hours-equivalent for the
  reference orientation, kWh/m2/day, from the month table (2.2), linearly
  interpolated between mid-month points (day 15 of each month) so there is no
  step at month boundaries.
- `PR_i`: the plant's performance ratio, covering temperature, wiring,
  inverter, mismatch and static losses (2.3).
- `k[t]`: daily clear-sky index, actual irradiance over clear-sky irradiance,
  in [0.08, 1.0] (2.2). This is the weather.
- `S[t]`: soiling loss fraction (zero except in scenario b).
- `F[t]`: fault loss fraction (zero except in scenario c).
- `e[t]`: measurement and reading noise (2.5).

The fixed location for every plant is Lucknow-like: 26.85 N, 80.95 E. One
climate only.

### 2.2 Seasonality and weather (all values SAMPLE)

Assumption, SAMPLE: the numbers below are order-of-magnitude values for a
North Indian plains site (hot dry spring, monsoon July to September, foggy
December and January). They were written from general knowledge of the
climate, not copied from PVGIS or NASA POWER, and are not retrieved data.
`H` is clear-sky POA hours for tilt 26 deg (about latitude), azimuth 180 deg
(south). `kmean` is the long-run mean clear-sky index of the month (cloud,
fog, haze). `Y_typ = H * 0.78 * kmean` is the resulting mean kWh per kW per day
of a healthy plant with PR 0.78.

| Month | H (h/day) | kmean | muD = 1 - kmean | Y_typ (kWh/kW/day) |
|-------|-----------|-------|-----------------|--------------------|
| Jan   | 5.5       | 0.72  | 0.28            | 3.09               |
| Feb   | 6.3       | 0.80  | 0.20            | 3.93               |
| Mar   | 7.0       | 0.85  | 0.15            | 4.64               |
| Apr   | 7.4       | 0.85  | 0.15            | 4.91               |
| May   | 7.5       | 0.82  | 0.18            | 4.80               |
| Jun   | 7.2       | 0.68  | 0.32            | 3.82               |
| Jul   | 6.6       | 0.50  | 0.50            | 2.57               |
| Aug   | 6.5       | 0.52  | 0.48            | 2.64               |
| Sep   | 6.6       | 0.65  | 0.35            | 3.35               |
| Oct   | 6.4       | 0.82  | 0.18            | 4.09               |
| Nov   | 5.7       | 0.82  | 0.18            | 3.65               |
| Dec   | 5.2       | 0.70  | 0.30            | 2.84               |

Sanity check, not a validation: the mean of Y_typ is 3.69 kWh/kW/day, about
1,350 kWh/kWp/year, inside the usual 1,300 to 1,500 range quoted for the
region. Do not quote this as a PVGIS or NASA figure.

Daily weather. Per plant, draw a latent AR(1) series
`z[t] = 0.5 * z[t-1] + sqrt(1 - 0.5^2) * g[t]`, `g[t]` ~ N(0,1) i.i.d.,
`z[0]` ~ N(0,1) (day-to-day persistence of weather). Then the cloud deficit
and index are

    sigmaD(m) = min(0.28, 0.08 + 0.4 * muD(m))
    D[t] = clip(muD(m_t) + sigmaD(m_t) * z[t], 0.0, 0.92)
    k[t] = 1 - D[t]

where `m_t` is the month of day t (muD linearly interpolated the same way as
H). The clip at zero gives the right skew a real cloud deficit has (many near
clear days, occasional very dull ones); the cap makes k at least 0.08.

Weather record error. The engine sees the weather through a gridded
reanalysis or satellite product, not a pyranometer on the roof. The generator
therefore also emits the observed index

    k_obs[t] = clip(k[t] * (1 + eta[t]), 0.05, 1.0),   eta[t] ~ N(0, 0.06^2) i.i.d.

The true `k` drives the energy; `k_obs` is the only weather the engine may be
shown. The harness converts `k_obs` to whatever irradiance unit the weather
feed uses as `k_obs * H(doy)` (the same table), and must state that conversion
in its own write-up before the first run. This error applies identically to
every scenario class.

### 2.3 Plant-level parameters (drawn per plant, all classes)

| Parameter | Draw (SAMPLE) |
|-----------|---------------|
| kW | uniform choice from {2, 3, 4, 5, 6, 8, 10} |
| tilt (deg) | uniform 15 to 30 |
| azimuth (deg, 180 = south) | uniform 165 to 195 |
| PR_norm | N(0.78, 0.035^2), clipped to [0.70, 0.86] |
| series length N (readings) | uniform integer 45 to 90 |
| start date | scenario-specific (section 3) |

`PR_norm` is the "fleet norm": 0.78 is a typical healthy rooftop figure. Its
spread stands for ordinary plant-to-plant differences plus the offset between
any yield model's expectation and a given roof.

### 2.4 Orientation factor

    O = 1 - 0.00025 * (tilt - 26)^2 - 0.00006 * (azimuth - 180)^2

SAMPLE quadratic. Within the ranges above O is between about 0.95 and 1.0.

### 2.5 Measurement noise

`e[t]` ~ N(0, sigma_meas^2), with `sigma_meas` ~ uniform 0.01 to 0.03 for
ordinary plants (inverter-app resolution and rounding, reading
inconsistencies). Reported value is `max(0, round(E[t], 1))` kWh, as an
inverter app shows one decimal. One reading per day, no gaps, no zero-output
days.

### 2.6 The dates

Calendar dates use a synthetic year (2025, continuing into 2026 if a window
crosses 31 Dec); this is a label, not claimed real weather. Readings are the
N consecutive days from the start date.

## 3. Five scenario classes

Common: parameters of section 2.3 are drawn first. `PR_i = PR_norm` unless the
scenario says otherwise. `S`, `F` are zero unless stated. Weather as 2.2, no
spell unless stated.

### (a) No issue  (label: `no_issue`)

- Healthy hardware, ordinary noise.
- Start date: uniform over the 365 days.
- Owner-visible series: kWh following the season and the weather, with scatter
  from cloud (typically a few percent to tens of percent day to day) and no
  trend or step. Normal bad-weather days occur by chance and are not labelled.

### (b) Dust / soiling  (label: `soiling`)

Physics: dust accumulates on the glass and cuts irradiance reaching cells; the
loss grows roughly linearly with days since the last rain or cleaning, so
output slides gradually, and recovers only on cleaning or rain.

    S[t] = 0                                    for t < t0
    S[t] = min(0.40, r * (t - t0 + 1))          for t >= t0

- `r`, the soiling rate, per day of output: uniform 0.15 % to 0.60 % per day.
  SAMPLE, in the range commonly described for dusty North Indian conditions
  (not sourced here).
- `t0`, onset day (index within the series): uniform integer from 0 to
  floor(0.4 * N). `t0 = 0` means a plant that starts clean at the first
  reading and slides from there.
- Rejection rule: redraw `r` and `t0` until the cumulative loss on the last
  day, `S[N-1]`, lies in [0.08, 0.35]. This keeps "dust" cases that are
  physically material, and excludes cases whose slope is too small to see by
  design (stated here, so it is not mistaken for a hidden easy set).
- Cleaning: excluded. The series ends while still soiled.
- Rain-wash: excluded. Start dates are drawn so the whole window lies in the
  dry season: start day-of-year uniform from 15 Oct to (5 Jun minus N days,
  rolled over the year end), so the window ends on or before 20 Jun (before
  monsoon onset). No wash event is generated.
- Owner-visible series: output sags steadily relative to what the season and
  weather would give; the sag begins at some point and deepens day by day.
  Weather scatter sits on top.

### (c) Sudden fault  (label: `sudden_fault`)

Physics: a tripped string, a failed optimiser or a derated inverter removes a
fixed share of generation at one moment, and it persists until repaired.

    F[t] = 0                                     for t < tf
    F[tf] = f * u,   u ~ uniform(0.5, 1.0)       (the fault day is a partial day)
    F[t] = f                                     for t > tf

- `f`, step size: uniform 0.12 to 0.70 of output. SAMPLE (one string of two
  gives roughly 0.5; a mild derate is 0.12 to 0.2).
- `tf`, fault day: uniform integer from 20 to N - 7, so at least 20 healthy
  readings before and at least 7 readings at the fault level, ending
  unrepaired.
- Start date: uniform over the 365 days.
- Owner-visible series: normal for weeks, then a drop to a lower level within
  a day, staying there; weather scatter continues on both sides of the step.

### (d) Low since day one  (label: `low_from_start`)

Physics: the plant has a permanently lower performance ratio than a healthy
plant from the first reading (shading, poor wiring, mismatch, bad
commissioning, undersized inverter), so it never produced what was promised.

    PR_i = PR_norm * (1 - L),   L ~ uniform(0.12, 0.35)

- Constant for the whole series, no trend, no step.
- The low end of L (0.12) sits only about three standard deviations of the
  healthy PR spread below the norm; this is intentional (hard cases included).
- Start date: uniform over the 365 days.
- Owner-visible series: tracks season and weather exactly as a healthy plant
  does, but at a uniformly lower level from the very first day.

### (e) Weather or normal variation  (label: `weather_or_noise`)

Two sub-types, both with healthy hardware (`PR_i = PR_norm`), start date
uniform over 365 days.

**(e1) A spell of dull days (monsoon-like or fog-like).**

- Spell length `len`: uniform integer 5 to 14 days.
- During the spell the true index is replaced by `k[t]` ~ uniform(0.12, 0.45)
  i.i.d. per day (heavy overcast, rain). The weather record `k_obs` sees the
  spell (with the record error of 2.2), because the weather is real.
- Placement, equal probability: (i) end-anchored: the spell ends at the last
  reading (`s = N - len`), the hard case for a fault detector; (ii) interior:
  `s` uniform from 10 to N - len - 5, with recovery before the end.
- Start dates are unrestricted by season, so the spell may fall in any month.
- Owner-visible series: a dip of days to two weeks that looks like a fault or
  dust but follows the weather record, then (in case ii) recovers.

**(e2) A hardware-healthy plant with a noisy meter.**

- `sigma_meas` uniform 0.06 to 0.12 (far above the ordinary 0.01 to 0.03).
- Outliers: each reading independently, with probability 0.05, is multiplied
  by a factor drawn with equal probability from uniform(0.50, 0.75) or
  uniform(1.25, 1.50) (misread digit, partial day, double-count).
- No spell; ordinary weather.
- Owner-visible series: ragged readings, some isolated implausible values,
  no persistent trend or step.

## 4. Sample sizes, seeds, and freezing

| Class | Label | n plants | Seeds |
|-------|-------|----------|-------|
| a | no_issue | 60 | 1001 to 1060 |
| b | soiling | 60 | 2001 to 2060 |
| c | sudden_fault | 60 | 3001 to 3060 |
| d | low_from_start | 60 | 4001 to 4060 |
| e1 | weather_or_noise (spell) | 60 | 5001 to 5060 |
| e2 | weather_or_noise (noisy meter) | 60 | 6001 to 6060 |

Total 360 plants. Class e as a whole is 120 plants; the confusion matrix
reports e1 and e2 as separate rows as well as the combined row. One plant per
seed; the seed is the plant's identifier.

Reproducibility. The generator uses only the Python standard library
(`random.Random(seed)`, no other dependency). Draw order per plant is fixed:
(1) kW, (2) tilt, (3) azimuth, (4) PR_norm, (5) N, (6) start date, (7)
scenario-specific parameters in the order written in section 3 (with redraws
for rejection rules as written), (8) `sigma_meas`, (9) latent weather `z[0]`
then `g[t]`, (10) spell values if any, (11) `eta[t]`, (12) `e[t]` and outlier
draws. A conforming implementation must produce identical files from the same
seed.

Output per plant (JSON): the plant {lat, lon, kW, tilt, azimuth}; the
readings [{date, kwh}] (owner-visible); the weather record [{date, k_obs}];
and, in a separate hidden-truth block that the engine harness must never read:
the label, subtype, all drawn parameters, and the true `k`, `S`, `F` series.

Freezing. The generator is frozen when first written down. It must not be
changed after seeing any engine result, for any reason that would alter the
sampled data. A bug discovered after a run is reported as found; the run's
results stay in the report, and a corrected generator is released as v2 with
a new seed list (all +10000), both versions reported side by side. The
generator's commit hash and this file's hash are recorded in the results.
Also, the engine's thresholds must not be tuned against these seeds and then
reported on them; if thresholds are tuned after seeing these results, the new
numbers need the v2 (fresh) seeds and the tuning must be named in the
write-up as tuning.

## 5. Metrics to report

Each plant gets the engine's ranked causes (soiling, sudden_fault,
low_from_start, weather_or_noise) with confidence levels low/medium/high. The
harness (phase B) must write down, before the first run, exactly which engine
output field corresponds to the "ranked cause list" and which to a
"suggestion-level cause" (below).

Definition. A cause is "suggestion-level" if the engine surfaces it to the
owner as something to act on or investigate (a recommendation or suggestion
is generated for it), as opposed to merely listing it with low weight as
context. A plant counts as "no issue" correct only if the engine reports no
suggestion-level cause. A top-ranked low-confidence weather or normal-variation
entry that produces no suggestion counts as "no suggestion-level cause".

1. Confusion matrix of true cause (rows: a, b, c, d, e1, e2, plus combined e)
   by the engine's top-1 cause (columns: soiling, sudden_fault,
   low_from_start, weather_or_noise, none = no suggestion-level cause), with
   counts, not only percentages. For row a the correct cell is "none"; for
   rows b, c, d the correct cell is the matching cause; for e the correct cell
   is weather_or_noise. A class e plant that lands in "none" is shown in its
   own column and is not counted as a top-1 hit.
2. Top-1 accuracy per class, with 95 % Wilson intervals, and the number n.
3. Top-3 hit rate for rows b, c, d, e: the share where the true cause is
   among the engine's first three ranked causes. Not defined for row a
   (reported as n/a).
4. "Dust predicted as weather": the count and share of class b plants whose
   top-1 is weather_or_noise. Reported separately from
5. "Weather predicted as dust": the count and share of class e plants (and e1
   and e2 separately) whose top-1 is soiling. Never merged into one number.
6. False-alarm rate: the share of class a and class e plants where the engine
   reports a suggestion-level hardware cause (soiling, sudden_fault or
   low_from_start).
7. Confidence calibration: for each confidence level of the top-1 cause, the
   share of plants where that top-1 is correct, with counts.
8. Optional breakdowns, pre-declared so they are not cherry-picked: class b
   by r tercile, class c by f tercile, class d by L tercile, class e1 by
   placement (end-anchored versus interior).

Every table and figure repeats the label: "Synthetic data. Validates the
logic, not real-world accuracy. Thresholds unvalidated."

## 6. What this cannot show

- Real-world accuracy. The generator is the authors' physical simplification;
  the engine may match it for reasons real plants will not respect.
- Anything about the engine's behaviour on real weather: the weather feed here
  is the generator's own true index plus a simple i.i.d. error, not real NASA
  POWER data with its spatial, temporal and clear-sky biases.
- Other climates, latitudes, or tilts than the single Lucknow-like site.
- Mixed causes (dust and a fault together, a fault during a monsoon spell),
  gradual faults, intermittent faults, partial shading with a seasonal angle,
  soiling already present at the first reading (which looks like low-from-
  start), cleaning followed by recovery, rain-wash events, degradation
  (ageing), bird droppings or other local soiling, inverter clipping, grid
  outages, zero-output days, missing days.
- Real meter and OCR error. The noise model is Gaussian plus rare outliers,
  and the real reading path (a photo read by a vision model) is not exercised.
- Day-to-day temperature effects (only seasonal, folded into the PR).
- Whether the PVGIS expectation is correct for a given roof; the spread in
  PR_norm only stands in for it.
- Whether the sampled ranges (loss rates, step sizes, spell lengths) are
  realistic; they are SAMPLE assumptions, and the results depend on them.
- Whether recommendations are useful, or whether the verify, escalate or
  complaint steps work; only the cause ranking is tested.
- Statistical power for rare cases: 60 plants per class gives wide intervals
  (about plus or minus 12 points near 50 %).

Synthetic data. Validates the logic, not real-world accuracy. Thresholds unvalidated.

## Harness decisions (written before the first run)

Written after reading only the shapes of the site document and the reading rows (app/main.py, app/store.py,
app/expected.py function bodies, and the output keys and cause names of app/audit.py), and before any
engine result on generated plants was seen. No threshold value was read. The harness is `scripts/backtest.py`.
A `--check` run (generator bounds, and one call to the engine whose result is discarded) was done before this
section was written; it prints no engine result.

1. Ranked cause list. The output field is `hypotheses` of `audit.compute(site)` after the LAST reading of the
   plant (what the owner sees at the end of the series). The engine's four names map to the spec's:
   `soiling` = soiling, `sudden_fault` = sudden_fault, `low_from_day_one` = low_from_start,
   `weather_noise` = weather_or_noise. "Top-1" is `hypotheses[0]`; "top-3" is `hypotheses[:3]`; the confidence
   is that entry's `confidence`.

2. Suggestion-level. A cause is suggestion-level if the engine's own public function `audit.update_actions`
   proposes an action for it, run on a copy of the site with no earlier actions after the last reading. That
   is the engine's own definition of "surfaced to the owner as something to act on". If the top-ranked cause has
   no action (weather_noise) or is below the engine's own proposal level, nothing is proposed and the plant is
   "no suggestion-level cause". No threshold is read or restated by the harness. Consequence for the spec's
   single matrix: the spec's top-1 matrix has a "none = no suggestion-level cause" column that mixes two
   questions (what ranked first; was anything suggested). The harness reports them as two matrices: Matrix 1,
   ranked top-1 (columns: the four causes, plus error); Matrix 2, suggestion-level (columns: the three hardware
   causes, none, error). Scoring is exactly the spec's: class a is correct only if Matrix 2 says none; classes
   b, c, d, e are correct if the ranked top-1 is the true cause (Matrix 1); the strict secondary rate (ranked
   top-1 correct and suggested) is also reported for b, c, d. False alarms (classes a and e) use Matrix 2.

3. Weather feed units. The engine's feed is NASA POWER `ALLSKY_SFC_SW_DWN` (kWh/m2/day) per day, divided by the
   site's monthly climatology to get the weather index. The harness builds, per plant:
   - daily irradiance = `k_obs[t] * H(date)` (H linearly interpolated, as in the spec), passed through the
     engine's own `expected.expected_for_period` so the index and expected kWh are computed by engine code;
   - the climatology stand-in `climatology_ghi[m] = H_table[m] * kmean[m]` (the mean irradiance of the same
     SAMPLE table);
   - the PVGIS stand-in `pvgis_e_d[m] = kW * O * H_table[m] * 0.78 * kmean[m]` (the monthly mean daily kWh of a
     nominal-PR plant under the month's climatological weather; not interpolated; uses the nominal PR 0.78,
     not the plant's own PR_norm, because the engine does not know the plant's true PR);
   - all readings `kind = "daily"`, `weather_known = true`, `loss_pct = 14.0` (the engine's own default), the
     site `synthetic = true`, `sample = true`.
   Both stand-ins come from the generator's own table, so the engine's expectation is unrealistically well
   matched to the generator's climate; real PVGIS and POWER differ from any plant in ways this does not model.

4. Spec ambiguity resolved before the run (dust start dates). Section 3(b) says both "start uniform from 15 Oct to
   5 Jun minus N days" and "the window ends on or before 20 Jun". The harness uses the explicit end rule: the
   start is uniform over all start days from 15 Oct 2025 such that the last reading is on or before 20 Jun 2026.

5. Plants that fail to run through the engine are counted as error rows (shown in the matrices and counted as
   incorrect in the accuracy rates). The seeds are the spec's: seed = class base + index (1001..1060 for a,
   2001..2060 for b, and so on). Spec hash recorded below is the SHA-256 of the spec text before this section.

## Results (v1 seeds)

**Synthetic data. Validates the logic, not real-world accuracy. Thresholds unvalidated.**

- Run date: 2026-10-10 (IST), v1 generator, spec seeds 1001-6060, 360 plants, no seed offset.
- Reproduce, from the repo root, with the project's venv, offline (the weather feed is built by the harness, no
  PVGIS or NASA call and no env var needed): `.venv/Scripts/python.exe scripts/backtest.py`
  (generator-only checks, no engine result: `.venv/Scripts/python.exe scripts/backtest.py --check`).
  The output below is that command's stdout, unedited, apart from this heading.
- Hashes (first 16 hex of SHA-256): spec text before "Harness decisions" 40b27b61381f7ac6 (equal to the
  committed spec); `scripts/backtest.py` 0a99add95357c66a (uncommitted when run; repo HEAD 75bc89c).
- One earlier full run crashed in the report printing (a list-plus-tuple TypeError in the table header code)
  after the engine had run on all plants and before anything was printed; no number from it was seen. The report
  code was fixed (`list(HARDWARE)`); the generator and the harness decisions were not touched, and the run below is
  the first that produced numbers. The script hash above is the one after that fix.
- Engine error rows: 0 of 360.

scripts/backtest.py sha256 0a99add95357c66a; spec (text before 'Harness decisions') sha256 40b27b61381f7ac6; repo HEAD 75bc89c

**Synthetic data. Validates the logic, not real-world accuracy. Thresholds unvalidated.**

Plants: 360 (a: 60, b: 60, c: 60, d: 60, e1: 60, e2: 60); seed offset 0 (v1); engine errors: 0.

#### Matrix 1: ranked top-1 cause (rows true class, columns the engine's first-ranked cause, counts)

| true \ engine top-1 | soiling | sudden_fault | low_from_start | weather_or_noise | error | n |
|---|---|---|---|---|---|---|
| a (no_issue) | 12 | 0 | 0 | 48 | 0 | 60 |
| b | 42 | 14 | 0 | 4 | 0 | 60 |
| c | 14 | 45 | 0 | 1 | 0 | 60 |
| d | 6 | 0 | 38 | 16 | 0 | 60 |
| e1 | 8 | 0 | 0 | 52 | 0 | 60 |
| e2 | 9 | 2 | 0 | 49 | 0 | 60 |
| e | 17 | 2 | 0 | 101 | 0 | 120 |

#### Matrix 2: suggestion-level cause (the engine proposed an action for its top cause; none = no suggestion)

| true \ suggestion-level | soiling | sudden_fault | low_from_start | none | error | n |
|---|---|---|---|---|---|---|
| a (no_issue) | 12 | 0 | 0 | 48 | 0 | 60 |
| b | 42 | 1 | 0 | 17 | 0 | 60 |
| c | 14 | 22 | 0 | 24 | 0 | 60 |
| d | 6 | 0 | 38 | 16 | 0 | 60 |
| e1 | 8 | 0 | 0 | 52 | 0 | 60 |
| e2 | 9 | 0 | 0 | 51 | 0 | 60 |
| e | 17 | 0 | 0 | 103 | 0 | 120 |

#### Top-1 accuracy per class

Scoring: class a correct iff the engine reports no suggestion-level cause (matrix 2); classes b, c, d, e correct iff the ranked top-1 is the true cause (matrix 1). Errors count as incorrect.

| class | n | correct | top-1 accuracy |
|---|---|---|---|
| a | 60 | 48 | 48/60 = 80.0% (95% Wilson 68.2-88.2%) |
| b | 60 | 42 | 42/60 = 70.0% (95% Wilson 57.5-80.1%) |
| c | 60 | 45 | 45/60 = 75.0% (95% Wilson 62.8-84.2%) |
| d | 60 | 38 | 38/60 = 63.3% (95% Wilson 50.7-74.4%) |
| e1 | 60 | 52 | 52/60 = 86.7% (95% Wilson 75.8-93.1%) |
| e2 | 60 | 49 | 49/60 = 81.7% (95% Wilson 70.1-89.4%) |
| e | 120 | 101 | 101/120 = 84.2% (95% Wilson 76.6-89.6%) |

Secondary, stricter: ranked top-1 correct AND suggestion-level (the owner would actually be offered the right action).

| class | n | correct and suggested | rate |
|---|---|---|---|
| b | 60 | 42 | 42/60 = 70.0% (95% Wilson 57.5-80.1%) |
| c | 60 | 22 | 22/60 = 36.7% (95% Wilson 25.6-49.3%) |
| d | 60 | 38 | 38/60 = 63.3% (95% Wilson 50.7-74.4%) |

#### Top-3 hit rate (true cause among the engine's first three ranked causes; n/a for class a)

| class | n | hits | top-3 |
|---|---|---|---|
| b | 60 | 60 | 60/60 = 100.0% (95% Wilson 94.0-100.0%) |
| c | 60 | 60 | 60/60 = 100.0% (95% Wilson 94.0-100.0%) |
| d | 60 | 41 | 41/60 = 68.3% (95% Wilson 55.8-78.7%) |
| e1 | 60 | 58 | 58/60 = 96.7% (95% Wilson 88.6-99.1%) |
| e2 | 60 | 52 | 52/60 = 86.7% (95% Wilson 75.8-93.1%) |
| e | 120 | 110 | 110/120 = 91.7% (95% Wilson 85.3-95.4%) |

#### Dust predicted as weather, and weather predicted as dust (reported separately)

- Dust predicted as weather (class b plants whose ranked top-1 is weather_or_noise): 4/60 = 6.7% (95% Wilson 2.6-15.9%)

- Weather predicted as dust (class e plants whose ranked top-1 is soiling):

| class | n | top-1 soiling | rate |
|---|---|---|---|
| e1 | 60 | 8 | 8/60 = 13.3% (95% Wilson 6.9-24.2%) |
| e2 | 60 | 9 | 9/60 = 15.0% (95% Wilson 8.1-26.1%) |
| e | 120 | 17 | 17/120 = 14.2% (95% Wilson 9.0-21.5%) |

#### False-alarm rate (the engine reports a suggestion-level hardware cause on a plant with healthy hardware)

| class | n | false alarms | rate | by suggested cause |
|---|---|---|---|---|
| a | 60 | 12 | 12/60 = 20.0% (95% Wilson 11.8-31.8%) | soiling 12, sudden_fault 0, low_from_start 0 |
| e1 | 60 | 8 | 8/60 = 13.3% (95% Wilson 6.9-24.2%) | soiling 8, sudden_fault 0, low_from_start 0 |
| e2 | 60 | 9 | 9/60 = 15.0% (95% Wilson 8.1-26.1%) | soiling 9, sudden_fault 0, low_from_start 0 |
| e | 120 | 17 | 17/120 = 14.2% (95% Wilson 9.0-21.5%) | soiling 17, sudden_fault 0, low_from_start 0 |
| a + e | 180 | 29 | 29/180 = 16.1% (95% Wilson 11.5-22.2%) | soiling 29, sudden_fault 0, low_from_start 0 |

#### Confidence calibration (confidence of the ranked top-1 versus whether the plant is scored correct)

| top-1 confidence | plants | scored correct | share correct |
|---|---|---|---|
| low | 46 | 26 | 26/46 = 56.5% (95% Wilson 42.2-69.8%) |
| medium | 71 | 56 | 56/71 = 78.9% (95% Wilson 68.0-86.8%) |
| high | 243 | 192 | 192/243 = 79.0% (95% Wilson 73.5-83.7%) |

Same, by true class and confidence (correct / plants):

| class | low | medium | high |
|---|---|---|---|
| a | 0/0 | 14/18 | 34/42 |
| b | 0/16 | 12/13 | 30/31 |
| c | 23/24 | 0/5 | 22/31 |
| d | 0/1 | 13/16 | 25/43 |
| e1 | 2/2 | 9/11 | 41/47 |
| e2 | 1/3 | 8/8 | 40/49 |
| e | 3/5 | 17/19 | 81/96 |

#### Pre-declared breakdowns (terciles of the 60 plants by the hidden parameter; top-1 scored as above)

Class b by soiling rate r (per day):

| tercile | range | n | correct | top-1 |
|---|---|---|---|---|
| low | 0.0015 to 0.0031 | 20 | 11 | 11/20 = 55.0% (95% Wilson 34.2-74.2%) |
| middle | 0.0031 to 0.0042 | 20 | 12 | 12/20 = 60.0% (95% Wilson 38.7-78.1%) |
| high | 0.0042 to 0.0060 | 20 | 19 | 19/20 = 95.0% (95% Wilson 76.4-99.1%) |

Class c by step size f:

| tercile | range | n | correct | top-1 |
|---|---|---|---|---|
| low | 0.1209 to 0.2451 | 20 | 16 | 16/20 = 80.0% (95% Wilson 58.4-91.9%) |
| middle | 0.2476 to 0.4112 | 20 | 17 | 17/20 = 85.0% (95% Wilson 64.0-94.8%) |
| high | 0.4192 to 0.6609 | 20 | 12 | 12/20 = 60.0% (95% Wilson 38.7-78.1%) |

Class d by low-from-start loss L:

| tercile | range | n | correct | top-1 |
|---|---|---|---|---|
| low | 0.1215 to 0.2016 | 20 | 3 | 3/20 = 15.0% (95% Wilson 5.2-36.0%) |
| middle | 0.2063 to 0.2744 | 20 | 15 | 15/20 = 75.0% (95% Wilson 53.1-88.8%) |
| high | 0.2846 to 0.3477 | 20 | 20 | 20/20 = 100.0% (95% Wilson 83.9-100.0%) |

Class e1 by spell placement:

| placement | n | top-1 weather_or_noise | rate | suggestion-level hardware cause |
|---|---|---|---|---|
| end-anchored | 33 | 26 | 26/33 = 78.8% (95% Wilson 62.2-89.3%) | 7 |
| interior | 27 | 26 | 26/27 = 96.3% (95% Wilson 81.7-99.3%) | 1 |

**Synthetic data. Validates the logic, not real-world accuracy. Thresholds unvalidated.**


### Known limitations of these results

Weak results, stated as measured:

- Sudden fault: the ranked top-1 is right for 45/60 plants (75.0%), but the engine proposed the right action for
  only 22/60 (36.7%). Of the 45, 23 had low confidence and no suggestion. 14/60 faults were ranked soiling first,
  and 24/60 faults ended with no suggestion at all. In the highest step-size tercile (f 0.42 to 0.66) top-1 was
  12/20 (60%), lower than the middle and low terciles.
- Low since day one: top-1 38/60 (63.3%), top-3 41/60 (68.3%). In the lowest-loss tercile (L 0.12 to 0.20)
  top-1 was 3/20 (15%); 16/60 of the class were ranked weather_or_noise first and 6/60 soiling first.
- Dust: top-1 42/60 (70.0%). In the two lower soiling-rate terciles it was 11/20 and 12/20. 16 class b plants had a
  "low" top-1 confidence and none of the 16 was correct (class b, low: 0/16).
  17/60 dust plants ended with no suggestion. 14/60 dust plants were ranked sudden_fault first.
- False alarms: 12/60 healthy class a plants (20.0%) got a suggestion-level cause, all "soiling". Across classes a
  and e, 29/180 (16.1%) got a suggestion-level hardware cause, all 29 "soiling". Weather predicted as dust:
  17/120 class e plants (14.2%). End-anchored dull spells (the hard case) were ranked weather_or_noise first only
  26/33 times (78.8%), and 7 of them got a suggestion-level hardware cause.
- Confidence does not separate right from wrong above "low": 78.9% of medium and 79.0% of high top-1 plants were
  scored correct (56/71 and 192/243); class d with high confidence was 25/43 (58%) and class c with high confidence
  22/31 (71%).
- Top-3 hit rates of 100% for dust and for sudden fault say little: the engine ranks four causes, so top-3 misses
  a plant only if its true cause is ranked last.

Limits of the method (see also section 6 of the spec):

- Single synthetic Lucknow-like site, one generator written by the same authors who wrote the engine under test; the
  engine's expectation stand-ins (PVGIS and POWER climatology) were built from the generator's own SAMPLE table,
  which a real PVGIS or POWER feed would not match. That favours the engine; it is not a measure of real accuracy.
- The generator's healthy-plant mean specific yield (section 2.2 check, `--check`) came out 0 to 7% below the
  spec's Y_typ in nine months and 2 to 8% above it in July, August and September (for example March 4.46 vs 4.64, October 3.91 vs 4.09, November 3.39 vs 3.65). This is
  a consequence of the spec's orientation factor and the clip of the cloud deficit at zero, not corrected, and means
  the healthy generator plants sit a few percent below the PVGIS stand-in. It may contribute to the soiling false
  alarms and has not been tested as a cause.
- The scoring rule is the harness's reading of the spec's "none" column (two matrices). The results under another
  reading would differ for classes b, c and d.
- Intervals are wide at n = 60 per class (the tercile and placement breakdowns, n = 20 to 33, are wider still) and
  nothing here was corrected for multiple comparisons.
- Seeds are fixed and the generator is frozen; this is one draw of 360 plants and the numbers move with the seed set.
