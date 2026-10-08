"""Detect, classify, act, verify, learn: the audit for one site, from its confirmed readings.

Possible causes are ranked with confidence levels. Nothing here is a diagnosis, and no
action runs by itself: actions are suggestions the owner approves.
"""

from datetime import date
from statistics import median

from app import heuristics as H
from app.expected import POWER_DAILY_URL, POWER_PARAM

# Order breaks ties: a cause the owner can act on ranks above weather/noise.
CAUSES = ("sudden_fault", "soiling", "low_from_day_one", "weather_noise")

ACTIONS = {
    "soiling": {
        "kind": "clean_panels",
        "suggestion": "Clean the panels now, only if you can reach them safely: plain water and a soft cloth, "
                      "early morning or evening. Then keep logging readings for a few days.",
    },
    "sudden_fault": {
        "kind": "check_inverter",
        "suggestion": "Look at the inverter display or app for an error code, and check that its isolator and "
                      "breaker are on. Do not open the inverter or panels; ask the installer to visit if unsure.",
    },
    "low_from_day_one": {
        "kind": "request_inspection",
        "suggestion": "Ask the installer for an inspection against the expected output, and keep this audit as evidence.",
    },
}

LEVELS = ("low", "medium", "high")


def at_least(confidence: str, minimum: str) -> bool:
    return LEVELS.index(confidence) >= LEVELS.index(minimum)


def _confidence(score: float) -> str:
    if score >= H.CONFIDENCE_HIGH:
        return "high"
    if score >= H.CONFIDENCE_MEDIUM:
        return "medium"
    return "low"


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def _slope(points: list[dict]) -> float:
    """Least-squares slope of relative output per day."""
    if len(points) < 2:
        return 0.0
    xs = [p["day"] for p in points]
    ys = [p["relative"] for p in points]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return 0.0 if den == 0 else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den


def _rows(site: dict) -> list[dict]:
    rows = []
    for r in sorted(site["readings"], key=lambda r: r["date"]):
        ratio = r["kwh"] / r["expected_kwh"] if r["expected_kwh"] > 0 else None
        low_sun = r["weather_index"] < H.LOW_SUN_INDEX
        rows.append({
            "date": r["date"],
            "kind": r["kind"],
            "kwh": r["kwh"],
            "expected_kwh": r["expected_kwh"],
            "ratio": None if ratio is None else round(ratio, 3),
            "weather_index": r["weather_index"],
            "weather_known": r["weather_known"],
            "weather_source": r["weather_source"],
            "low_sun": low_sun,
            "usable": ratio is not None and not low_sun,
            "day": date.fromisoformat(r["date"]).toordinal(),
        })
    return rows


def _restarts(site: dict, usable: list[dict]) -> list[str]:
    """Dates after which the baseline is re-learnt: approved inspections that brought output up,
    judged on readings with published weather (a provisional verdict does not count)."""
    restarts = []
    for a in site["actions"].values():
        if a["kind"] == "request_inspection" and a["status"] == "approved":
            v = _verify(a, usable)
            if v["outcome"] == "recovered" and not v["provisional"]:
                restarts.append(a["approved_on"])
    return sorted(restarts)


def _learn(rows: list[dict], restarts: list[str]) -> list[dict]:
    """Learn a baseline per segment (from the start, then after each restart) and set each point's
    relative output against its own segment. Returns the segments, current one last."""
    usable = [p for p in rows if p["usable"]]
    bounds = [None, *restarts]
    segments = []
    for i, since in enumerate(bounds):
        until = bounds[i + 1] if i + 1 < len(bounds) else None
        calib = [p for p in usable if (since is None or p["date"] > since)
                 and (until is None or p["date"] <= until)][: H.CALIBRATION_POINTS]
        value = median(p["ratio"] for p in calib) if len(calib) >= H.MIN_CALIBRATION_POINTS else None
        segments.append({"since": since, "until": until, "value": value, "points": len(calib)})
    for p in rows:
        seg = next(s for s in reversed(segments) if s["since"] is None or p["date"] > s["since"])
        usable_baseline = seg["value"] is not None and seg["value"] > 0  # a plant that produced nothing has no usual level to compare with
        p["relative"] = None if p["ratio"] is None else round(p["ratio"] / (seg["value"] if usable_baseline else 1.0), 3)
        p["compared_with"] = "plant_usual" if usable_baseline else "pvgis_estimate"
        p["flagged"] = p["usable"] and p["relative"] < H.FLAG_BELOW
    return segments


