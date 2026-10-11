#!/usr/bin/env bash
# Online test mode for the demo plant: the LOCAL app with LIVE PVGIS and NASA POWER (no recorded fixtures) and a synthetic demo plant whose
# readings are shifted so the last one is yesterday (India time). The plant is labelled synthetic, as always.
#
#   bash scripts/demo_online.sh            # starts on port 8124, prints the demo link, Ctrl-C stops it
#   PORT=9000 bash scripts/demo_online.sh
#
# Photo reading (Gemini) is on only if GEMINI_API_KEY is set in YOUR shell or in a local .env file (a line GEMINI_API_KEY=...); the key is never printed or written anywhere.
# Data is in memory: stopping the server forgets the plant. Nothing here touches AWS or any deployed URL.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-8124}"
PY=.venv/Scripts/python.exe
[ -x "$PY" ] || PY=.venv/bin/python
[ -x "$PY" ] || { echo "no .venv: run 'uv sync' first" >&2; exit 1; }

unset PVGIS_MODE IRRADIANCE_MODE SITES_TABLE GEMINI_KEY_PARAM   # live weather, in-memory store, no deployed parameters
# No key in this shell: use the one in a local .env file, if there is one (git-ignored; this script never prints or copies it).
if [ -z "${GEMINI_API_KEY:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; KEYSRC="the .env file"; else KEYSRC="this shell"; fi
if [ -n "${GEMINI_API_KEY:-}" ]; then PHOTO="on (key found in $KEYSRC)"; else PHOTO="OFF (no GEMINI_API_KEY in this shell or in .env: type readings by hand)"; fi

"$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" > .demo-online.log 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 40); do curl -s -m 2 "http://127.0.0.1:$PORT/health" > /dev/null && break; sleep 0.5; done
curl -s -m 2 "http://127.0.0.1:$PORT/health" > /dev/null || { echo "server did not start; see .demo-online.log" >&2; exit 1; }

LINK=$("$PY" -I scripts/load_demo_shifted.py "http://127.0.0.1:$PORT" 2>> .demo-online.log)
[ -n "$LINK" ] || { echo "could not load the demo plant; see .demo-online.log" >&2; exit 1; }
echo
echo "Online test mode (live PVGIS and NASA POWER, in-memory store, synthetic demo plant ending yesterday)"
echo "  Demo plant:    $LINK"
echo "  Fresh set-up:  http://127.0.0.1:$PORT/"
echo "  Photo reading: $PHOTO"
echo "  Ctrl-C stops the server and forgets the plant."
wait "$SERVER"
