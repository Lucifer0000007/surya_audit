"""Synthetic backtest of the audit engine. Implements docs/backtest.md (generator spec v1) exactly.

Run from the repo root with the project's venv:  .venv/Scripts/python.exe scripts/backtest.py
Standard library only. The engine is imported read-only; nothing is written under app/.
Options: --check   generate every plant and check the generator against the spec's own bounds and that the
                   engine accepts a site document; prints no engine result
         --offset N  add N to every seed (the spec's v2 rule uses 10000); default 0 = v1

Synthetic data. Validates the logic, not real-world accuracy. Thresholds unvalidated.
"""

import argparse
import copy
import hashlib
import math
import random
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from app import audit, expected  # noqa: E402  (read-only use of the engine)

LABEL = "Synthetic data. Validates the logic, not real-world accuracy. Thresholds unvalidated."

# ---- Spec section 2.2 table (SAMPLE): H clear-sky POA hours, kmean ----
H_TAB = [5.5, 6.3, 7.0, 7.4, 7.5, 7.2, 6.6, 6.5, 6.6, 6.4, 5.7, 5.2]
K_MEAN = [0.72, 0.80, 0.85, 0.85, 0.82, 0.68, 0.50, 0.52, 0.65, 0.82, 0.82, 0.70]
MU_D = [round(1 - k, 2) for k in K_MEAN]
PR_NOMINAL = 0.78
LAT, LON = 26.85, 80.95
YEAR0 = date(2025, 1, 1)

# class key -> (label, seed base, engine cause name or None)
CLASSES = {
    "a": ("no_issue", 1000),
    "b": ("soiling", 2000),
    "c": ("sudden_fault", 3000),
    "d": ("low_from_start", 4000),
    "e1": ("weather_or_noise", 5000),
    "e2": ("weather_or_noise", 6000),
}
N_PER_CLASS = 60
# spec label -> engine cause name (the engine's CAUSES tuple uses these names)
ENGINE_NAME = {"soiling": "soiling", "sudden_fault": "sudden_fault",
               "low_from_start": "low_from_day_one", "weather_or_noise": "weather_noise"}
SPEC_NAME = {v: k for k, v in ENGINE_NAME.items()}
HARDWARE = ("soiling", "sudden_fault", "low_from_start")


def _mid(year: int, month: int) -> date:
    return date(year, month, 15)


def interp(table: list[float], d: date) -> float:
    """Linear interpolation of a 12-month table between mid-month points (day 15), cyclic."""
    this = _mid(d.year, d.month)
    if d >= this:
        nm_y, nm = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
        a, b = table[d.month - 1], table[nm - 1]
        lo, hi = this, _mid(nm_y, nm)
    else:
        pm_y, pm = (d.year - 1, 12) if d.month == 1 else (d.year, d.month - 1)
        a, b = table[pm - 1], table[d.month - 1]
        lo, hi = _mid(pm_y, pm), this
    return a + (b - a) * (d - lo).days / (hi - lo).days


def clip(x, lo, hi):
    return max(lo, min(hi, x))


