"""Surya Audit API: one site, one loop, the owner decides at every step."""

import base64
import binascii
import logging
import re
import uuid
from datetime import date
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from mangum import Mangum
from pydantic import BaseModel, Field

from app import audit, clock, complaint, expected, extract
from app.store import StoreConflict, make_store

# Only the frozen routes: no /docs, /redoc or /openapi.json.
app = FastAPI(title="Surya Audit", docs_url=None, redoc_url=None, openapi_url=None)
store = make_store()
log = logging.getLogger(__name__)
# Anything shaped like a Google API key is cut out of logged error text.
GOOGLE_KEY = re.compile(r"AIza[0-9A-Za-z_-]{20,}")


def _chain(e: BaseException | None, depth: int = 4):
    """The exception and its causes, at most `depth` deep and never twice (chains can loop)."""
    seen = set()
    while e is not None and id(e) not in seen and len(seen) < depth:
        seen.add(id(e))
        yield e
        e = e.__cause__ or e.__context__


def gemini_busy(e: BaseException) -> bool:
    """Google's "high demand" (503) or rate limit (429): worth telling the owner to retry."""
    from google.genai.errors import APIError

    return any(isinstance(x, APIError) and x.code in (429, 503) for x in _chain(e))


def describe_failure(e: BaseException) -> str:
    """Why photo reading failed, without anything read from the photo: class names along the
    cause chain; for Gemini API errors Google's own code, status and message (redacted, capped);
    for output validation errors only field locations and error types, never the values."""
    from google.genai.errors import APIError
    from pydantic import ValidationError

    parts = []
    for x in _chain(e):
        part = f"{type(x).__module__}.{type(x).__qualname__}"
        if isinstance(x, APIError):
            message = GOOGLE_KEY.sub("<redacted>", str(x.message or ""))[:200]
            part += f" code={x.code} status={x.status} message={message!r}"
        elif isinstance(x, ValidationError):
            fields = [(err["loc"], err["type"])
                      for err in x.errors(include_input=False, include_url=False, include_context=False)]
            part += f" fields={fields[:5]}"
        parts.append(part)
    return " <- ".join(parts)

# Base64 grows an image by a third, and Lambda takes "6 MB each for request and response (synchronous)":
# https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html, retrieved 2026-10-08.
MAX_IMAGE_BYTES = 4 * 1024 * 1024
INDEX_HTML = Path(__file__).resolve().parent / "index.html"
# The page is one self-contained file: everything inline, API calls to this origin only.
PAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                               "img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; "
                               "form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


