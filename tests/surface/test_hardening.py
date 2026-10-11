"""The backend hardening from the 2026-10-11 review: compression, headers, id shape, reading bounds, the refresh that survives a bad plant, key redaction.

Offline (fixture weather, no key, in-memory store). Each test fails if the change it names is taken out.
"""

import gzip
import json
import os
from datetime import timedelta

os.environ["PVGIS_MODE"] = "fixture"
os.environ["IRRADIANCE_MODE"] = "fixture"

from fastapi.testclient import TestClient  # noqa: E402

from app import clock, main, refresh  # noqa: E402

SITE = json.loads(open("fixtures/synthetic_site.json", encoding="utf-8").read())
client = TestClient(main.app)


def new_site() -> str:
    return client.post("/api/sites", json=SITE).json()["id"]


def test_the_page_and_the_audit_are_compressed_when_the_browser_accepts_it():
    page = client.get("/", headers={"Accept-Encoding": "gzip"})
    assert page.headers["content-encoding"] == "gzip" and "accept-encoding" in page.headers["vary"].lower()
    assert "Content-Security-Policy" in page.headers  # the page's own headers survive the middleware
    sid = new_site()
    client.post(f"/api/sites/{sid}/readings", json={"date": (clock.today() - timedelta(days=3)).isoformat(), "kwh": 7.5})
    audit = client.get(f"/api/sites/{sid}/audit", headers={"Accept-Encoding": "gzip"})
    assert audit.headers.get("content-encoding") == "gzip" or len(audit.content) < 1024  # a small answer is sent as it is
    assert client.get("/", headers={"Accept-Encoding": "identity"}).headers.get("content-encoding") is None


def test_headers_on_every_answer_and_no_caching_of_the_api():
    health = client.get("/health")
    assert health.headers["x-content-type-options"] == "nosniff" and "max-age" in health.headers["strict-transport-security"]
    api = client.post("/api/sites", json=SITE)
    assert api.headers["cache-control"] == "no-store"
    assert "geolocation=(self)" in client.get("/").headers["permissions-policy"]


def test_an_id_that_is_not_what_create_site_makes_is_a_404_without_touching_the_store(monkeypatch):
    calls = []
    monkeypatch.setattr(main.store, "get", lambda site_id: calls.append(site_id))
    for bad in ["nope", "A" * 32, "g" * 32, "0" * 31, "0" * 33, "%00", "a" * 3000]:
        assert client.get(f"/api/sites/{bad}/audit").status_code == 404
    assert calls == []


def test_a_reading_older_than_400_days_or_past_the_cap_is_refused_cleanly():
    sid = new_site()
    old = (clock.today() - timedelta(days=main.MAX_READING_AGE_DAYS + 1)).isoformat()
    for date in (old, "0001-01-01"):
        r = client.post(f"/api/sites/{sid}/readings", json={"date": date, "kwh": 5, "kind": "weekly"})
        assert r.status_code == 422 and "days ago" in r.json()["detail"]
    ok = (clock.today() - timedelta(days=main.MAX_READING_AGE_DAYS)).isoformat()
    assert client.post(f"/api/sites/{sid}/readings", json={"date": ok, "kwh": 5}).status_code == 200
    site = main.store.get(sid)
    filler = site["readings"][0]
    site["readings"] = [{**filler, "date": f"2025-01-{i:03d}"} for i in range(main.MAX_READINGS)]
    main.store.put(site)
    r = client.post(f"/api/sites/{sid}/readings", json={"date": clock.today().isoformat(), "kwh": 5})
    assert r.status_code == 422 and "at most" in r.json()["detail"]


def test_the_refresh_goes_on_after_a_plant_that_fails(monkeypatch):
    from app.store import MemoryStore

    mem = MemoryStore()
    good, bad, last = new_site(), new_site(), new_site()
    for sid in (good, bad, last):
        doc = main.store.get(sid)
        doc.pop("version")
        mem.put(doc)
    seen = []

    def flaky(site):
        seen.append(site["id"])
        if site["id"] == bad:
            raise RuntimeError("boom")
        return True

    monkeypatch.setattr(refresh, "store", mem)
    monkeypatch.setattr(refresh, "refresh_site", flaky)
    assert refresh.handler({}, None) == {"refreshed": 2, "conflicts": 0}  # the failing plant does not stop the ones after it
    assert sorted(seen) == sorted([good, bad, last])

    class Late:  # out of time: it stops early instead of being cut off in the middle of a write
        def get_remaining_time_in_millis(self):
            return 1000

    seen.clear()
    assert refresh.handler({}, Late()) == {"refreshed": 0, "conflicts": 0} and seen == []


def test_a_google_key_of_either_shape_is_cut_out_of_logged_error_text():
    for key in ("AIza" + "x" * 35, "AQ." + "Zq7Xk2Lm9Pw4Rt8Yv3Bn6Hc1Dj5Fs0Lm2Nx4Pq6Rs8Tu"[:30]):
        assert main.GOOGLE_KEY.sub("[key]", f"request failed for key={key} status 403") == "request failed for key=[key] status 403"
