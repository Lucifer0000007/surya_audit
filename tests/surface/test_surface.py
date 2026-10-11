"""Checks of what the page says and does, against the user's surface rules and against the code.

The page checks are text lints over `app/index.html`: a rule of the surface upgrade is kept by a test, not by memory. The
coordinate check calls the engine's own fetch functions with the network replaced. They read the page and the engine; they
never change them.
"""

import re
from datetime import date
from pathlib import Path

from app import expected

PAGE = (Path(__file__).resolve().parent.parent.parent / "app" / "index.html").read_text(encoding="utf-8")
STYLE = re.search(r"<style>(.*?)</style>", PAGE, re.S).group(1)
REST = PAGE.replace(STYLE, "")  # the markup and the script


def rules(css):
    """Every innermost `selector { declarations }` block, with comments dropped (the @media wrappers are not rules)."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    return [(m.group(1).strip(), m.group(2)) for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css)]


def test_no_text_in_the_page_is_set_under_14px():
    """Minimum text is 0.875rem (14 px); Latin metadata set in the mono face (dates, source stamps, tags) may be 0.8125rem. Sizes are in rem or px; anything relative to the parent (em, %) could shrink
    below the floor unseen, so it is refused, except the root size that the "A+" button raises above 100%.

    The lint reads every `font-size` of the stylesheet and of inline `style=""` attributes. It fails closed: every mention
    of `font-size` or `fontSize` anywhere in the page must be one it parsed, so a size written in another form (a keyword,
    calc(), var(), a script property such as `style.fontSize` or `setProperty`, an SVG attribute) is refused, and so
    is the `font` shorthand, in the stylesheet and in the script."""
    css = re.sub(r"/\*.*?\*/", "", STYLE, flags=re.S)
    blocks = rules(STYLE) + [("[style]", m) for m in re.findall(r'style="([^"]*)"', REST)]
    seen, too_small = 0, []
    for selector, body in blocks:
        # clamp(min, preferred, max) is read by its minimum: that is the smallest size it can ever give
        for value, unit in re.findall(r"font-size:\s*(?:clamp\(\s*)?([0-9.]+)(rem|px|em|%)", body):
            seen += 1
            if unit == "%" and re.fullmatch(r"(html|:root)(\[[^\]]+\])?", selector) and float(value) >= 100:
                continue
            px = float(value) * 16 if unit == "rem" else float(value) if unit == "px" else None
            floor = 13 if re.search(r"font-family:[^;]*(--mono|monospace)", body) else 14  # the one exception: Latin metadata in the mono face
            if px is None or px < floor:
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
    "shading is detected": r"shad(e|ing)\s+(is\s+|was\s+|can be\s+|gets\s+)?(detect|found|identif|spott|analys)|(detects?|spots?|identifies|finds|analyses)\s+(the\s+|any\s+)?shad(e|ing)|shad(e|ing)\s+(detection|analysis)"
    r"|(छाया|छाँव)[^।.\n]{0,40}(पता लग|पहचान|पकड़|डिटेक्ट)|(पता लग|पहचान|पकड़|डिटेक्ट)[^।.\n]{0,40}(छाया|छाँव)"
    r"|(ਛਾਂ|ਛਾਇਆ)[^।.\n]{0,40}(ਪਤਾ ਲੱਗ|ਪਛਾਣ|ਫੜ|ਡਿਟੈਕਟ)|(ਪਤਾ ਲੱਗ|ਪਛਾਣ|ਫੜ|ਡਿਟੈਕਟ)[^।.\n]{0,40}(ਛਾਂ|ਛਾਇਆ)",
    "an inverter is integrated": r"integrat\w*[^.\n]{0,30}inverter|inverter[^.\n]{0,30}integrat|connects?\s+to\s+(your\s+|the\s+)?inverter|linked\s+to\s+(your\s+|the\s+)?inverter|inverter\s+(api|sync|data\s+(is|are)\s+(read|pulled|fetched))|reads?\s+(your\s+|the\s+)?inverter\s+(data\s+)?automatically|works\s+with\s+(your\s+)?\w+\s+inverters"
    r"|इन्वर्टर[^।.\n]{0,40}(इंटीग्रेट|इंटीग्रेशन|से जुड़|कनेक्ट)|(इंटीग्रेट|इंटीग्रेशन)[^।.\n]{0,40}इन्वर्टर"
    r"|ਇਨਵਰਟਰ[^।.\n]{0,40}(ਇੰਟੀਗ੍ਰੇਟ|ਇੰਟੀਗ੍ਰੇਸ਼ਨ|ਨਾਲ ਜੁੜ|ਕਨੈਕਟ)|(ਇੰਟੀਗ੍ਰੇਟ|ਇੰਟੀਗ੍ਰੇਸ਼ਨ)[^।.\n]{0,40}ਇਨਵਰਟਰ",
    "complaint categories match a real portal": r"portal\s+categor|categories\s+(of|on|from|in)\s+the\s+(mnre\s+)?portal|(match(es|ing)?|same\s+as)[^.\n]{0,30}portal|official\s+(mnre\s+)?categor"
    r"|पोर्टल[^।.\n]{0,40}(श्रेणी|मेल खा|समान)|(श्रेणी|श्रेणियाँ)[^।.\n]{0,40}पोर्टल"
    r"|ਪੋਰਟਲ[^।.\n]{0,40}(ਸ਼੍ਰੇਣੀ|ਮੇਲ ਖਾ|ਇੱਕੋ ਜਿਹ)|(ਸ਼੍ਰੇਣੀ|ਸ਼੍ਰੇਣੀਆਂ)[^।.\n]{0,40}ਪੋਰਟਲ",
}


def test_the_page_never_claims_shading_detection_inverter_integration_or_portal_categories():
    found = {claim: re.findall(pattern, PAGE, flags=re.I) for claim, pattern in CLAIMS_NOT_MADE.items()}
    assert {claim: hits for claim, hits in found.items() if hits} == {}


def test_the_complaint_categories_stay_labelled_sample_in_the_page():
    # The categories are the server's SAMPLE names; the page must keep telling the owner to check the procedure itself.
    assert "SAMPLE: category names are unverified" in PAGE


ROOT = Path(__file__).resolve().parent.parent.parent
STR = r"""('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|null)"""


def cells(key):
    """The three strings of a translation key, [English, Hindi, Punjabi] (None where the page has none)."""
    m = re.search(r"^  " + key + r": \[" + STR + ", " + STR + ", " + STR + r"\],$", PAGE, re.M)
    return [None if c == "null" else c[1:-1] for c in m.groups()]


def english(key):
    """The English text of a translation key (the markup is empty: the script writes it from the table)."""
    return cells(key)[0]


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
    for other in ("S3", "SQS", "SNS", "SES", "Bedrock", "CloudFront", "Cognito", "Kinesis", "Fargate", "EC2", "RDS", "Amplify", "AppSync", "Step Functions",
                  "Secrets Manager", "KMS", "X-Ray", "Route 53", "ECS", "Textract", "Rekognition", "SageMaker", "WAF", "Glue", "Athena"):
        assert not re.search(r"\b" + re.escape(other) + r"\b", lines), other


def test_the_claims_lint_catches_the_phrasings_it_exists_for():
    """The patterns are only worth something if they fire on real sentences, in all three languages."""
    sentences = {
        "shading is detected": ["Shading detected on your roof.", "It detects shade in the afternoon.", "छाया का पता लगाया जाता है", "ਛਾਂ ਦਾ ਪਤਾ ਲੱਗ ਜਾਂਦਾ ਹੈ"],
        "an inverter is integrated": ["Linked to your inverter.", "Reads your inverter data automatically.", "Works with Growatt inverters.", "इन्वर्टर से जुड़ा है", "ਇਨਵਰਟਰ ਨਾਲ ਜੁੜਿਆ ਹੈ"],
        "complaint categories match a real portal": ["These are the categories of the MNRE portal.", "पोर्टल की श्रेणी से मेल खाती हैं", "ਪੋਰਟਲ ਦੀ ਸ਼੍ਰੇਣੀ ਨਾਲ ਮੇਲ ਖਾਂਦੀ ਹੈ"],
    }
    for claim, texts in sentences.items():
        for sentence in texts:
            assert re.search(CLAIMS_NOT_MADE[claim], sentence, flags=re.I), (claim, sentence)


def test_the_stored_coordinates_are_what_the_create_route_and_the_daily_refresh_send(monkeypatch):
    """The same claim, through the paths that use it: POST /api/sites and the daily refresh of a plant with a stale reading."""
    import json

    from fastapi.testclient import TestClient

    from app.main import app

    client = TestClient(app)
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
            data = {"properties": {"parameter": {expected.POWER_PARAM: {}}}}
        return data, {"url": url, "retrieved": "2026-10-10", "fixture": False}

    monkeypatch.setattr(expected, "_get_json", fake_get_json)
    lat, lon = 26.84671, 80.94623
    body = json.loads((ROOT / "fixtures" / "synthetic_site.json").read_text(encoding="utf-8")) | {"lat": lat, "lon": lon}
    created = client.post("/api/sites", json=body)
    assert created.status_code == 200, created.text
    site = created.json()
    assert {(p.get("lat", p.get("latitude")), p.get("lon", p.get("longitude"))) for _, p in calls} == {(lat, lon)}
    posted = client.post(f"/api/sites/{site['id']}/readings", json={"date": "2026-10-01", "kwh": 5.0, "kind": "daily"})
    assert posted.status_code == 200, posted.text
    assert {(p.get("latitude"), p.get("longitude")) for u, p in calls if u == expected.POWER_DAILY_URL} == {(lat, lon)}
    calls.clear()
    from app import main

    expected.refresh_weather(main.store.get(site["id"]))  # what the daily refresh calls for a plant with a reading still waiting for weather
    assert calls and {(p.get("latitude"), p.get("longitude")) for _, p in calls} == {(lat, lon)}


def test_how_it_runs_says_the_same_in_hindi_and_punjabi():
    """The translated lines carry the same hour and no Latin word except the service and source names."""
    names = {"Lambda", "FastAPI", "API", "Gateway", "HTTP", "DynamoDB", "EventBridge", "Scheduler", "Parameter", "Store", "SecureString",
             "IAM", "CloudWatch", "Logs", "Gemini", "Google", "NASA", "POWER", "PVGIS", "AWS", "Region"}
    for index, lang in ((1, "hi"), (2, "pa")):
        assert "09:00" in cells("run3")[index], lang
        for key in ["awsLine", *[f"run{n}" for n in range(1, 7)]]:
            extra = set(re.findall(r"[A-Za-z]{2,}", cells(key)[index])) - names
            assert not extra, (lang, key, extra)


# ---- the design rules of the surface upgrade, as lints over the stylesheet
SPACING_SCALE = {0, 4, 6, 8, 12, 16, 20, 24, 32, 40, 44, 48, 64, 80}
SPACING_PROPS = r"(?<![-\w])(padding(?:-[a-z]+)*|margin(?:-[a-z]+)*|gap|row-gap|column-gap)\s*:\s*([^;]+)"


def test_spacing_is_on_the_scale_radii_are_two_and_there_are_no_shadows_or_amber_text():
    """Spacing only 4, 6, 8, 12, 16, 20, 24, 32, 40, 44, 48, 64 and 80 px; radii 6 px or a pill (a circle for dots); hairlines and a ring token, not
    shadows; amber for backgrounds, borders and strokes, never as the colour of text. The visually hidden helper is exempt from the
    spacing rule: its -1px margin is the standard clip."""
    off_scale, radii, shadows, amber_text = [], set(), [], []
    for selector, body in rules(STYLE):
        if selector != ".sr-only":
            for prop, value in re.findall(SPACING_PROPS, body):
                off_scale += [f"{selector}: {prop} {n}px" for n in re.findall(r"-?[0-9.]+(?=px)", value) if abs(float(n)) not in SPACING_SCALE]
        radii |= {v.strip() for v in re.findall(r"border-radius\s*:\s*([^;]+)", body)}
        shadows += [f"{selector}: {v.strip()}" for v in re.findall(r"box-shadow\s*:\s*([^;]+)", body)]
        amber_text += [f"{selector}: {v}" for v in re.findall(r"(?<![-\w])color\s*:\s*((?:var\(--accent\)|#eda100|color-mix\([^;]*--accent)[^;]*)", body)]
    assert off_scale == []
    assert radii <= {"var(--r)", "var(--pill)", "50%", "0", "0 var(--r) var(--r) 0"}, radii
    # No drop shadows: the only box-shadow is the hairline ring token (0 0 0 1px at 8-14% plus a 2px gap in the canvas colour), or none; on the dark band a plain 1px ring in its own control colour (the canvas halo would show white).
    ring_only = [x for x in shadows if x.split(": ", 1)[1] not in ("var(--ring)", "var(--verdict-ring)", "none")]
    assert ring_only == [] and amber_text == []
    for token in re.findall(r"--(?:ring|verdict-ring):\s*([^;]+);", STYLE):
        assert re.fullmatch(r"(?:none|0 0 0 1px var\(--dk-control\)|0 0 0 1px rgba\([0-9, .]+\)(?:, 0 0 0 2px var\(--(?:canvas|verdict-bg)\))?)", token.strip()), token


def test_the_mono_face_is_for_latin_metadata_and_is_switched_off_in_hindi_and_punjabi():
    """Every selector that sets the mono face (except the root token, the English-only draft box and the import box) is reset to the
    page face under :lang(hi) and :lang(pa)."""
    mono = [sel for sel, body in rules(STYLE) if re.search(r"font-family:[^;]*--mono", body) and sel not in (":root", "textarea")]
    assert mono, "no mono rule found: the lint is not looking at the stylesheet"
    reset = {part.strip() for sel, body in rules(STYLE) if ":lang(hi)" in sel and "font-family: inherit" in body
             for part in re.sub(r":lang\((?:hi|pa)\)|:is\(|\)", " ", sel).split(",")}
    for group in mono:
        for part in (s.strip() for s in group.split(",")):
            assert part in reset, f"{part} keeps the mono face in Hindi and Punjabi"


def test_the_only_dev_dependencies_are_playwright_and_axe_core_with_exact_versions():
    """The user approved axe-core (exact version, at least 14 days old) as a dev-only dependency; nothing else may slip in."""
    import json

    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert "dependencies" not in package
    dev = package["devDependencies"]
    assert set(dev) == {"@playwright/test", "axe-core"}
    assert all(re.fullmatch(r"\d+\.\d+\.\d+", version) for version in dev.values()), dev  # pinned: no caret, tilde or range
