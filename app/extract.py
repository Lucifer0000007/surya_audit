"""Read an inverter-app screenshot or meter photo into candidate values. Nothing is saved.

The owner confirms or edits the candidate before it becomes a reading. The image is
never logged or stored. Without GEMINI_API_KEY this raises VisionUnavailable and the
owner types the reading by hand.
"""

import os
from typing import Literal

from pydantic import BaseModel, Field

MODEL_ID = "gemini-3.8-flash"  # https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash, retrieved 2026-10-08
# Strands maps the format to a MIME type via mimetypes.types_map, which lacks .webp on Python 3.12.
FORMATS = {"image/png": "png", "image/jpeg": "jpeg"}

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
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise VisionUnavailable()
    # Imported here so the app boots and tests run without the Gemini client being used.
    from strands import Agent
    from strands.models.gemini import GeminiModel

    model = GeminiModel(client_args={"api_key": key}, model_id=MODEL_ID)
    agent = Agent(model=model, callback_handler=None)
    result = agent(
        [{"text": PROMPT}, {"image": {"format": FORMATS[mime_type], "source": {"bytes": image}}}],
        structured_output_model=Candidate,
    )
    return result.structured_output
