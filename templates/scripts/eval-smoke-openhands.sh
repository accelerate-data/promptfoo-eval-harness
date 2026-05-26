#!/usr/bin/env bash
set -euo pipefail
# The harness CLI manages the openhands-agent-server lifecycle automatically.
exec "$(dirname "$0")/../../bin/ad-evals" smoke "$@"
