# Backend changes the page wants but did not make

Routes and response shapes are frozen during the UI phases (5-8), so these wait for a later phase.

- **`WATCH_BELOW` for the Today traffic light** (Phase 7). The light card's states all come from the audit's own
  verdict: "well below usual" (the dip flag), "near usual, but the audit points to a possible cause" (the top
  cause at the audit's suggestion level with nothing flagged), "looks fine" (neither), plus "still learning"
  before the baseline exists and "a very dim day" for a last reading that was not judged. A middle "a little low, worth watching" tier was built and then
  removed because it needed a threshold of its own, and every threshold lives in `app/heuristics.py` as
  `HEURISTIC_UNVALIDATED`. To bring the amber tier back: add `WATCH_BELOW` to `heuristics.py`, expose it in the
  audit response as `watch_below` next to `flag_below`, document it in the README table, and the page can show the
  tier from that field alone, with a shape of its own (the half-covered sun now marks "near usual, but the audit
  points to a possible cause").