def _classify(usable: list[dict], current: dict) -> list[dict]:
    baseline, since = current["value"], current["since"]
    recent = usable[-H.RECENT_POINTS:]
    trend = usable[-H.TREND_POINTS:]
    hyps = {c: {"score": 0.0, "why": []} for c in CAUSES}

    if len(recent) < H.RECENT_POINTS:
        for c in CAUSES:
            hyps[c]["why"].append("Not enough usable readings yet to judge.")
        return _rank(hyps)

    recent_rel = median(p["relative"] for p in recent)
    recent_known = [p["ratio"] for p in recent if p["weather_known"]]
    recent_ratio = median(recent_known) if recent_known else None  # unpublished weather cannot clear a gap
    deficit = 1.0 - recent_rel

    # Sudden fault: the run of dips at the end starts with a step down from steady readings.
    dip = []
    for p in reversed(usable):
        if not p["flagged"]:
            break
        dip.insert(0, p)
    before = usable[: len(usable) - len(dip)][-H.PRIOR_POINTS:]
    step = False
    if len(dip) < H.MIN_DIP_POINTS:
        hyps["sudden_fault"]["why"].append(
            f"No run of {H.MIN_DIP_POINTS} or more dips at the end of the timeline.")
    elif len(before) < H.PRIOR_POINTS:
        hyps["sudden_fault"]["why"].append(f"Needs {H.PRIOR_POINTS} usable readings before the dip to compare against.")
    else:
        before_rel = median(p["relative"] for p in before)
        drop = 1.0 - median(p["relative"] for p in dip) / before_rel if before_rel > 0 else 0.0
        entry_drop = 1.0 - dip[0]["relative"] / before_rel if before_rel > 0 else 0.0
        steady = abs(_slope(before)) < H.PRIOR_STABLE_SLOPE
        step = entry_drop >= H.SUDDEN_DROP_MIN and steady
        if step:
            hyps["sudden_fault"]["score"] = _clamp(drop / H.SUDDEN_DROP_FULL)
            hyps["sudden_fault"]["why"].append(
                f"Since {dip[0]['date']}, {len(dip)} readings in a row are {drop:.0%} below the steady "
                f"{len(before)} before them, and the first one already dropped {entry_drop:.0%}. A step down "
                "like this fits a fault such as an inverter trip or a disconnected string, but other causes are possible.")
        else:
            reason = "the readings before it were not steady" if not steady else \
                f"the first dip was only {entry_drop:.0%} below the readings before it"
            hyps["sudden_fault"]["why"].append(f"The dip since {dip[0]['date']} is not a clean step: {reason}.")

    # Soiling: a gradual decline across the trend window.
    slope = _slope(trend)
    if -slope >= H.SOILING_SLOPE_MIN and deficit >= H.SOILING_DECLINE_MIN:
        score = _clamp((-slope - H.SOILING_SLOPE_MIN) / (H.SOILING_SLOPE_FULL - H.SOILING_SLOPE_MIN) + H.SCORE_FLOOR_WHEN_PRESENT)
        if step:
            score *= H.SOILING_PENALTY_IF_STEP
        hyps["soiling"]["score"] = score
        hyps["soiling"]["why"].append(
            f"Output has slid about {-slope:.1%} per day over the last {len(trend)} readings and is now "
            f"{deficit:.0%} below this plant's usual level. A gradual slide fits dust building up.")
        if step:
            hyps["soiling"]["why"].append("A sudden step is also present, which dust alone does not explain well.")
    else:
        hyps["soiling"]["why"].append(
            f"No gradual decline: the trend is {slope:+.1%} per day and output is {deficit:.0%} below usual.")

    # Low from day one: the learnt baseline is far below the PVGIS estimate, and recent readings still are.
    first = "its first readings" if since is None else f"its first readings after the inspection approved on {since}"
    low_start = baseline is not None and baseline < H.LOW_FROM_DAY_ONE_RATIO
    low_plant = low_start and (recent_ratio is None or recent_ratio < H.LOW_FROM_DAY_ONE_RATIO)
    if baseline is None:
        hyps["low_from_day_one"]["why"].append(
            f"Needs {H.MIN_CALIBRATION_POINTS} usable readings to learn this plant's usual level.")
    elif low_plant:
        hyps["low_from_day_one"]["score"] = _clamp(
            (H.LOW_FROM_DAY_ONE_RATIO - baseline) / (H.LOW_FROM_DAY_ONE_RATIO - H.LOW_FROM_DAY_ONE_FULL)
            + H.SCORE_FLOOR_WHEN_PRESENT)
        recent_text = (f"recent readings with published weather are at {recent_ratio:.0%}" if recent_ratio is not None
                       else "weather for the recent readings is not available yet, so they cannot show otherwise")
        hyps["low_from_day_one"]["why"].append(
            f"Over {first}, the plant produced {baseline:.0%} of the weather-adjusted PVGIS estimate, and "
            f"{recent_text}. That fits under-sized or mis-installed equipment, dust already "
            "present when logging began, or shading, but the estimate itself is approximate.")
    elif low_start:
        hyps["low_from_day_one"]["why"].append(
            f"Over {first}, the plant produced {baseline:.0%} of the weather-adjusted PVGIS estimate, but recent "
            f"readings with published weather are back to {recent_ratio:.0%}, so that early gap is no longer there.")
    else:
        hyps["low_from_day_one"]["why"].append(
            f"Over {first}, the plant produced {baseline:.0%} of the weather-adjusted PVGIS estimate, "
            "which is not unusually low.")

    # Weather / noise: a small deficit; unpublished weather only makes it possible, not likely.
    unknown = sum(not p["weather_known"] for p in recent) / len(recent)
    small = _clamp(1.0 - max(deficit, 0.0) / H.NOISE_DEFICIT)
    hyps["weather_noise"]["score"] = max(small, min(unknown, H.UNKNOWN_WEATHER_NOISE_MAX))
    if small > 0:
        hyps["weather_noise"]["why"].append(
            f"Recent output is within {H.NOISE_DEFICIT:.0%} of usual ({-deficit:+.0%}), which normal variation can explain.")
    if unknown:
        hyps["weather_noise"]["why"].append(
            f"Weather for {unknown:.0%} of the recent readings is not available yet, so their expectation uses "
            "the monthly average and cloudy days may look like losses.")
    if not hyps["weather_noise"]["why"]:
        hyps["weather_noise"]["why"].append(f"Output is {deficit:.0%} below usual on days with known weather, more than noise explains.")

    # Caps: be less sure before the baseline is learnt or while recent weather is unknown.
    for c in CAUSES:
        if baseline is None:
            hyps[c]["score"] = min(hyps[c]["score"], H.UNCALIBRATED_MAX_SCORE)
        elif unknown and c != "weather_noise":
            hyps[c]["score"] = min(hyps[c]["score"], H.UNKNOWN_WEATHER_MAX_SCORE)
    if baseline is None:
        hyps["weather_noise"]["why"].append(
            f"This plant's usual level is not learnt yet ({current['points']} of {H.MIN_CALIBRATION_POINTS} usable readings), "
            "so every cause stays at low confidence.")

    # Weather explains day-to-day wobble, not a plant that has been low from its first readings.
    if low_plant:
        hyps["weather_noise"]["score"] = min(hyps["weather_noise"]["score"], hyps["low_from_day_one"]["score"])
        hyps["weather_noise"]["why"].append(
            "Weather can explain day-to-day changes, not a gap to the estimate that has been there from the start.")
    return _rank(hyps)


