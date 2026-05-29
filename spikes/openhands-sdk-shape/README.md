# OpenHands SDK Shape Spike

> **THROWAWAY** — This spike exists for historical reference only.
> Do NOT import `probe.py` into any runtime paths.
> See verdict: `plans/260522-1649-harness-plugin-contract-design/spike-openhands-sdk-shape.md`

## Purpose

Verify whether `openhands-sdk==1.22.1`'s actual API shape matches the
`LLM + Agent + Conversation + Tool[]` assumptions in spec §1.2 + §2.6.

## Prerequisites

- Python ≥3.12 on PATH
- `uv` on PATH
- `ANTHROPIC_API_KEY` set in local `.env` (for live mode only)

## Run — shape-only (no API key required)

```bash
uv run --python 3.12 --with openhands-sdk==1.22.1 \
  python spikes/openhands-sdk-shape/probe.py --shape-only
```

## Run — live mode (requires ANTHROPIC_API_KEY)

```bash
# From worktree root
set -a; source .env; set +a
uv run --python 3.12 --with openhands-sdk==1.22.1 \
  python spikes/openhands-sdk-shape/probe.py \
  --message "Say hello in one sentence." \
  > /tmp/openhands-probe.json
```

## Output

JSON to stdout:
```json
{
  "sdk_shape": { ... },
  "live_result": {
    "session_class": "LocalConversation",
    "turn_result_shape": { ... },
    "tool_call_events": [ ... ],
    "raw_events_truncated": [ ... ],
    "errors": []
  }
}
```

## Key findings

See `plans/260522-1649-harness-plugin-contract-design/spike-openhands-sdk-shape.md`
for the full discrepancy table and verdict.
