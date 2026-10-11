"""Read an inverter-app screenshot or meter photo into candidate values. Nothing is saved.

The owner confirms or edits the candidate before it becomes a reading. The image is
never logged or stored. Without a Gemini key (see app/config.py) this raises VisionUnavailable and
the owner types the reading by hand.
"""

import asyncio
from typing import Literal

from pydantic import BaseModel, Field

from app.config import gemini_key

# Gemini 3.5 Flash-Lite (stable) at the project owner's request on 2026-10-11, for higher free-tier usage; the model page and the thinking page were read the same day.
MODEL_ID = "gemini-3.5-flash-lite"  # https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite, retrieved 2026-10-11
# Strands maps the format to a MIME type via mimetypes.types_map, which lacks .webp on Python 3.12.
FORMATS = {"image/png": "png", "image/jpeg": "jpeg"}
# Reading a screen needs little reasoning; gemini-3.5-flash-lite accepts thinking levels minimal/low/medium/high (https://ai.google.dev/gemini-api/docs/thinking, retrieved 2026-10-11).
THINKING_LEVEL = "low"
# Fail cleanly (and get logged) well inside the 29 s the deployed function has.
GEMINI_TIMEOUT_MS = 20_000

PROMPT = (
    "This is a photo of a rooftop solar inverter app screen or an electricity meter, sent by the "
    "plant's owner. Report only what is visibly written. Do not guess: use null for anything not "
    "clearly shown. kwh is energy generated over one day (kind=daily) or one week (kind=weekly). "
    "If only a cumulative/lifetime meter total is shown, put it in cumulative_meter_kwh and leave kwh null. "
    "Dates as YYYY-MM-DD."
)


class VisionUnavailable(Exception):
    """No Gemini key configured: manual entry only."""


class Candidate(BaseModel):
    date: str | None = Field(None, description="Date of the reading, YYYY-MM-DD, if shown")
    kwh: float | None = Field(None, description="kWh generated in the period, if shown")
    kind: Literal["daily", "weekly"] | None = Field(None, description="Period the kwh covers")
    cumulative_meter_kwh: float | None = Field(None, description="Lifetime/cumulative total, if that is all that is shown")
    what_was_read: str = Field("", description="One short line naming the screen or meter fields that were read")


def extract(image: bytes, mime_type: str) -> Candidate:
    key = gemini_key()
    if not key:
        raise VisionUnavailable()
    # Imported here so the app boots and tests run without the Gemini client being used.
    from strands.models.gemini import GeminiModel

    # One call to Gemini's native structured output (JSON matching Candidate) through the Strands
    # Gemini provider. An Agent with structured_output_model runs a tool-calling loop that can take
    # several image-carrying turns, which ran past the function's time limit on the first live test.
    model = GeminiModel(
        client_args={"api_key": key, "http_options": {"timeout": GEMINI_TIMEOUT_MS}},
        model_id=MODEL_ID,
        params={"thinking_config": {"thinking_level": THINKING_LEVEL}},
    )
    prompt = [{"role": "user", "content": [
        {"text": PROMPT},
        {"image": {"format": FORMATS[mime_type], "source": {"bytes": image}}},
    ]}]

    async def ask() -> Candidate | None:
        result = None
        async for event in model.structured_output(Candidate, prompt):
            result = event.get("output", result)
        return result

    return asyncio.run(ask())