def _rank(hyps: dict) -> list[dict]:
    ranked = sorted(CAUSES, key=lambda c: (-hyps[c]["score"], CAUSES.index(c)))
    return [{"cause": c, "confidence": _confidence(hyps[c]["score"]), "score": round(hyps[c]["score"], 2),
             "why": hyps[c]["why"]} for c in ranked]


def _verify(action: dict, usable: list[dict]) -> dict:
    """Judge recovery once, on the first VERIFY_POINTS usable readings after approval.
    The verdict is provisional while weather for any of those readings is unpublished."""
    if action["status"] != "approved":
        return {"outcome": "not_approved", "why": "The owner has not approved this suggestion.",
                "back_later": False, "provisional": False}
    inspection = action["kind"] == "request_inspection"
    bar = H.LOW_FROM_DAY_ONE_RATIO if inspection else H.RECOVERED_AT
    unit = "of the weather-adjusted PVGIS estimate" if inspection else "of this plant's usual output"
    after = [p for p in usable if p["date"] > action["approved_on"]]
    values = [p["ratio"] if inspection else p["relative"] for p in after]
    window = values[: H.VERIFY_POINTS]
    if len(window) < H.VERIFY_POINTS:
        return {"outcome": "pending", "back_later": False, "provisional": False,
                "why": f"{len(window)} of {H.VERIFY_POINTS} usable readings logged after {action['approved_on']}."}
    value = median(window)
    unknown = sum(not p["weather_known"] for p in after[: H.VERIFY_POINTS])
    note = (f" Weather for {unknown} of those readings is not available yet, so this verdict may change."
            if unknown else "")
    if value >= bar:
        return {"outcome": "recovered", "back_later": False, "provisional": bool(unknown),
                "why": f"The {H.VERIFY_POINTS} readings after {action['approved_on']} were at {value:.0%} {unit}.{note}"}
    # Back later: any later run of VERIFY_POINTS readings, all with published weather, at the bar.
    later, later_known = values[H.VERIFY_POINTS:], [p["weather_known"] for p in after[H.VERIFY_POINTS:]]
    back = any(all(later_known[i:i + H.VERIFY_POINTS]) and median(later[i:i + H.VERIFY_POINTS]) >= bar
               for i in range(len(later) - H.VERIFY_POINTS + 1))
    why = f"The {H.VERIFY_POINTS} readings after {action['approved_on']} were still at {value:.0%} {unit}."
    if back:
        why += " Output was back at that level later."
    return {"outcome": "not_recovered", "why": why + note, "back_later": back, "provisional": bool(unknown)}


