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
