"""Daily weather refresh, run by EventBridge Scheduler.

NASA POWER publishes daily weather a few days late, so recent readings are judged against the
monthly average and their verdicts are provisional. This fills in the published weather without
waiting for the owner's next reading. It only proposes suggestions (never approves anything)
and logs counts, never site data.
"""

import logging

from app import audit, expected
from app.store import StoreConflict, make_store

log = logging.getLogger()
log.setLevel(logging.INFO)
store = make_store()


def refresh_site(site: dict) -> bool:
    """True if readings with missing weather were refreshed from a successful POWER call."""
    if not any(not r["weather_known"] for r in site["readings"]):
        return False
    _, source = expected.refresh_weather(site)
    if source is None:
        return False
    audit.update_actions(site, audit.compute(site))
    return True


def handler(event: dict, context: object) -> dict:
    refreshed = conflicts = failed = 0
    for site_id in store.ids():
        # Stop with time to spare rather than being cut off in the middle of a write; the rest are picked up by the next run.
        if hasattr(context, "get_remaining_time_in_millis") and context.get_remaining_time_in_millis() < 15_000:
            log.warning("weather refresh: out of time, stopping early")
            break
        try:
            site = store.get(site_id)
            if site is None or not refresh_site(site):
                continue
            store.put(site)
            refreshed += 1
        except StoreConflict:
            conflicts += 1  # the owner saved meanwhile; the next run picks it up
        except Exception as e:  # one bad plant must not stop the others; the class only, never the plant's data
            failed += 1
            log.warning("weather refresh: one site failed (%s)", e.__class__.__name__)
    log.info("weather refresh: %d sites refreshed, %d skipped after a concurrent save, %d failed", refreshed, conflicts, failed)
    return {"refreshed": refreshed, "conflicts": conflicts}
