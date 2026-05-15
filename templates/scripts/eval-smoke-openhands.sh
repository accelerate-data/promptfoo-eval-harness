#!/usr/bin/env bash
# Run the smoke eval suite against the openhands-agent-server provider.
#
# OpenHands is the default provider in eval-tiers.toml; no tier-config swap
# is needed. This script only manages the agent-server lifecycle and runs
# the smoke suite. The cleanup trap signals the server on every exit path
# including a failed start_server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_ROOT="$SCRIPT_DIR/.."
BACKUP_DIR="$EVAL_ROOT/.tmp"
SERVER_PID_FILE="$BACKUP_DIR/openhands-server.$$.pid"

# Load local .env (gitignored) so credentials and OPENHANDS_MODEL_OVERRIDE
# can be set per-developer without exporting them globally.
if [ -f "$EVAL_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$EVAL_ROOT/.env"
  set +a
fi

# Derive the LiteLLM credential env var from the model that will actually run:
# the explicit OPENHANDS_MODEL_OVERRIDE wins, otherwise read openhands.json's
# eval_light tier as the smoke default. ollama/* needs no key (host-based).
resolved_model="${OPENHANDS_MODEL_OVERRIDE:-}"
if [ -z "$resolved_model" ]; then
  resolved_model="$(python3 -c "import json; print(json.load(open('$EVAL_ROOT/openhands.json'))['agent']['eval_light']['model'])")"
fi
case "$resolved_model" in
  opencode-go/*) cred_var="OPENCODE_API_KEY" ;;
  openai/*)      cred_var="OPENAI_API_KEY" ;;
  anthropic/*)   cred_var="ANTHROPIC_API_KEY" ;;
  groq/*)        cred_var="GROQ_API_KEY" ;;
  deepseek/*)    cred_var="DEEPSEEK_API_KEY" ;;
  ollama/*)      cred_var="" ;;
  *)             cred_var="" ;;
esac
if [ -n "$cred_var" ] && [ -z "${!cred_var:-}" ]; then
  echo "[eval-smoke-openhands] SKIP: $cred_var is not set (LiteLLM credential for $resolved_model); exiting 100 (baseline pass)" >&2
  exit 100
fi

if ! command -v uvx >/dev/null 2>&1; then
  echo "[eval-smoke-openhands] SKIP: uvx not on PATH (required to launch openhands-agent-server); exiting 100 (baseline pass)" >&2
  exit 100
fi

mkdir -p "$BACKUP_DIR"

stop_server() { bash "$SCRIPT_DIR/openhands-server.sh" down "$SERVER_PID_FILE" || true; }
trap stop_server EXIT

bash "$SCRIPT_DIR/openhands-server.sh" up "$SERVER_PID_FILE"

echo "[eval-smoke-openhands] provider: openhands-agent-server, model: $resolved_model"
cd "$EVAL_ROOT"
ad-evals smoke "$@"