class SiteIn(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    kw: float = Field(gt=0, le=100, allow_inf_nan=False, description="Plant size in kW (DC peak)")
    tilt: float = Field(ge=0, le=90, allow_inf_nan=False, description="Panel tilt from horizontal, degrees")
    azimuth: float = Field(ge=0, lt=360, allow_inf_nan=False, description="Compass direction the panels face, degrees (180 = south)")
    loss_pct: float | None = Field(None, ge=0, le=50, allow_inf_nan=False, description="Total system loss %, if known")
    synthetic: bool = False


class ReadingIn(BaseModel):
    date: date
    kwh: float = Field(ge=0, allow_inf_nan=False)
    kind: Literal["daily", "weekly"] = "daily"


class ExtractIn(BaseModel):
    image_base64: str
    mime_type: Literal["image/png", "image/jpeg"]


class ApproveIn(BaseModel):
    approved_on: date | None = None


@app.exception_handler(RequestValidationError)
def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Never echo submitted values back: they can be image data, or floats JSON cannot encode.
    detail = [{"loc": e["loc"], "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"detail": detail})


@app.exception_handler(StoreConflict)
def store_conflict(request: Request, exc: StoreConflict) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": "This plant changed while you were saving. Please try again."})


def _site(site_id: str) -> dict:
    site = store.get(site_id)
    if site is None:
        raise HTTPException(404, "site not found")
    return site


def _upstream(e: expected.UpstreamError) -> HTTPException:
    return HTTPException(502, f"expectation source unavailable: {e}")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    return HTMLResponse(INDEX_HTML.read_text(encoding="utf-8"), headers=PAGE_HEADERS)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/sites")
def create_site(body: SiteIn) -> dict:
    loss = expected.SAMPLE_DEFAULT_LOSS_PCT if body.loss_pct is None else body.loss_pct
    try:
        pvgis = expected.pvgis_monthly(body.lat, body.lon, body.kw, body.tilt, body.azimuth, loss)
        clim = expected.power_climatology(body.lat, body.lon)
    except expected.UpstreamError as e:
        raise _upstream(e)
    site = {
        "id": uuid.uuid4().hex,
        **body.model_dump(exclude={"loss_pct"}),
        "loss_pct": loss,
        "sample": body.loss_pct is None,
        "pvgis_e_d": pvgis["e_d"],
        "pvgis_source": pvgis["source"],
        "climatology_ghi": clim["ghi"],
        "climatology_source": clim["source"],
        "readings": [],
        "actions": {},
    }
    store.put(site)
    return {k: site[k] for k in ("id", "lat", "lon", "kw", "tilt", "azimuth", "loss_pct", "synthetic", "sample",
                                 "pvgis_source", "climatology_source")} | {"heuristic": True}


@app.post("/api/sites/{site_id}/extract")
def extract_reading(site_id: str, body: ExtractIn) -> dict:
    site = _site(site_id)
    try:
        image = base64.b64decode(body.image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(422, "image_base64 is not valid base64")
    if not image or len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(413, f"image must be between 1 byte and {MAX_IMAGE_BYTES} bytes")
    try:
        candidate = extract.extract(image, body.mime_type)
    except extract.VisionUnavailable:
        raise HTTPException(503, "Photo reading is not available. Please type the reading by hand.")
    except Exception as e:
        # What failed, so a broken photo path is visible in the logs; never the image, its text or the key.
        log.warning("photo reading failed: %s", describe_failure(e))
        if gemini_busy(e):
            raise HTTPException(503, "Photo reading is busy right now. Try again in a minute, or type the reading by hand.")
        raise HTTPException(502, "Could not read the photo. Please type the reading by hand.")
    return {
        "candidate": candidate.model_dump() if candidate else None,
        "saved": False,
        "confirm_required": True,
        "synthetic": site["synthetic"],
        "sample": site["sample"],
        "heuristic": True,
    }


@app.post("/api/sites/{site_id}/readings")
def add_reading(site_id: str, body: ReadingIn) -> dict:
    site = _site(site_id)
    if body.date > clock.today():
        raise HTTPException(422, "reading date is in the future")
    days = expected.DAYS[body.kind]
    if body.kwh > site["kw"] * 24 * days:
        raise HTTPException(422, f"{body.kwh} kWh is more than a {site['kw']} kW plant can produce in {days} day(s). "
                                 "For a meter's lifetime total, enter the difference between two readings.")
    iso = body.date.isoformat()
    site["readings"] = [r for r in site["readings"] if r["date"] != iso]
    # One weather call covers the new reading and any earlier ones whose weather was not published yet.
    ghi, source = expected.refresh_weather(site, [(body.date, days)])
    site["readings"].append({"date": iso, "kwh": body.kwh, "kind": body.kind,
                             **expected.expected_for_period(site, body.date, days, ghi, source)})
    audit.update_actions(site, audit.compute(site))
    store.put(site)
    return audit.compute(site)


@app.post("/api/sites/{site_id}/actions/{action_id}/approve")
def approve_action(site_id: str, action_id: str, body: ApproveIn | None = None) -> dict:
    site = _site(site_id)
    action = site["actions"].get(action_id)
    if action is None:
        raise HTTPException(404, "action not found")
    if action["status"] != "proposed":
        raise HTTPException(409, f"action is already {action['status']}")
    on = body.approved_on.isoformat() if body and body.approved_on else max(r["date"] for r in site["readings"])
    if not action["proposed_on"] <= on <= clock.today().isoformat():
        raise HTTPException(422, f"approved_on must be between {action['proposed_on']} and today")
    action["status"] = "approved"
    action["approved_on"] = on
    store.put(site)
    return audit.compute(site)


@app.get("/api/sites/{site_id}/audit")
def get_audit(site_id: str) -> dict:
    return audit.compute(_site(site_id))


@app.post("/api/sites/{site_id}/complaint")
def make_complaint(site_id: str) -> dict:
    site = _site(site_id)
    return complaint.draft(site, audit.compute(site))


handler = Mangum(app)
