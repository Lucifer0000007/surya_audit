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
    refreshed = conflicts = 0
    for site_id in store.ids():
        site = store.get(site_id)
        if site is None or not refresh_site(site):
            continue
        try:
            store.put(site)
            refreshed += 1
        except StoreConflict:
            conflicts += 1  # the owner saved meanwhile; the next run picks it up
    log.info("weather refresh: %d sites refreshed, %d skipped after a concurrent save", refreshed, conflicts)
    return {"refreshed": refreshed, "conflicts": conflicts}