# ---------------------------------------------------------------- generator (spec sections 2 and 3)
def generate(cls: str, seed: int) -> dict:
    label = CLASSES[cls][0]
    rng = random.Random(seed)
    # (1)-(5) plant-level draws
    kw = rng.choice([2, 3, 4, 5, 6, 8, 10])
    tilt = rng.uniform(15, 30)
    azimuth = rng.uniform(165, 195)
    pr_norm = clip(rng.gauss(0.78, 0.035), 0.70, 0.86)
    n = rng.randint(45, 90)
    # (6) start date (day index from 2025-01-01)
    if cls == "b":
        # whole window in the dry season: start >= 15 Oct 2025, last reading <= 20 Jun 2026
        first = (date(2025, 10, 15) - YEAR0).days
        last_start = (date(2026, 6, 20) - YEAR0).days - (n - 1)
        start = YEAR0 + timedelta(days=rng.randint(first, last_start))
    else:
        start = YEAR0 + timedelta(days=rng.randint(0, 364))
    dates = [start + timedelta(days=i) for i in range(n)]
    # (7) scenario-specific parameters
    truth: dict = {}
    pr_i = pr_norm
    soil_r = soil_t0 = fault_f = fault_tf = fault_u = low_L = spell_len = spell_s = None
    end_anchored = None
    if cls == "b":
        while True:
            soil_r = rng.uniform(0.0015, 0.0060)
            soil_t0 = rng.randint(0, math.floor(0.4 * n))
            end_loss = min(0.40, soil_r * (n - 1 - soil_t0 + 1))
            if 0.08 <= end_loss <= 0.35:
                break
    elif cls == "c":
        fault_f = rng.uniform(0.12, 0.70)
        fault_tf = rng.randint(20, n - 7)
        fault_u = rng.uniform(0.5, 1.0)
    elif cls == "d":
        low_L = rng.uniform(0.12, 0.35)
        pr_i = pr_norm * (1 - low_L)
    elif cls == "e1":
        spell_len = rng.randint(5, 14)
        end_anchored = rng.random() < 0.5
        spell_s = n - spell_len if end_anchored else rng.randint(10, n - spell_len - 5)
    # (8) measurement noise level
    sigma = rng.uniform(0.06, 0.12) if cls == "e2" else rng.uniform(0.01, 0.03)
    # (9) latent weather: z[0] then g[t]
    z = [rng.gauss(0, 1)]
    for _ in range(1, n):
        z.append(0.5 * z[-1] + math.sqrt(1 - 0.5 ** 2) * rng.gauss(0, 1))
    k = []
    for t, d in enumerate(dates):
        mu = interp(MU_D, d)
        sd = min(0.28, 0.08 + 0.4 * mu)
        k.append(1 - clip(mu + sd * z[t], 0.0, 0.92))
    # (10) spell values
    if cls == "e1":
        for t in range(spell_s, spell_s + spell_len):
            k[t] = rng.uniform(0.12, 0.45)
    # (11) weather record error
    k_obs = [clip(k[t] * (1 + rng.gauss(0, 0.06)), 0.05, 1.0) for t in range(n)]
    # (12) measurement noise and outliers; energy
    kwh, soil, fault = [], [], []
    for t, d in enumerate(dates):
        e = rng.gauss(0, sigma)
        if cls == "e2" and rng.random() < 0.05:
            e = (1 + e) * (rng.uniform(0.50, 0.75) if rng.random() < 0.5 else rng.uniform(1.25, 1.50)) - 1
        s = 0.0 if soil_t0 is None or t < soil_t0 else min(0.40, soil_r * (t - soil_t0 + 1))
        if fault_tf is None or t < fault_tf:
            f = 0.0
        elif t == fault_tf:
            f = fault_f * fault_u
        else:
            f = fault_f
        orient = 1 - 0.00025 * (tilt - 26) ** 2 - 0.00006 * (azimuth - 180) ** 2
        energy = kw * orient * interp(H_TAB, d) * pr_i * k[t] * (1 - s) * (1 - f) * (1 + e)
        kwh.append(max(0.0, round(energy, 1)))
        soil.append(s)
        fault.append(f)
    return {
        "cls": cls, "label": label, "seed": seed,
        "plant": {"lat": LAT, "lon": LON, "kw": kw, "tilt": tilt, "azimuth": azimuth},
        "dates": dates, "kwh": kwh, "k_obs": k_obs,
        "truth": {"pr_norm": pr_norm, "pr_i": pr_i, "n": n, "sigma": sigma, "soil_r": soil_r, "soil_t0": soil_t0,
                  "fault_f": fault_f, "fault_tf": fault_tf, "low_L": low_L, "spell_len": spell_len,
                  "spell_s": spell_s, "end_anchored": end_anchored, "k": k, "S": soil, "F": fault},
    }


# ---------------------------------------------------------------- engine inputs (Harness decisions 3)
def build_site(p: dict) -> dict:
    """The site document the API would hold after one POST /api/sites and one POST /readings per day,
    with the weather feed built from the generator's observed index instead of NASA POWER."""
    pl = p["plant"]
    orient = 1 - 0.00025 * (pl["tilt"] - 26) ** 2 - 0.00006 * (pl["azimuth"] - 180) ** 2
    # PVGIS stand-in: mean daily kWh of a nominal-PR plant under the month's climatological weather
    e_d = {str(m + 1): pl["kw"] * orient * H_TAB[m] * PR_NOMINAL * K_MEAN[m] for m in range(12)}
    # POWER climatology stand-in: month's mean irradiance of the same table (H * kmean), kWh/m2/day
    clim = {str(m + 1): H_TAB[m] * K_MEAN[m] for m in range(12)}
    src = {"url": "synthetic backtest generator (docs/backtest.md)", "retrieved": "n/a", "fixture": True}
    site = {"id": f"bt-{p['cls']}-{p['seed']}", **pl, "loss_pct": 14.0, "synthetic": True, "sample": True,
            "pvgis_e_d": e_d, "pvgis_source": src, "climatology_ghi": clim, "climatology_source": src,
            "readings": [], "actions": {}}
    # observed daily irradiance in POWER units: k_obs * H(date), the spec's stated conversion
    ghi = {d.isoformat(): p["k_obs"][i] * interp(H_TAB, d) for i, d in enumerate(p["dates"])}
    for i, d in enumerate(p["dates"]):
        site["readings"].append({"date": d.isoformat(), "kwh": p["kwh"][i], "kind": "daily",
                                 **expected.expected_for_period(site, d, 1, ghi, src)})
    return site


