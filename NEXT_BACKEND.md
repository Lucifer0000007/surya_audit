# Backend changes the page wants but did not make

Routes and response shapes are frozen during the UI phases (5-8), so these wait for a later phase.

- **`WATCH_BELOW` for the Today traffic light** (Phase 7). The light card now has two states the audit already
  decides: "looks fine" (the last reading is not flagged) and "well below usual" (the audit's dip flag), plus
  "still learning" before the baseline exists. A middle "a little low, worth watching" tier was built and then
  removed because it needed a threshold of its own, and every threshold lives in `app/heuristics.py` as
  `HEURISTIC_UNVALIDATED`. To bring the amber tier back: add `WATCH_BELOW` to `heuristics.py`, expose it in the
  audit response as `watch_below` next to `flag_below`, document it in the README table, and the page can show the
  tier from that field alone. The `.light.watch` shape (a half-covered sun) is easy to restore from git history.
