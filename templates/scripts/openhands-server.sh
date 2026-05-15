#!/usr/bin/env bash
# Lifecycle helper for the OpenHands Agent Server during local eval runs.
#
# Usage:
#   openhands-server.sh up   <pid-file>   # start, record PID, poll /health
#   openhands-server.sh down <pid-file>   # SIGTERM, wait, SIGKILL fallback
#
# Reads openhands_version, openhands_server_url, and
# openhands_server_startup_timeout_ms from tests/evals/openhands.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_ROOT="$SCRIPT_DIR/.."
OPENHANDS_JSON="$EVAL_ROOT/openhands.json"

verb="${1:-}"
pid_file="${2:-}"

if [ -z "$verb" ] || [ -z "$pid_file" ]; then
  echo "Usage: $0 {up|down} <pid-file>" >&2
  exit 2
fi

read_json_key() {
  python3 -c "import json,sys; print(json.load(open('$OPENHANDS_JSON'))['$1'])"
}

ms_now() {
  python3 -c "import time; print(int(time.time() * 1000))"
}

case "$verb" in
  up)
    if [ ! -f "$OPENHANDS_JSON" ]; then
      echo "[openhands-server] FATAL: $OPENHANDS_JSON not found" >&2
      exit 1
    fi

    version="$(read_json_key openhands_version)"
    url="$(read_json_key openhands_server_url)"
    timeout_ms="$(read_json_key openhands_server_startup_timeout_ms)"
    port="$(echo "$url" | sed -E 's|^https?://[^:]+:([0-9]+).*|\1|')"
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
      echo "[openhands-server] FATAL: could not parse port from openhands.json:openhands_server_url ($url)" >&2
      exit 1
    fi

    if lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "[openhands-server] FATAL: port $port already in use; edit openhands.json:openhands_server_url" >&2
      exit 1
    fi

    if ! command -v uvx >/dev/null 2>&1; then
      echo "[openhands-server] FATAL: uvx not on PATH; install uv (https://docs.astral.sh/uv/) or run openhands-agent-server manually on $url" >&2
      exit 1
    fi

    mkdir -p "$EVAL_ROOT/.tmp"

    echo "[openhands-server] starting openhands-agent-server@$version on $url"
    uvx --with libtmux \
        --with "openhands-tools==$version" \
        --from "openhands-agent-server==$version" \
        agent-server --host 127.0.0.1 --port "$port" \
        >"$EVAL_ROOT/.tmp/openhands-server.log" 2>&1 &
    echo "$!" > "$pid_file"

    deadline=$(( $(ms_now) + timeout_ms ))
    while :; do
      if curl -fsS "$url/health" >/dev/null 2>&1; then
        echo "[openhands-server] ready"
        exit 0
      fi
      now=$(ms_now)
      if [ "$now" -ge "$deadline" ]; then
        echo "[openhands-server] FATAL: /health did not return 200 within ${timeout_ms}ms" >&2
        echo "[openhands-server] last 20 lines of $EVAL_ROOT/.tmp/openhands-server.log:" >&2
        tail -n 20 "$EVAL_ROOT/.tmp/openhands-server.log" >&2 || true
        if [ -f "$pid_file" ]; then kill -TERM "$(cat "$pid_file")" 2>/dev/null || true; rm -f "$pid_file"; fi
        exit 1
      fi
      sleep 0.5
    done
    ;;
  down)
    if [ ! -f "$pid_file" ]; then
      echo "[openhands-server] down: no pid file at $pid_file (nothing to stop)"
      exit 0
    fi
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "[openhands-server] SIGTERM $pid"
      kill -TERM "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        if ! kill -0 "$pid" 2>/dev/null; then break; fi
        sleep 0.5
      done
      if kill -0 "$pid" 2>/dev/null; then
        echo "[openhands-server] SIGKILL $pid (SIGTERM ignored)"
        kill -KILL "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$pid_file"
    ;;
  *)
    echo "Usage: $0 {up|down} <pid-file>" >&2
    exit 2
    ;;
esac
