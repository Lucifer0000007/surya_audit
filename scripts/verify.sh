#!/usr/bin/env bash
# Definition of done: boot the API, check POST /api/assess against the sample,
# run the tests, and run the Playwright check of the main screen.
# Exits non-zero with a one-line reason on the first failure.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${VERIFY_PORT:-8765}"
BASE="http://127.0.0.1:$PORT"
FIXTURES=tests/fixtures
export PVGIS_FIXTURE="$FIXTURES/pvgis_sample.json"

fail() { echo "VERIFY FAIL: $*" >&2; exit 1; }

command -v uv >/dev/null || fail "uv is not on PATH"
[ -f pyproject.toml ] || fail "no pyproject.toml (app not scaffolded yet)"
uv sync --quiet || fail "uv sync failed"

# Run the venv's Python directly so killing the server PID really stops it.
PY=.venv/Scripts/python.exe
[ -x "$PY" ] || PY=.venv/bin/python
[ -x "$PY" ] || fail "no virtualenv python after uv sync"

curl -s -o /dev/null "$BASE/" && fail "port $PORT is already in use"
"$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" > .verify-server.log 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

for _ in $(seq 1 30); do
  curl -s -o /dev/null "$BASE/" && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "server exited during boot: $(tail -n 3 .verify-server.log)"
  sleep 1
done
curl -s -o /dev/null "$BASE/" || fail "server did not answer on $BASE within 30s"

for f in sample_input.json sample_expected.json pvgis_sample.json; do
  [ -f "$FIXTURES/$f" ] || fail "missing $FIXTURES/$f"
done
resp=$(curl -sS -f -X POST "$BASE/api/assess" -H 'Content-Type: application/json' \
  --data-binary "@$FIXTURES/sample_input.json") || fail "POST /api/assess returned an error"

# Every key in sample_expected.json must match the response exactly.
printf '%s' "$resp" | "$PY" -c '
import json, sys
got = json.load(sys.stdin)
want = json.load(open(sys.argv[1], encoding="utf-8"))
bad = [f"{k}: want {want[k]!r}, got {got.get(k)!r}" for k in want if got.get(k) != want[k]]
sys.exit("; ".join(bad)) if bad else None
' "$FIXTURES/sample_expected.json" || fail "endpoint result does not match sample_expected.json"

"$PY" -m pytest -q tests > .verify-tests.log 2>&1 || fail "tests failed: $(tail -n 1 .verify-tests.log)"

"$PY" -m playwright install chromium > /dev/null 2>&1 || fail "playwright chromium install failed"
"$PY" -m pytest -q e2e --base-url "$BASE" > .verify-e2e.log 2>&1 || fail "playwright check failed: $(tail -n 1 .verify-e2e.log)"

echo "VERIFY PASS: server boots, /api/assess matches sample, tests and Playwright check pass"
