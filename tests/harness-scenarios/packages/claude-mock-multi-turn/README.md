# claude-mock-multi-turn

Layer 4 mock-mode scenario for `provider_kind=claude_agent_sdk` (Phase 10 / VD-2174-9).

Validates the Claude Agent SDK subprocess provider end-to-end through the
single `file://` Promptfoo bridge without a live `ANTHROPIC_API_KEY` or
network call. The real `claude-agent-sdk==0.2.85` wheel is installed by
`uv run` but its public symbols are overridden at interpreter startup by
[`tests/_mock_claude_agent_sdk/sitecustomize.py`](../../../_mock_claude_agent_sdk/sitecustomize.py),
which patches `sys.modules["claude_agent_sdk"]` with the deterministic mock
from [`tests/_mock_claude_agent_sdk/sdk.py`](../../../_mock_claude_agent_sdk/sdk.py).

## Coverage

| Case | Turns | What it locks |
| --- | --- | --- |
| `[single-turn] greeting yields Hi there!` | 1 (`hello`) | Single-turn `query()` path (no `ClaudeSDKClient`). Asserts the assistant response surfaces through the bridge. |
| `[multi-turn] turn 2 must recall the number remembered in turn 1` | 2 (`Please remember 42 for me.` → `what number was it?`) | Multi-turn `ClaudeSDKClient` path. Verifies the provider reuses the same client across turns so turn 2 can recall `42` from turn 1's history. Asserts both turn outputs surface (split by `\n---\n`). |

## Running locally

```sh
PYTHONPATH="$PWD/tests/_mock_claude_agent_sdk" \
  node bin/ad-evals.js run tests/harness-scenarios/packages/claude-mock-multi-turn
```

`PYTHONPATH` must include `tests/_mock_claude_agent_sdk` so the mock SDK
takes precedence over the real wheel. Without it the scenario will attempt
a real Anthropic API call and fail.

## Nightly CI

Wired into [`.github/workflows/nightly-scenarios.yml`](../../../../.github/workflows/nightly-scenarios.yml).
The workflow's `PYTHONPATH` already contains both
`tests/_mock_claude_agent_sdk` and `tests/_mock_openhands_sdk`, and a
pre-warm step installs `claude-agent-sdk==0.2.85` into uv's cache so the
nightly run does not pay first-fetch latency.
