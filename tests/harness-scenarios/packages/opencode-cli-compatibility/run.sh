#!/usr/bin/env bash
# Run the opencode-cli-compatibility scenario using the mock opencode binary.
#
# This script injects tests/_mock_opencode/ at the front of PATH so the
# mock opencode binary is used instead of any real installation.  No live
# API key is required; all three cases receive canned responses.
#
# Promptfoo resolves file:// provider URLs relative to the config file, so
# this script runs from REPO_ROOT and passes the config path relative to it.
#
# Usage (from anywhere):
#   bash tests/harness-scenarios/packages/opencode-cli-compatibility/run.sh
#
# To run against a real opencode binary:
#   ANTHROPIC_API_KEY=sk-... \
#   bash tests/harness-scenarios/packages/opencode-cli-compatibility/run.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"
MOCK_BIN="${REPO_ROOT}/tests/_mock_opencode"
PROMPTFOO="${REPO_ROOT}/node_modules/promptfoo/dist/src/entrypoint.js"
CONFIG_REL="tests/harness-scenarios/packages/opencode-cli-compatibility/promptfooconfig.json"

export PATH="${MOCK_BIN}:${PATH}"
export OPENCODE_MOCK_MODE=1

# Run from REPO_ROOT so that file://scripts/framework/_node_bridge.js resolves
# relative to the repo root (Promptfoo resolves file:// URLs relative to CWD
# when the config file path is also relative to CWD).
cd "${REPO_ROOT}"

exec node "${PROMPTFOO}" eval \
  --no-cache \
  -c "${CONFIG_REL}" \
  "$@"
