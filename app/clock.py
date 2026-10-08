"""Dates in India time. Lambda's clock is UTC, so date.today() would be yesterday until 05:30 IST."""

from datetime import date, datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30), "IST")  # India has no daylight saving time


def today() -> date:
    return datetime.now(IST).date()
