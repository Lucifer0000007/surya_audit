#!/usr/bin/env bash
# Definition of done for Surya Audit. Run as `bash scripts/verify.sh` in Git Bash.
# Stage-aware: boots the API offline (fixtures, no keys), drives the synthetic
# scenario over HTTP, runs pytest, and runs the Playwright check of / once an
# index.html exists. On the first failure it prints one reason line and exits non-zero.
# Worst case is about 23 minutes (sum of the timeouts below); the Stop hook allows 25.
set -uo pipefail
cd "$(dirname "$0")/.."

# The synthetic scenario ends inside its sudden-fault window (see CLAUDE.md).
EXPECTED_TOP=sudden_fault

fail() { echo "VERIFY FAIL: $*" >&2; exit 1; }
last_line() { tail -n 1 "$1" 2>/dev/null | tr -d '\r'; }

# Offline: recorded fixtures only, never a Gemini key.
export PVGIS_MODE=fixture IRRADIANCE_MODE=fixture
unset GEMINI_API_KEY GEMINI_KEY_PARAM SITES_TABLE  # never the deployed key, parameter or table

{ [ -f pyproject.toml ] && [ -f app/main.py ]; } || fail "no app yet"
command -v uv >/dev/null || fail "uv is not on PATH"
timeout 180 uv sync > .verify-sync.log 2>&1 || fail "uv sync: $(last_line .verify-sync.log)"

# Use the venv's python directly so the server PID is the server itself.
PY=.venv/Scripts/python.exe
[ -x "$PY" ] || PY=.venv/bin/python
[ -x "$PY" ] || fail "no .venv python after uv sync"

# Surface upgrade: the engine, API, infrastructure and their tests must still equal the last deployed commit
# (docs/FROZEN_SHA; the paths are in docs/PROTECTED_PATHS).
timeout 60 "$PY" scripts/check_frozen.py > .verify-frozen.log 2>&1 || fail "frozen paths: $(last_line .verify-frozen.log)"

PORT=$("$PY" -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' | tr -d '\r')
[ -n "$PORT" ] || fail "could not find a free port"
BASE="http://127.0.0.1:$PORT"

"$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" > .verify-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null' EXIT

for _ in $(seq 60); do
  curl -sf -o /dev/null "$BASE/health" && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited during boot: $(last_line .verify-server.log)"
  sleep 1
done
curl -sf -o /dev/null "$BASE/health" || fail "/health did not answer within 60s"

for f in fixtures/synthetic_site.json fixtures/synthetic_site.csv; do
  [ -f "$f" ] || fail "missing $f (generate it with scripts/make_synthetic_site.py)"
done
timeout 120 "$PY" - "$BASE" "$EXPECTED_TOP" > .verify-scenario.log 2>&1 <<'EOF' || fail "scenario: $(last_line .verify-scenario.log)"
import csv, json, sys, urllib.error, urllib.request

base, expected_top = sys.argv[1], sys.argv[2]

def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path} returned HTTP {e.code}")

with open("fixtures/synthetic_site.json", encoding="utf-8") as f:
    site = call("POST", "/api/sites", json.load(f))
site_id = site.get("id")
if not site_id:
    sys.exit("POST /api/sites returned no id")
with open("fixtures/synthetic_site.csv", newline="", encoding="utf-8") as f:
    for row in csv.DictReader(f):
        reading = {k: v for k, v in row.items() if v}
        reading["kwh"] = float(reading["kwh"])
        call("POST", f"/api/sites/{site_id}/readings", reading)
audit = call("GET", f"/api/sites/{site_id}/audit")

problems = [f"flag {k} missing" for k in ("synthetic", "sample", "heuristic") if k not in audit]
if audit.get("synthetic") is not True:
    problems.append("synthetic is not true")
if audit.get("heuristic") is not True:
    problems.append("heuristic is not true")
hypotheses = audit.get("hypotheses") or []
if not hypotheses:
    problems.append("no hypotheses")
for h in hypotheses:
    if h.get("confidence") not in ("low", "medium", "high"):
        problems.append(f"{h.get('cause')}: confidence {h.get('confidence')!r}")
    if not h.get("why"):
        problems.append(f"{h.get('cause')}: empty why")
if hypotheses and hypotheses[0].get("cause") != expected_top:
    problems.append(f"top cause {hypotheses[0].get('cause')!r}, expected {expected_top!r}")
if problems:
    sys.exit("; ".join(problems))
print("scenario ok")
EOF

[ -d tests ] || fail "no tests yet"
timeout 180 "$PY" -m pytest -q > .verify-tests.log 2>&1 || fail "pytest: $(last_line .verify-tests.log)"

if [ -z "$(git ls-files -co --exclude-standard -- index.html '*/index.html')" ]; then
  echo "SKIP playwright: no index.html yet"
  PLAYWRIGHT=skipped
else
  [ -f package.json ] || fail "index.html exists but package.json (for @playwright/test) does not"
  : > .verify-e2e.log
  [ -d node_modules ] || timeout 180 npm install --no-audit --no-fund >> .verify-e2e.log 2>&1 \
    || fail "npm install: $(last_line .verify-e2e.log)"
  timeout 300 npx playwright install chromium >> .verify-e2e.log 2>&1 \
    || fail "playwright browser install: $(last_line .verify-e2e.log)"
  BASE_URL="$BASE" timeout 300 npx playwright test >> .verify-e2e.log 2>&1 \
    || fail "playwright: $(last_line .verify-e2e.log)"
  PLAYWRIGHT=passed
fi

echo "VERIFY PASS: offline boot, synthetic scenario ranks $EXPECTED_TOP first, pytest passed, playwright $PLAYWRIGHT"
