# OpenHands SDK Provider

Python provider for [openhands-sdk](https://github.com/All-Hands-AI/OpenHands) (pinned: `1.22.1`).
Implements the `SDKProvider` Protocol from `_contract.py` for subprocess dispatch via the Node bridge.

## Module layout

| File | Purpose |
| --- | --- |
| `__init__.py` | Package marker |
| `provider.py` | `SDKProvider` implementation — `create()` factory, `init/turn/finalize/shutdown` |
| `tool_registry.py` | Whitelist of allowed SDK tool names; `get_allowed_tools()` |
| `model_resolver.py` | Short alias → LiteLLM-prefixed model string |
| `event_extractor.py` | `EventExtractor` — maps SDK events to `TurnResult` / `ToolCallRecord` |
| `agent_factory.py` | `build_agent(cfg, ...)` — composes `LLM + Agent + Conversation` |
| `_errors.py` | `ProviderRuntimeError` — exception wrapper for structured errors |

## Running tests (no API key needed)

```bash
# All Layer 1/2/3 tests in this directory
uv run pytest scripts/framework/providers/openhands_sdk/ -v

# Coverage report
uv run pytest scripts/framework/providers/openhands_sdk/ \
  --cov=scripts/framework/providers/openhands_sdk --cov-report=term-missing -q
```

## Linting

```bash
ruff check scripts/framework/providers/openhands_sdk/
ruff format --check scripts/framework/providers/openhands_sdk/
```

## Dispatch path

The Node bridge subprocess-spawns the Python adapter when `provider_kind: openhands_sdk`:

```text
Node bridge → KIND_REGISTRY.openhands_sdk → uv run --with openhands-sdk==1.22.1 \
              python -m scripts.framework.providers._python_adapter --kind=openhands_sdk
              → _PROVIDER_REGISTRY["openhands_sdk"] → provider.create() → OpenHandsSDKProvider
```

## Design notes

- **No SDK at import time**: all `openhands.sdk` imports are inside functions so the module
  loads without the SDK installed (needed by the JS-side validator).
- **Spike A.0 row #3**: `turn()` calls `send_message()` then `run()` (blocking), NOT a single call.
- **Spike A.0 row #7**: `shutdown()` calls `session.conversation.close()` with
  `delete_on_close=False` — workspace cleanup is owned by the bridge (§7.3).
- **Cost tracking**: `finalize()` returns `cost_usd=0.0` in v1.0.0; real extraction from
  `ConversationStats.usage_to_metrics` deferred to v1.1+ ticket.
- **Layer 4 (live API)**: See phase 08 for the `openhands-mock-multi-turn` scenario that
  exercises this provider end-to-end with a real API key.