def _blocks(action: dict) -> bool:
    """An action of the same kind that is still open stops the same suggestion being made again:
    awaiting approval, being verified, verdict still provisional, or failed without output coming back."""
    v = action["verification"]
    return (v["outcome"] in ("not_approved", "pending") or v["provisional"]
            or (v["outcome"] == "not_recovered" and not v["back_later"]))


def update_actions(site: dict, result: dict) -> None:
    """Propose an action for the top cause if confident enough. Never approves anything."""
    top = result["hypotheses"][0]
    spec = ACTIONS.get(top["cause"])
    if spec is None or not at_least(top["confidence"], H.PROPOSE_MIN_CONFIDENCE):
        return
    if any(a["kind"] == spec["kind"] and _blocks(a) for a in result["actions"]):
        return
    on_date = max(r["date"] for r in site["readings"])
    action_id, n = f"{spec['kind']}-{on_date}", 2
    while action_id in site["actions"]:
        action_id, n = f"{spec['kind']}-{on_date}-{n}", n + 1
    site["actions"][action_id] = {
        "id": action_id, "kind": spec["kind"], "cause": top["cause"], "suggestion": spec["suggestion"],
        "proposed_on": on_date, "status": "proposed", "approved_on": None,
    }


def compute(site: dict) -> dict:
    rows = _rows(site)
    usable = [p for p in rows if p["usable"]]
    segments = _learn(rows, _restarts(site, usable))
    current = segments[-1]
    baseline = current["value"]
    hypotheses = _classify(usable, current)
    actions = []
    for a in sorted(site["actions"].values(), key=lambda a: (a["proposed_on"], a["id"])):
        actions.append({**a, "verification": _verify(a, usable)})
    failed = [a for a in actions
              if a["verification"]["outcome"] == "not_recovered" and not a["verification"]["back_later"]]
    unresolved = [a for a in failed if not a["verification"]["provisional"]]
    waiting = [a for a in failed if a["verification"]["provisional"]]
    for p in rows:
        del p["day"]
    return {
        "site_id": site["id"],
        "synthetic": site["synthetic"],
        "sample": site["sample"],
        "heuristic": H.HEURISTIC_UNVALIDATED,
        "baseline": {
            "learnt": baseline is not None,
            "ratio_to_pvgis": None if baseline is None else round(baseline, 3),
            "points_used": current["points"],
            "relearnt_after": current["since"],
            # Baselines before each re-learn: evidence of how the plant did before a fix.
            "earlier": [{"since": s["since"], "until": s["until"], "points_used": s["points"],
                         "ratio_to_pvgis": None if s["value"] is None else round(s["value"], 3)}
                        for s in segments[:-1]],
        },
        "timeline": rows,
        "hypotheses": hypotheses,
        "actions": actions,
        "escalation": {
            "suggested": bool(unresolved),
            "why": [f"{a['kind']} approved on {a['approved_on']}: {a['verification']['why']}" for a in unresolved],
            "waiting_for_weather": [f"{a['kind']} approved on {a['approved_on']}: {a['verification']['why']}"
                                    for a in waiting],
        },
        "sources": {
            "pvgis": site["pvgis_source"],
            "irradiance_climatology": site["climatology_source"],
            "irradiance_daily": {
                "endpoint": POWER_DAILY_URL, "parameter": POWER_PARAM,
                "note": "Each timeline point carries weather_source: the request URL and retrieval date.",
            },
        },
        "note": "Possible causes with confidence levels, not a diagnosis. Thresholds are unvalidated design parameters.",
    }
