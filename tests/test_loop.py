"""The full owner loop on the synthetic scenario, offline (fixtures, no Gemini key)."""

import base64
import csv
import json
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import audit as audit_module
from app import expected, heuristics
from app.main import app

FIX = Path(__file__).resolve().parent.parent / "fixtures"
FLAGS = ("synthetic", "sample", "heuristic")


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setenv("PVGIS_MODE", "fixture")
    monkeypatch.setenv("IRRADIANCE_MODE", "fixture")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def rows():
    with open(FIX / "synthetic_site.csv", newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def new_site(client, **overrides):
    body = json.loads((FIX / "synthetic_site.json").read_text(encoding="utf-8")) | overrides
    resp = client.post("/api/sites", json=body)
    assert resp.status_code == 200
    return resp.json()


def post_rows(client, site_id, rows):
    audit = None
    for r in rows:
        resp = client.post(f"/api/sites/{site_id}/readings", json=r)
        assert resp.status_code == 200
        audit = resp.json()
    return audit


def action_of(audit, kind):
    return next(a for a in audit["actions"] if a["kind"] == kind)


def test_full_loop(client, rows):
    site = new_site(client)
    sid = site["id"]

    # Detect: dust builds up, soiling ranks first and a cleaning suggestion waits for the owner.
    audit = post_rows(client, sid, rows[:42])
    assert audit["hypotheses"][0]["cause"] == "soiling"
    assert audit["hypotheses"][0]["confidence"] in ("medium", "high")
    clean = action_of(audit, "clean_panels")
    assert clean["status"] == "proposed" and clean["verification"]["outcome"] == "not_approved"

    # Act: the owner approves; verify: output recovers over the next days.
    resp = client.post(f"/api/sites/{sid}/actions/{clean['id']}/approve", json={"approved_on": rows[41]["date"]})
    assert resp.status_code == 200
    assert action_of(resp.json(), "clean_panels")["verification"]["outcome"] == "pending"
    audit = post_rows(client, sid, rows[42:55])
    assert action_of(audit, "clean_panels")["verification"]["outcome"] == "recovered"
    assert [a["kind"] for a in audit["actions"]].count("clean_panels") == 1  # not suggested again right after
    assert audit["hypotheses"][0]["cause"] == "weather_noise"

    # A sudden fault at the end ranks first.
    audit = post_rows(client, sid, rows[55:])
    assert audit["hypotheses"][0]["cause"] == "sudden_fault"
    assert audit["hypotheses"][0]["confidence"] == "high"
    assert [p["date"] for p in audit["timeline"] if p["flagged"]] == [r["date"] for r in rows[55:]]
    assert action_of(audit, "clean_panels")["verification"]["outcome"] == "recovered"  # the verdict stays fixed

    # The owner tries the inverter check, output does not recover, escalation is suggested.
    check = action_of(audit, "check_inverter")
    assert not audit["escalation"]["suggested"]
    resp = client.post(f"/api/sites/{sid}/actions/{check['id']}/approve", json={"approved_on": rows[56]["date"]})
    audit = resp.json()
    assert action_of(audit, "check_inverter")["verification"]["outcome"] == "not_recovered"
    assert audit["escalation"]["suggested"]

    # Escalate: a draft for the owner to file, never sent, nothing invented.
    draft = client.post(f"/api/sites/{sid}/complaint").json()
    assert draft["auto_sent"] is False
    assert draft["sample"] is True
    assert draft["draft_text"].startswith("SYNTHETIC DATA")
    for field in ("serial numbers", "installer company name", "your name"):
        assert f"<<OWNER TO FILL: {field}" in draft["draft_text"]
    assert "Poor equipment" in draft["mnre_categories"]["suggested"]
    assert "not a diagnosis" in draft["draft_text"]
    assert "on 5 of 55 usable readings" in draft["draft_text"]
    assert f"On {rows[56]['date']} I approved the suggestion 'check inverter'" in draft["draft_text"]
    assert "<<OWNER TO FILL: whether and when you carried it out>>" in draft["draft_text"]
    assert "of the weather-adjusted PVGIS estimate" in draft["draft_text"]

    # Learn: the baseline comes from this site's own first readings.
    assert audit["baseline"]["learnt"] and 0.85 < audit["baseline"]["ratio_to_pvgis"] < 0.97


def test_flags_on_every_response(client, rows):
    site = new_site(client)
    sid = site["id"]
    responses = [site, post_rows(client, sid, rows[:3]), client.get(f"/api/sites/{sid}/audit").json(),
                 client.post(f"/api/sites/{sid}/complaint").json()]
    for r in responses:
        assert all(k in r for k in FLAGS)
        assert r["synthetic"] is True and r["heuristic"] is True
    assert site["sample"] is True  # loss not given, SAMPLE default used
    assert new_site(client, loss_pct=14)["sample"] is False


def test_extract_without_key_falls_back_to_manual(client):
    sid = new_site(client)["id"]
    img = base64.b64encode(b"\x89PNG fake").decode()
    resp = client.post(f"/api/sites/{sid}/extract", json={"image_base64": img, "mime_type": "image/png"})
    assert resp.status_code == 503
    assert "by hand" in resp.json()["detail"]
    assert client.get(f"/api/sites/{sid}/audit").json()["timeline"] == []
    bad = client.post(f"/api/sites/{sid}/extract", json={"image_base64": "not base64!", "mime_type": "image/png"})
    assert bad.status_code == 422


def test_unknown_weather_falls_back_to_monthly_average(client):
    sid = new_site(client)["id"]
    audit = client.post(f"/api/sites/{sid}/readings", json={"date": "2026-10-06", "kwh": 10.0}).json()
    point = audit["timeline"][0]
    assert point["weather_known"] is False and point["weather_index"] == 1.0


def test_drop_with_unpublished_weather_still_suggests_a_check(client, rows):
    # NASA POWER publishes days late: the fixture has no weather after 2026-10-03.
    sid = new_site(client)["id"]
    post_rows(client, sid, rows[:55])
    audit = post_rows(client, sid, [{"date": f"2026-10-0{d}", "kwh": "6.6"} for d in (4, 5, 6, 7)])
    top = audit["hypotheses"][0]
    assert top["cause"] == "sudden_fault" and top["confidence"] == "medium"
    noise = next(h for h in audit["hypotheses"] if h["cause"] == "weather_noise")
    assert noise["confidence"] == "medium"
    assert action_of(audit, "check_inverter")["status"] == "proposed"


def test_weather_published_later_refreshes_earlier_readings(client, monkeypatch):
    sid = new_site(client)["id"]
    audit = post_rows(client, sid, [{"date": "2026-10-05", "kwh": "10.0"}])
    assert audit["timeline"][0]["weather_known"] is False

    def published(lat, lon, start, end):
        days = {(start + timedelta(days=i)).isoformat(): 4.7 for i in range((end - start).days + 1)}
        return days, {"url": "test://power", "retrieved": "2026-10-08", "fixture": True}

    monkeypatch.setattr(expected, "power_daily", published)
    audit = post_rows(client, sid, [{"date": "2026-10-06", "kwh": "10.0"}])
    first = audit["timeline"][0]
    assert first["weather_known"] is True and first["weather_index"] == round(4.7 / 4.7002, 3)
    assert first["weather_source"]["url"] == "test://power"


def test_weather_service_down_still_saves_the_reading(client, monkeypatch):
    sid = new_site(client)["id"]

    def down(*args):
        raise expected.UpstreamError("down")

    monkeypatch.setattr(expected, "power_daily", down)
    point = post_rows(client, sid, [{"date": "2026-09-01", "kwh": "10.0"}])["timeline"][0]
    assert point["weather_known"] is False and point["weather_source"] is None


def low(rs):
    """Same synthetic weather, but a plant producing about 70% of the estimate from the start."""
    return [{**r, "kwh": f"{float(r['kwh']) * 0.70 / 0.92:.1f}"} for r in rs]


def low_plant_with_inspection_approved(client, rows):
    sid = new_site(client)["id"]
    audit = post_rows(client, sid, low(rows[:21]))
    top = audit["hypotheses"][0]
    assert top["cause"] == "low_from_day_one" and top["confidence"] == "high"
    assert not any(p["flagged"] for p in audit["timeline"])  # steady, just low
    inspection = action_of(audit, "request_inspection")
    client.post(f"/api/sites/{sid}/actions/{inspection['id']}/approve", json={"approved_on": rows[20]["date"]})
    return sid


def test_low_from_day_one_not_fixed(client, rows):
    sid = low_plant_with_inspection_approved(client, rows)
    # Nothing changes after the inspection: not recovered, and escalation is suggested.
    audit = post_rows(client, sid, low(rows[42:46]))
    verification = action_of(audit, "request_inspection")["verification"]
    assert verification["outcome"] == "not_recovered"
    assert "of the weather-adjusted PVGIS estimate" in verification["why"]
    assert [a["kind"] for a in audit["actions"]] == ["request_inspection"]
    assert audit["escalation"]["suggested"]


def test_low_from_day_one_fixed_relearns_the_baseline(client, rows):
    sid = low_plant_with_inspection_approved(client, rows)
    # The installer fixes it: output comes up to the usual synthetic level.
    audit = post_rows(client, sid, rows[42:55])
    assert action_of(audit, "request_inspection")["verification"]["outcome"] == "recovered"
    assert audit["baseline"]["relearnt_after"] == rows[20]["date"]
    assert 0.85 < audit["baseline"]["ratio_to_pvgis"] < 0.97
    assert audit["hypotheses"][0]["cause"] != "low_from_day_one"
    assert [a["kind"] for a in audit["actions"]] == ["request_inspection"]  # not suggested again
    assert not any(p["flagged"] for p in audit["timeline"])  # old low readings judged against their own level
    earlier = audit["baseline"]["earlier"]
    assert len(earlier) == 1 and earlier[0]["until"] == rows[20]["date"] and earlier[0]["ratio_to_pvgis"] < 0.75
    # A later fault is judged against the new level, so it is caught, and the draft keeps the history.
    audit = post_rows(client, sid, rows[55:])
    assert audit["hypotheses"][0]["cause"] == "sudden_fault"
    draft = client.post(f"/api/sites/{sid}/complaint").json()["draft_text"]
    assert f"Before the inspection approved on {rows[20]['date']}, over its first" in draft
    assert f"usable readings after {rows[20]['date']}, the plant produced" in draft


def test_fix_with_unpublished_weather_is_not_suggested_again(client, rows):
    sid = low_plant_with_inspection_approved(client, rows)
    # Sunny days after the fix, weather not published yet: provisional, and no second inspection.
    audit = post_rows(client, sid, [{"date": f"2026-10-0{d}", "kwh": "11.8"} for d in (4, 5, 6)])
    assert [a["kind"] for a in audit["actions"]] == ["request_inspection"]
    verification = action_of(audit, "request_inspection")["verification"]
    assert verification["outcome"] == "recovered" and verification["provisional"] is True
    assert audit["baseline"]["relearnt_after"] is None  # not re-learnt until the weather confirms it


def test_unpublished_weather_does_not_clear_a_low_plant(client, rows):
    sid = new_site(client)["id"]
    post_rows(client, sid, low(rows[:21]))
    # Clear days with weather not published yet: against the monthly average they look like 85%.
    audit = post_rows(client, sid, [{"date": f"2026-10-0{d}", "kwh": "11.2"} for d in (4, 5, 6)])
    top = audit["hypotheses"][0]
    assert top["cause"] == "low_from_day_one" and top["confidence"] == "medium"
    assert "not available yet" in top["why"][0]
    noise = next(h for h in audit["hypotheses"] if h["cause"] == "weather_noise")
    assert noise["score"] <= top["score"]


def test_verdict_waits_for_published_weather(client, rows, monkeypatch):
    sid = new_site(client)["id"]
    audit = post_rows(client, sid, rows[:57])
    check = action_of(audit, "check_inverter")
    client.post(f"/api/sites/{sid}/actions/{check['id']}/approve", json={"approved_on": "2026-10-03"})
    # Still low afterwards, but POWER has not published those days yet.
    audit = post_rows(client, sid, [{"date": f"2026-10-0{d}", "kwh": "6.6"} for d in (4, 5, 6)])
    verification = action_of(audit, "check_inverter")["verification"]
    assert verification["outcome"] == "not_recovered" and verification["provisional"] is True
    assert "not available yet" in verification["why"]
    assert not audit["escalation"]["suggested"] and audit["escalation"]["waiting_for_weather"]
    draft = client.post(f"/api/sites/{sid}/complaint").json()["draft_text"]
    assert "Weather for 3 of those low readings is not available yet" in draft

    def published(lat, lon, start, end):
        days = {(start + timedelta(days=i)).isoformat(): 4.7 for i in range((end - start).days + 1)}
        return days, {"url": "test://power", "retrieved": "2026-10-08", "fixture": True}

    monkeypatch.setattr(expected, "power_daily", published)
    audit = post_rows(client, sid, [{"date": "2026-10-07", "kwh": "6.6"}])
    verification = action_of(audit, "check_inverter")["verification"]
    assert verification["outcome"] == "not_recovered" and verification["provisional"] is False
    assert audit["escalation"]["suggested"]


def test_complaint_before_baseline_is_learnt(client, rows):
    sid = new_site(client)["id"]
    post_rows(client, sid, rows[:3])
    draft = client.post(f"/api/sites/{sid}/complaint").json()["draft_text"]
    assert "not enough readings yet" in draft
    assert "of the weather-adjusted PVGIS estimate (used because the plant's own usual output was not learnt yet" in draft
    assert "own usual output (after" not in draft
    assert "Subject: <<OWNER TO FILL: subject" in draft  # nothing flagged or listed, so no low-output claim


def test_new_suggestion_never_overwrites_an_old_one():
    old = {"id": "clean_panels-2026-09-08", "kind": "clean_panels", "status": "approved"}
    site = {"readings": [{"date": "2026-09-08"}], "actions": {old["id"]: dict(old)}}
    result = {"hypotheses": [{"cause": "soiling", "confidence": "medium"}], "actions": []}
    audit_module.update_actions(site, result)
    assert set(site["actions"]) == {"clean_panels-2026-09-08", "clean_panels-2026-09-08-2"}
    assert site["actions"][old["id"]] == old


def test_rejects_bad_requests(client, rows):
    sid = new_site(client)["id"]
    assert client.post(f"/api/sites/{sid}/readings", json={"date": "2999-01-01", "kwh": 5}).status_code == 422
    assert client.post(f"/api/sites/{sid}/readings", json={"date": "2026-09-01", "kwh": -1}).status_code == 422
    assert client.post(f"/api/sites/{sid}/readings", json={"date": "2026-09-01", "kwh": 73}).status_code == 422
    infinite = client.post(f"/api/sites/{sid}/readings", content='{"date": "2026-09-01", "kwh": Infinity}',
                           headers={"Content-Type": "application/json"})
    assert infinite.status_code == 422
    gif = client.post(f"/api/sites/{sid}/extract", json={"image_base64": "R0lG", "mime_type": "image/gif"})
    assert gif.status_code == 422
    for route in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(route).status_code == 404
    assert client.get("/api/sites/nope/audit").status_code == 404
    assert client.post(f"/api/sites/{sid}/actions/nope/approve").status_code == 404
    audit = post_rows(client, sid, rows[:42])
    aid = action_of(audit, "clean_panels")["id"]
    for too_early_or_late in ("2026-08-01", "2999-01-01"):
        resp = client.post(f"/api/sites/{sid}/actions/{aid}/approve", json={"approved_on": too_early_or_late})
        assert resp.status_code == 422
    assert client.post(f"/api/sites/{sid}/actions/{aid}/approve").status_code == 200
    assert client.post(f"/api/sites/{sid}/actions/{aid}/approve").status_code == 409


def test_same_date_replaces_reading(client, rows):
    sid = new_site(client)["id"]
    post_rows(client, sid, rows[:2])
    audit = post_rows(client, sid, [{"date": rows[1]["date"], "kwh": "1.0"}])
    assert len(audit["timeline"]) == 2 and audit["timeline"][1]["kwh"] == 1.0


def test_heuristics_marked_unvalidated():
    assert heuristics.HEURISTIC_UNVALIDATED is True


def test_page_is_served_self_contained(client):
    resp = client.get("/")
    assert resp.status_code == 200 and resp.headers["content-type"].startswith("text/html")
    assert "<title>Surya Audit</title>" in resp.text
    assert "<script src" not in resp.text and "<link" not in resp.text  # one dependency-free file
    csp = resp.headers["content-security-policy"]
    assert "default-src 'none'" in csp and "connect-src 'self'" in csp


def test_audit_carries_what_the_page_needs(client, rows):
    site = new_site(client)
    audit = post_rows(client, site["id"], rows[:1])
    assert audit["site"] == {k: site[k] for k in ("lat", "lon", "kw", "tilt", "azimuth", "loss_pct")}
    assert audit["flag_below"] == heuristics.FLAG_BELOW
    assert audit["propose_min_confidence"] == heuristics.PROPOSE_MIN_CONFIDENCE
    assert audit["baseline"]["points_needed"] == heuristics.MIN_CALIBRATION_POINTS
    assert audit["baseline"]["points_max"] == heuristics.CALIBRATION_POINTS


def test_daily_refresh_fills_in_published_weather(client, monkeypatch):
    from app import main, refresh

    monkeypatch.setattr(refresh, "store", main.store)
    sid = new_site(client)["id"]
    post_rows(client, sid, [{"date": "2026-10-05", "kwh": "10.0"}])

    def published(lat, lon, start, end):
        days = {(start + timedelta(days=i)).isoformat(): 4.7 for i in range((end - start).days + 1)}
        return days, {"url": "test://power", "retrieved": "2026-10-09", "fixture": True}

    monkeypatch.setattr(expected, "power_daily", published)
    assert refresh.handler({}, None)["refreshed"] >= 1
    point = client.get(f"/api/sites/{sid}/audit").json()["timeline"][0]
    assert point["weather_known"] is True and point["weather_source"]["retrieved"] == "2026-10-09"
    assert refresh.refresh_site(main.store.get(sid)) is False  # nothing left to refresh


def test_concurrent_save_is_refused_not_lost(client, monkeypatch):
    from app import main
    from app.store import MemoryStore, StoreConflict

    memory = MemoryStore()
    memory.put({"id": "s", "readings": []})
    first, second = memory.get("s"), memory.get("s")
    memory.put(first)
    with pytest.raises(StoreConflict):
        memory.put(second)

    sid = new_site(client)["id"]

    def conflict(site):
        raise StoreConflict(site["id"])

    monkeypatch.setattr(main.store, "put", conflict)
    resp = client.post(f"/api/sites/{sid}/readings", json={"date": "2026-09-01", "kwh": 10})
    assert resp.status_code == 409 and "try again" in resp.json()["detail"]


def test_dynamo_store_round_trip_and_conflict():
    from botocore.exceptions import ClientError

    from app.store import DynamoStore, StoreConflict

    class FakeTable:
        def __init__(self):
            self.items = {}

        def get_item(self, Key, ConsistentRead):
            item = self.items.get(Key["id"])
            return {"Item": dict(item)} if item else {}

        def put_item(self, Item, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues):
            current = self.items.get(Item["id"])
            if current is not None and current["version"] != ExpressionAttributeValues[":v"]:
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
            self.items[Item["id"]] = dict(Item)

        def scan(self, **kwargs):
            return {"Items": [{"id": k} for k in self.items]}

    store = DynamoStore.__new__(DynamoStore)
    store._table = FakeTable()
    site = {"id": "s1", "readings": [{"date": "2026-09-01", "kwh": 9.5}]}
    store.put(site)
    loaded = store.get("s1")
    assert loaded == {**site, "version": 1} and "version" not in json.loads(store._table.items["s1"]["doc"])
    stale = store.get("s1")
    store.put(loaded)
    with pytest.raises(StoreConflict):
        store.put(stale)
    assert store.ids() == ["s1"] and store.get("missing") is None


def test_gemini_key_from_env_or_ssm(monkeypatch):
    import boto3

    from app import config

    calls = []

    class FakeSSM:
        def get_parameter(self, Name, WithDecryption):
            calls.append((Name, WithDecryption))
            return {"Parameter": {"Value": "from-ssm"}}

    monkeypatch.setattr(config, "_cached", None)
    monkeypatch.setattr(boto3, "client", lambda service: FakeSSM())
    assert config.gemini_key() is None  # neither set: manual entry only
    monkeypatch.setenv("GEMINI_KEY_PARAM", "/surya-audit/gemini-api-key")
    assert config.gemini_key() == "from-ssm" and config.gemini_key() == "from-ssm"
    assert calls == [("/surya-audit/gemini-api-key", True)]  # read once, decrypted
    monkeypatch.setenv("GEMINI_API_KEY", "local")
    assert config.gemini_key() == "local"


def test_unreadable_key_parameter_means_typing_by_hand(client, monkeypatch):
    import boto3
    from botocore.exceptions import ClientError

    from app import config

    class MissingSSM:
        def get_parameter(self, Name, WithDecryption):
            raise ClientError({"Error": {"Code": "ParameterNotFound"}}, "GetParameter")

    monkeypatch.setattr(config, "_cached", None)
    monkeypatch.setattr(boto3, "client", lambda service: MissingSSM())
    monkeypatch.setenv("GEMINI_KEY_PARAM", "/surya-audit/gemini-api-key")
    sid = new_site(client)["id"]
    img = base64.b64encode(b"\x89PNG fake").decode()
    resp = client.post(f"/api/sites/{sid}/extract", json={"image_base64": img, "mime_type": "image/png"})
    assert resp.status_code == 503 and "by hand" in resp.json()["detail"]


def test_failed_photo_reading_is_logged_without_photo_text_key_or_image(client, monkeypatch, caplog):
    from google.genai.errors import ClientError
    from pydantic import BaseModel, ValidationError

    from app import extract as extract_module

    fake_key = "AI" + "za" + "x" * 35  # built at runtime so no key-shaped literal sits in the source
    marker = "TRANSCRIBED-SCREEN-TEXT serial SN-0042"

    class Out(BaseModel):
        kwh: float

    try:
        Out(kwh=marker)
    except ValidationError as invalid:
        validation_error = invalid

    api_error = ClientError(400, {"error": {"code": 400, "status": "INVALID_ARGUMENT",
                                            "message": f"API key not valid: {fake_key}"}})
    failures = [validation_error, RuntimeError(marker), api_error]

    def broken(image, mime_type):
        raise failures.pop(0)

    monkeypatch.setattr(extract_module, "extract", broken)
    sid = new_site(client)["id"]
    img = base64.b64encode(b"secret-image-bytes").decode()
    with caplog.at_level("WARNING"):
        for _ in range(3):
            resp = client.post(f"/api/sites/{sid}/extract", json={"image_base64": img, "mime_type": "image/png"})
            assert resp.status_code == 502
    logged = caplog.text
    assert "pydantic_core._pydantic_core.ValidationError fields=[(('kwh',), 'float_parsing')]" in logged
    assert "builtins.RuntimeError" in logged
    assert "code=400 status=INVALID_ARGUMENT" in logged and "<redacted>" in logged
    for secret in (marker, "SN-0042", fake_key, img, "secret-image-bytes"):
        assert secret not in logged
