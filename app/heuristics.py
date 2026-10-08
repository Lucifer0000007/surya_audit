"""Every classification threshold Surya Audit uses, in one place.

HEURISTIC_UNVALIDATED: these are design parameters, not validated against field
data. They were tuned only against the synthetic scenario (scripts/make_synthetic_site.py).
Every change is logged in LOOP_LOG.md and documented in the README.

"Points" are confirmed readings (one daily or weekly reading = one point).
"Relative output" is a point's actual/expected ratio divided by the site's
calibrated baseline ratio, so 1.0 means "as usual for this plant".
"""

HEURISTIC_UNVALIDATED = True

# Weather normalization
LOW_SUN_INDEX = 0.4  # actual/climatological irradiance below this: point too dim to judge

# Learn: per-site baseline
CALIBRATION_POINTS = 14  # first N usable points set the site's baseline ratio
MIN_CALIBRATION_POINTS = 7  # fewer usable points than this: baseline not learnt yet

# Timeline flags
FLAG_BELOW = 0.85  # relative output below this flags the point as a dip

# Windows (in points)
RECENT_POINTS = 3
PRIOR_POINTS = 7
TREND_POINTS = 14

# Sudden fault: the run of flagged points at the end (the dip) vs the PRIOR_POINTS before it
MIN_DIP_POINTS = 2  # a single dip is not a run
SUDDEN_DROP_MIN = 0.15  # the first dip point must already be this far below the points before it
SUDDEN_DROP_FULL = 0.30  # median dip drop at which the score saturates
PRIOR_STABLE_SLOPE = 0.01  # points before the dip count as steady if |slope per day| is below this

# Soiling: gradual decline over the trend window
SOILING_SLOPE_MIN = 0.002  # decline per day below this is not a trend
SOILING_SLOPE_FULL = 0.008  # decline per day at which the score saturates
SOILING_DECLINE_MIN = 0.05  # recent relative output must be at least this far below 1.0
SOILING_PENALTY_IF_STEP = 0.3  # soiling score multiplier when a step change is present

# Low from day one: baseline ratio against the PVGIS expectation
LOW_FROM_DAY_ONE_RATIO = 0.80  # baseline below this is low from the start
LOW_FROM_DAY_ONE_FULL = 0.60  # baseline at which the score saturates

# Weather / noise
NOISE_DEFICIT = 0.10  # recent deficit smaller than this is within normal variation
UNKNOWN_WEATHER_NOISE_MAX = 0.4  # unpublished weather alone lifts weather/noise to "medium" at most

# Confidence levels from a 0..1 score
SCORE_FLOOR_WHEN_PRESENT = 0.4  # a gradual-decline or low-from-day-one pattern, once detected, starts at "medium"
CONFIDENCE_HIGH = 0.7
CONFIDENCE_MEDIUM = 0.4
UNCALIBRATED_MAX_SCORE = 0.39  # before the baseline is learnt, no cause (weather/noise included) goes above "low"
UNKNOWN_WEATHER_MAX_SCORE = 0.69  # recent weather unknown: no cause other than weather/noise goes above "medium"

# Act and verify
PROPOSE_MIN_CONFIDENCE = "medium"  # propose an action only at this confidence or above
VERIFY_POINTS = 3  # recovery is judged once, on the first N usable points after approval
RECOVERED_AT = 0.95  # median relative output over those points at or above this counts as recovered
# An inspection is judged on the ratio to PVGIS instead: recovered once at or above LOW_FROM_DAY_ONE_RATIO.

# Escalate
COMPLAINT_MIN_CONFIDENCE = "medium"  # causes listed in the draft complaint
