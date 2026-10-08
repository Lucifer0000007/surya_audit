"""Draft complaint plus evidence pack, for the owner to check, complete and file themselves.

Never sent anywhere. Personal and installer details are left as <<OWNER TO FILL: ...>>
placeholders; nothing is invented.
"""

from app import heuristics as H
from app.audit import at_least

# SAMPLE: complaint category names. UNVERIFIED: no official source URL and date confirmed
# yet, so every complaint response carries sample=true and tells the owner to check them.
SAMPLE_MNRE_CATEGORIES = {
    "sudden_fault": ["Poor equipment"],
    "soiling": ["Missing maintenance"],
    "low_from_day_one": ["Poor equipment", "Serial-number mismatch"],
}


def _fill(what: str) -> str:
    return f"<<OWNER TO FILL: {what}>>"


def draft(site: dict, audit: dict) -> dict:
    listed = [h for h in audit["hypotheses"]
              if h["cause"] in SAMPLE_MNRE_CATEGORIES and at_least(h["confidence"], H.COMPLAINT_MIN_CONFIDENCE)]
    categories = sorted({c for h in listed for c in SAMPLE_MNRE_CATEGORIES[h["cause"]]})
    usable = [p for p in audit["timeline"] if p["usable"]]
    flagged = [p for p in usable if p["flagged"]]
    baseline = audit["baseline"]
    lines = []
    if audit["synthetic"]:
        lines += ["SYNTHETIC DATA: this draft is built from synthetic readings and is not a real complaint.", ""]
    lines += [
        "DRAFT: review, complete and file this yourself. Nothing has been sent.",
        "",
        "To: " + _fill("installer / vendor name and complaint channel"),
        "Subject: Rooftop solar plant producing below expected output",
        "",
        f"Consumer / application number: {_fill('PM Surya Ghar application or consumer number')}",
        f"Owner: {_fill('your name and phone number')}",
        f"Installer: {_fill('installer company name')}",
        f"Commissioned on: {_fill('commissioning date')}",
        f"Panel and inverter serial numbers: {_fill('serial numbers from the panels and inverter')}",
        f"Plant: {site['kw']} kW, tilt {site['tilt']} deg, azimuth {site['azimuth']} deg, "
        f"at {site['lat']}, {site['lon']}.",
        "",
    ]
    def over(since: str | None, points: int) -> str:
        return f"its first {points} usable readings" if since is None else f"{points} usable readings after {since}"

    for seg in baseline["earlier"]:
        if seg["ratio_to_pvgis"] is not None:
            lines.append(f"Before the inspection approved on {seg['until']}, over {over(seg['since'], seg['points_used'])}, "
                         f"the plant produced {seg['ratio_to_pvgis']:.0%} of the weather-adjusted PVGIS estimate.")
    if baseline["learnt"]:
        lines.append(f"Over {over(baseline['relearnt_after'], baseline['points_used'])}, the plant produced "
                     f"{baseline['ratio_to_pvgis']:.0%} of the weather-adjusted PVGIS estimate.")
    else:
        lines.append("There are not enough readings yet to learn the plant's usual output.")
    # Each reading is compared with the plant's own usual output once that is learnt, else with PVGIS.
    references = {
        "plant_usual": f"more than {1 - H.FLAG_BELOW:.0%} below this plant's own usual output (after weather adjustment)",
        "pvgis_estimate": f"below {H.FLAG_BELOW:.0%} of the weather-adjusted PVGIS estimate (used because the "
                          "plant's own usual output was not learnt yet for these readings, or was zero)",
    }
    for ref, wording in references.items():
        compared = [p for p in usable if p["compared_with"] == ref]
        dips = [p for p in compared if p["flagged"]]
        if compared:
            lines.append(f"Output fell {wording} on {len(dips)} of {len(compared)} usable readings"
                         + (f" (first on {dips[0]['date']}, last on {dips[-1]['date']})." if dips else "."))
    unpublished = sum(not p["weather_known"] for p in flagged)
    if unpublished:
        lines.append(f"Weather for {unpublished} of those low readings is not published yet, so their "
                     "expectation uses the monthly average and may change.")
    if listed:
        lines.append("Possible causes from my audit (confidence levels, not a diagnosis):")
        lines += [f"- {h['cause'].replace('_', ' ')} ({h['confidence']} confidence): {h['why'][0]}" for h in listed]
    for a in audit["actions"]:
        if a["status"] == "approved":
            lines.append(f"On {a['approved_on']} I approved the suggestion '{a['kind'].replace('_', ' ')}'. "
                         f"Carried out: {_fill('whether and when you carried it out')}. "
                         f"Readings afterwards: {a['verification']['why']}")
    lines += [
        "",
        "I request an inspection and a written explanation. The readings and expectation are attached.",
        "",
        f"Signed: {_fill('your name')}   Date: {_fill('date of filing')}",
    ]
    return {
        "site_id": site["id"],
        "synthetic": audit["synthetic"],
        "sample": True,
        "heuristic": audit["heuristic"],
        "draft_text": "\n".join(lines),
        "mnre_categories": {
            "suggested": categories,
            "note": "SAMPLE: category names are unverified. Check the official MNRE procedure before filing.",
        },
        "evidence": {
            "expectation_sources": audit["sources"],
            "baseline": baseline,
            "flagged_readings": flagged,
            "hypotheses": audit["hypotheses"],
            "actions": audit["actions"],
        },
        "auto_sent": False,
    }
