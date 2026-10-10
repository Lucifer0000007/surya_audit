"""Checks of what the page says and does, against the user's surface rules and against the code.

The page checks are text lints over `app/index.html`: a rule of the surface upgrade is kept by a test, not by memory. The
coordinate check calls the engine's own fetch functions with the network replaced. They read the page and the engine; they
never change them.
"""

import re
from datetime import date
from pathlib import Path

from app import expected

PAGE = (Path(__file__).resolve().parent.parent / "app" / "index.html").read_text(encoding="utf-8")
STYLE = re.search(r"<style>(.*?)</style>", PAGE, re.S).group(1)
REST = PAGE.replace(STYLE, "")  # the markup and the script


def rules(css):
    """Every innermost `selector { declarations }` block, with comments dropped (the @media wrappers are not rules)."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return [(m.group(1).strip(), m.group(2)) for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css)]


def test_no_text_in_the_page_is_set_under_14px():
    """Minimum text is 0.875rem (14 px). Sizes are in rem or px; anything relative to the parent (em, %) could shrink
    below the floor unseen, so it is refused, except the root size that the "A+" button raises above 100%.

    The lint reads every `font-size` of the stylesheet and of inline `style=""` attributes. It fails closed: every mention
    of `font-size` or `fontSize` anywhere in the page must be one it parsed, so a size written in another form (a keyword,
    calc(), clamp(), var(), a script property such as `style.fontSize` or `setProperty`, an SVG attribute) is refused, and so
    is the `font` shorthand, in the stylesheet and in the script."""
    css = re.sub(r"/\*.*?\*/", "", STYLE, flags=re.S)
    blocks = rules(STYLE) + [("[style]", m) for m in re.findall(r'style="([^"]*)"', REST)]
    seen, too_small = 0, []
    for selector, body in blocks:
        for value, unit in re.findall(r"font-size:\s*([0-9.]+)(rem|px|em|%)", body):
            seen += 1
            if unit == "%" and re.fullmatch(r"(html|:root)(\[[^\]]+\])?", selector) and float(value) >= 100:
                continue
            px = float(value) * 16 if unit == "rem" else float(value) if unit == "px" else None
            if px is None or px < 14:
                too_small.append(f"{selector}: {value}{unit}")
    assert seen > 20, "too few font sizes found: the lint is not looking at the stylesheet"
    assert too_small == []
    mentions = len(re.findall(r"font-?size", css + REST, re.I))
    assert mentions == seen, f"{mentions - seen} mention(s) of font-size are in a form this lint cannot read: use rem or px, in the stylesheet or an inline style attribute"
    shorthand = [v.strip() for v in re.findall(r"(?:^|[;{\s])font\s*:\s*([^;}\"']*)", css + REST)]
    assert [v for v in shorthand if v not in ("inherit", "initial", "unset", "revert")] == [], "the font shorthand sets a size this lint cannot see: use font-family and font-size"
    assert re.findall(r"style\.font\s*=|setProperty\(\s*['\"]font['\"]", REST) == [], "a script sets the font shorthand: use font-size in rem or px"


def test_the_page_uses_the_user_wording_for_co2_and_never_shows_litres():
    """The impact strip says "avoided grid CO2", never "emissions saved" or "CO2 lost", and shows "cleanings avoided", never
    litres of water (no sourced figure exists for them)."""
    lowered = PAGE.lower()
    for banned in ("emissions saved", "co₂ lost", "co2 lost", "lost co", "litre", "liter", "लीटर", "ਲੀਟਰ"):
        assert banned not in lowered, banned
    assert "avoided grid CO₂" in PAGE and "Cleanings avoided" in PAGE


def test_the_plants_coordinates_reach_pvgis_and_nasa_power_exactly_as_stored(monkeypatch):
    """The privacy band says the location goes to NASA POWER, and to PVGIS with the plant's size, tilt, direction and
    loss, "as typed" (rounded to about 1 km only when "Use my location" produced it, in the page). So the server must pass
    the stored coordinates on unchanged, and nothing but those parameters may be sent."""
    monkeypatch.delenv("PVGIS_MODE", raising=False)
    monkeypatch.delenv("IRRADIANCE_MODE", raising=False)
    calls = []

    def fake_get_json(url, params):
        calls.append((url, dict(params)))
        if url == expected.PVGIS_URL:
            data = {"outputs": {"monthly": {"fixed": [{"month": m, "E_d": 5.0} for m in range(1, 13)]}}}
        elif url == expected.POWER_CLIMATOLOGY_URL:
            data = {"properties": {"parameter": {expected.POWER_PARAM: {m: 5.0 for m in expected.MONTHS}}}}
        else:
            data = {"properties": {"parameter": {expected.POWER_PARAM: {"20261001": 5.0, "20261002": 5.0}}}}
        return data, {"url": url, "retrieved": "2026-10-10", "fixture": False}

    monkeypatch.setattr(expected, "_get_json", fake_get_json)
    lat, lon = 26.84671, 80.94623  # as typed, with more than two decimals
    expected.pvgis_monthly(lat, lon, 3.0, 27.0, 180.0, 14.0)
    expected.power_climatology(lat, lon)
    expected.power_daily(lat, lon, date(2026, 10, 1), date(2026, 10, 2))

    sent = dict(calls)
    assert set(sent) == {expected.PVGIS_URL, expected.POWER_CLIMATOLOGY_URL, expected.POWER_DAILY_URL}
    pvgis = sent[expected.PVGIS_URL]
    assert (pvgis["lat"], pvgis["lon"]) == (lat, lon)
    assert set(pvgis) == {"lat", "lon", "peakpower", "loss", "angle", "aspect", "outputformat"}
    for url in (expected.POWER_CLIMATOLOGY_URL, expected.POWER_DAILY_URL):
        power = sent[url]
        assert (power["latitude"], power["longitude"]) == (lat, lon)
        assert set(power) <= {"parameters", "community", "longitude", "latitude", "start", "end", "format"}


# What the page must never say. Detection of shading, an inverter integration and complaint categories that match a real
# portal are all things the product does not have (the audit only lists shading as one possible cause of a low start;
# readings come from a photo or by hand; the complaint categories are SAMPLE names, unverified).
CLAIMS_NOT_MADE = {
    "shading is detected": r"shading\s+(is|was|can be|gets)\s+(detected|found|identified)|detects?\s+(the\s+)?shading|shading\s+detection",
    "an inverter is integrated": r"integrat\w*[^.\n]{0,30}inverter|inverter[^.\n]{0,30}integrat|connects?\s+to\s+(your\s+|the\s+)?inverter|inverter\s+(api|sync)",
    "complaint categories match a real portal": r"portal\s+categor|(match(es|ing)?|same\s+as)[^.\n]{0,30}portal|official\s+(mnre\s+)?categor",
}


def test_the_page_never_claims_shading_detection_inverter_integration_or_portal_categories():
    found = {claim: re.findall(pattern, PAGE, flags=re.I) for claim, pattern in CLAIMS_NOT_MADE.items()}
    assert {claim: hits for claim, hits in found.items() if hits} == {}


def test_the_complaint_categories_stay_labelled_sample_in_the_page():
    # The categories are the server's SAMPLE names; the page must keep telling the owner to check the procedure itself.
    assert "SAMPLE: category names are unverified" in PAGE


ROOT = Path(__file__).resolve().parent.parent
EN_TABLE = re.search(r"\n  en: \{\n(.*?)\n  \},?\n", PAGE, re.S).group(1)


def english(key):
    """The English text of a translation key (the markup is empty: the script writes it from this table)."""
    return re.search(r"(?<![A-Za-z])" + key + r": '((?:[^'\\]|\\.)*)'", EN_TABLE).group(1)


def test_how_it_runs_names_only_what_the_infrastructure_code_defines():
    """"Built on AWS" and "How it runs" list services; each must have its resource or permission in template.yaml or the
    permissions boundary, the schedule must be the one the template sets, and no service the project does not use may
    appear in those lines."""
    template = (ROOT / "template.yaml").read_text(encoding="utf-8")
    boundary = (ROOT / "infra" / "boundary-policy.json").read_text(encoding="utf-8")
    line = english("awsLine")
    in_template = {
        "Lambda": "AWS::Serverless::Function",
        "API Gateway": "Type: HttpApi",
        "DynamoDB": "AWS::DynamoDB::Table",
        "EventBridge Scheduler": "ScheduleV2",
        "Parameter Store": "ssm:GetParameter",
    }
    assert [name for name in in_template if name in line] == list(in_template)  # all five, and the line names no other
    for name, token in in_template.items():
        assert token in template, (name, token)
    # the schedule the page states, "daily at 09:00 India time", is the one the template sets
    assert "cron(0 9 * * ? *)" in template and "ScheduleExpressionTimezone: Asia/Kolkata" in template
    assert english("run3").startswith("Daily at 09:00 India time")
    # one IAM role per function, limited by the permissions boundary to the table, the logs and the key parameter
    assert "PermissionsBoundary" in template
    assert all(action in boundary for action in ("dynamodb:PutItem", "logs:PutLogEvents", "ssm:GetParameter"))
    # no other service is named in these lines
    lines = " ".join(english(key) for key in ["awsLine", *[f"run{n}" for n in range(1, 7)]])
    for other in ("S3", "SQS", "SNS", "SES", "Bedrock", "CloudFront", "Cognito", "Kinesis", "Fargate", "EC2", "RDS", "Amplify", "AppSync", "Step Functions"):
        assert not re.search(r"\b" + re.escape(other) + r"\b", lines), other