def run_engine(p: dict) -> dict:
    """Final audit after the last reading; suggestion-level = the engine proposes an action for the top cause."""
    site = build_site(p)
    result = audit.compute(site)
    probe = copy.deepcopy(site)
    audit.update_actions(probe, result)
    proposed = [a["cause"] for a in probe["actions"].values()]
    ranked = [{"cause": SPEC_NAME[h["cause"]], "confidence": h["confidence"]} for h in result["hypotheses"]]
    return {"ranked": ranked, "suggested": SPEC_NAME[proposed[0]] if proposed else None}


# ---------------------------------------------------------------- metrics
def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - m) / d, (c + m) / d)


def pct(k: int, n: int) -> str:
    lo, hi = wilson(k, n)
    return f"{k}/{n} = {100 * k / n:.1f}% (95% Wilson {100 * lo:.1f}-{100 * hi:.1f}%)" if n else "n/a"


def table(header: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(["---"] * len(header)) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def correct_top1(row: dict) -> bool:
    """Scoring rule: class a is correct iff no suggestion-level cause; others iff the ranked top-1 is the true cause."""
    if row["error"]:
        return False
    if row["cls"] == "a":
        return row["out"]["suggested"] is None
    return row["out"]["ranked"][0]["cause"] == row["label"]


def report(rows: list[dict], offset: int) -> str:
    out: list[str] = []
    w = out.append
    keys = ["a", "b", "c", "d", "e1", "e2", "e"]
    by = {k: [r for r in rows if r["cls"] == k] for k in ["a", "b", "c", "d", "e1", "e2"]}
    by["e"] = by["e1"] + by["e2"]
    causes = ["soiling", "sudden_fault", "low_from_start", "weather_or_noise"]
    ok = lambda rs: [r for r in rs if not r["error"]]  # noqa: E731

    w(f"**{LABEL}**\n")
    w(f"Plants: {len(rows)} ({', '.join(f'{k}: {len(by[k])}' for k in ['a', 'b', 'c', 'd', 'e1', 'e2'])}); "
      f"seed offset {offset} ({'v1' if offset == 0 else 'v2'}); engine errors: {sum(r['error'] is not None for r in rows)}.\n")

    w("#### Matrix 1: ranked top-1 cause (rows true class, columns the engine's first-ranked cause, counts)\n")
    hdr = ["true \\ engine top-1"] + causes + ["error", "n"]
    tr = []
    for k in keys:
        rs = by[k]
        cnt = {c: sum(1 for r in ok(rs) if r["out"]["ranked"][0]["cause"] == c) for c in causes}
        tr.append([k + (" (no_issue)" if k == "a" else "")] + [cnt[c] for c in causes]
                  + [sum(r["error"] is not None for r in rs), len(rs)])
    w(table(hdr, tr) + "\n")

    w("#### Matrix 2: suggestion-level cause (the engine proposed an action for its top cause; none = no suggestion)\n")
    hdr = ["true \\ suggestion-level"] + list(HARDWARE) + ["none", "error", "n"]
    tr = []
    for k in keys:
        rs = by[k]
        cnt = {c: sum(1 for r in ok(rs) if r["out"]["suggested"] == c) for c in HARDWARE}
        none = sum(1 for r in ok(rs) if r["out"]["suggested"] is None)
        tr.append([k + (" (no_issue)" if k == "a" else "")] + [cnt[c] for c in HARDWARE]
                  + [none, sum(r["error"] is not None for r in rs), len(rs)])
    w(table(hdr, tr) + "\n")

    w("#### Top-1 accuracy per class\n")
    w("Scoring: class a correct iff the engine reports no suggestion-level cause (matrix 2); classes b, c, d, e correct "
      "iff the ranked top-1 is the true cause (matrix 1). Errors count as incorrect.\n")
    tr = [[k, len(by[k]), sum(correct_top1(r) for r in by[k]), pct(sum(correct_top1(r) for r in by[k]), len(by[k]))] for k in keys]
    w(table(["class", "n", "correct", "top-1 accuracy"], tr) + "\n")
    w("Secondary, stricter: ranked top-1 correct AND suggestion-level (the owner would actually be offered the right action).\n")
    tr = []
    for k in ["b", "c", "d"]:
        c = sum(1 for r in ok(by[k]) if r["out"]["ranked"][0]["cause"] == r["label"] and r["out"]["suggested"] == r["label"])
        tr.append([k, len(by[k]), c, pct(c, len(by[k]))])
    w(table(["class", "n", "correct and suggested", "rate"], tr) + "\n")

    w("#### Top-3 hit rate (true cause among the engine's first three ranked causes; n/a for class a)\n")
    tr = []
    for k in ["b", "c", "d", "e1", "e2", "e"]:
        c = sum(1 for r in ok(by[k]) if r["label"] in [h["cause"] for h in r["out"]["ranked"][:3]])
        tr.append([k, len(by[k]), c, pct(c, len(by[k]))])
    w(table(["class", "n", "hits", "top-3"], tr) + "\n")

    w("#### Dust predicted as weather, and weather predicted as dust (reported separately)\n")
    b_w = sum(1 for r in ok(by["b"]) if r["out"]["ranked"][0]["cause"] == "weather_or_noise")
    w(f"- Dust predicted as weather (class b plants whose ranked top-1 is weather_or_noise): {pct(b_w, len(by['b']))}\n")
    tr = []
    for k in ["e1", "e2", "e"]:
        c = sum(1 for r in ok(by[k]) if r["out"]["ranked"][0]["cause"] == "soiling")
        tr.append([k, len(by[k]), c, pct(c, len(by[k]))])
    w("- Weather predicted as dust (class e plants whose ranked top-1 is soiling):\n")
    w(table(["class", "n", "top-1 soiling", "rate"], tr) + "\n")

    w("#### False-alarm rate (the engine reports a suggestion-level hardware cause on a plant with healthy hardware)\n")
    tr = []
    for name, rs in [("a", by["a"]), ("e1", by["e1"]), ("e2", by["e2"]), ("e", by["e"]), ("a + e", by["a"] + by["e"])]:
        c = sum(1 for r in ok(rs) if r["out"]["suggested"] in HARDWARE)
        by_cause = {h: sum(1 for r in ok(rs) if r["out"]["suggested"] == h) for h in HARDWARE}
        tr.append([name, len(rs), c, pct(c, len(rs)), ", ".join(f"{h} {v}" for h, v in by_cause.items())])
    w(table(["class", "n", "false alarms", "rate", "by suggested cause"], tr) + "\n")

    w("#### Confidence calibration (confidence of the ranked top-1 versus whether the plant is scored correct)\n")
    tr = []
    for lvl in ("low", "medium", "high"):
        rs = [r for r in ok(rows) if r["out"]["ranked"][0]["confidence"] == lvl]
        c = sum(correct_top1(r) for r in rs)
        tr.append([lvl, len(rs), c, pct(c, len(rs))])
    w(table(["top-1 confidence", "plants", "scored correct", "share correct"], tr) + "\n")
    w("Same, by true class and confidence (correct / plants):\n")
    tr = []
    for k in keys:
        cells = []
        for lvl in ("low", "medium", "high"):
            rs = [r for r in ok(by[k]) if r["out"]["ranked"][0]["confidence"] == lvl]
            cells.append(f"{sum(correct_top1(r) for r in rs)}/{len(rs)}")
        tr.append([k] + cells)
    w(table(["class", "low", "medium", "high"], tr) + "\n")

    w("#### Pre-declared breakdowns (terciles of the 60 plants by the hidden parameter; top-1 scored as above)\n")
    for k, key, name in [("b", "soil_r", "soiling rate r (per day)"), ("c", "fault_f", "step size f"),
                         ("d", "low_L", "low-from-start loss L")]:
        rs = sorted(by[k], key=lambda r: r["truth"][key])
        third = len(rs) // 3
        tr = []
        for i, chunk in enumerate([rs[:third], rs[third:2 * third], rs[2 * third:]]):
            c = sum(correct_top1(r) for r in chunk)
            tr.append([["low", "middle", "high"][i], f"{chunk[0]['truth'][key]:.4f} to {chunk[-1]['truth'][key]:.4f}",
                       len(chunk), c, pct(c, len(chunk))])
        w(f"Class {k} by {name}:\n")
        w(table(["tercile", "range", "n", "correct", "top-1"], tr) + "\n")
    tr = []
    for name, flag in [("end-anchored", True), ("interior", False)]:
        rs = [r for r in by["e1"] if r["truth"]["end_anchored"] is flag]
        c = sum(correct_top1(r) for r in rs)
        fa = sum(1 for r in ok(rs) if r["out"]["suggested"] in HARDWARE)
        tr.append([name, len(rs), c, pct(c, len(rs)), fa])
    w("Class e1 by spell placement:\n")
    w(table(["placement", "n", "top-1 weather_or_noise", "rate", "suggestion-level hardware cause"], tr) + "\n")
    w(f"**{LABEL}**")
    return "\n".join(out)


# ---------------------------------------------------------------- driver
def spec_hash() -> str:
    text = (ROOT / "docs" / "backtest.md").read_text(encoding="utf-8")
    marker = "## Harness decisions"
    head = text.split(marker)[0] if marker in text else text
    return hashlib.sha256(head.encode("utf-8")).hexdigest()[:16]


def check(plants: list[dict]) -> None:
    """Generator-conformance checks against the spec's own bounds, plus one engine-acceptance call (no result printed)."""
    for p in plants:
        t, n = p["truth"], p["truth"]["n"]
        assert 45 <= n <= 90 and len(p["kwh"]) == n and all(v >= 0 for v in p["kwh"])
        if p["cls"] == "b":
            assert 0.08 <= t["S"][-1] <= 0.35 and max(t["S"]) <= 0.40
            assert date(2025, 10, 15) <= p["dates"][0] and p["dates"][-1] <= date(2026, 6, 20)
        if p["cls"] == "c":
            assert 20 <= t["fault_tf"] <= n - 7 and 0.12 <= t["fault_f"] <= 0.70
        if p["cls"] == "d":
            assert 0.12 <= t["low_L"] <= 0.35
        if p["cls"] == "e1":
            s, ln = t["spell_s"], t["spell_len"]
            assert 5 <= ln <= 14 and (s + ln == n if t["end_anchored"] else 10 <= s <= n - ln - 5)
    one = build_site(plants[0])
    assert len(one["readings"]) == plants[0]["truth"]["n"]
    audit.compute(one)  # acceptance only; result discarded
    # healthy-plant mean specific yield by month versus the spec's Y_typ column (sanity of the plant model)
    sums, cnt = {}, {}
    for p in plants:
        if p["cls"] in ("a", "e2"):
            for d, v in zip(p["dates"], p["kwh"]):
                sums[d.month] = sums.get(d.month, 0) + v / p["plant"]["kw"]
                cnt[d.month] = cnt.get(d.month, 0) + 1
    print("month: generator mean kWh/kW/day (healthy plants) vs spec Y_typ")
    for m in range(1, 13):
        typ = H_TAB[m - 1] * PR_NOMINAL * K_MEAN[m - 1]
        print(f"  {m:2d}: {sums[m] / cnt[m]:.2f} (n={cnt[m]})  Y_typ {typ:.2f}" if m in cnt else f"  {m:2d}: no samples")
    print(f"generator checks passed for {len(plants)} plants")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--offset", type=int, default=0)
    args = ap.parse_args()
    plants = [generate(c, CLASSES[c][1] + i + 1 + args.offset) for c in CLASSES for i in range(N_PER_CLASS)]
    if args.check:
        check(plants)
        return
    rows = []
    for p in plants:
        row = {"cls": p["cls"], "label": p["label"], "seed": p["seed"], "truth": p["truth"], "error": None, "out": None}
        try:
            row["out"] = run_engine(p)
        except Exception as e:  # noqa: BLE001  an engine failure is an error row, counted and reported
            row["error"] = f"{type(e).__name__}: {e}"
        rows.append(row)
    sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()[:16]
    try:
        head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    except OSError:
        head = "unknown"
    print(f"scripts/backtest.py sha256 {sha}; spec (text before 'Harness decisions') sha256 {spec_hash()}; repo HEAD {head}\n")
    print(report(rows, args.offset))
    errs = [r for r in rows if r["error"]]
    if errs:
        print("\nEngine error rows:")
        for r in errs:
            print(f"- {r['cls']} seed {r['seed']}: {r['error']}")


if __name__ == "__main__":
    main()
