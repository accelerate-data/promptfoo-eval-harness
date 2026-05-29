# Phase 06 — OpenHands SDK Provider (D.16-D.21)

> **Sub-issue:** VD-2174-5. **Status:** complete. **Blocked by:** phase 03 (and informed by phase 01 spike verdict).
> Time budget: ~1 week.

## Context Links

- Spec: [`spec.md`](spec.md) §1.2 (dataclasses), §2.6 (subprocess flow), §3 (multi-turn `vars.turns`), §5.1 (`openhands-mock-multi-turn` scenario), §6.3 (Python packaging), §6.4 (sdk-pins.toml), §8.3 Layer 3 mock-SDK tests, §9.2 Steps D.16-D.21.
- Spike verdict (must be PASS): `spike-openhands-sdk-shape.md`.

## Overview

- **Priority:** First non-CLI provider — proves the contract end-to-end.
- **Current status:** Pending.
- **Brief:** Build the `openhands_sdk` provider as a Python module that satisfies the §1.2 contract: tool registry stub, model resolver, event extractor, agent factory, the provider class itself, Layer 3 mock-SDK integration tests, and wiring into `_node_bridge.KIND_REGISTRY` so the bridge can subprocess-spawn it via `_python_adapter.py`.

## Key Insights

- Provider is **stateless across runs**; per-`init` state lives in `Session`.
- All event/tool-call extraction routes through a single `event_extractor.py` so test fixtures can replay raw SDK events without re-running the live API.
- Mock SDK (Layer 3) eliminates Anthropic dependency for CI; live API is touched only by an opt-in Layer 4 scenario.

## Requirements

### Functional

1. **Tool registry (D.16):** `scripts/framework/providers/openhands_sdk/tool_registry.py` — declares the tool set we allow OpenHands to invoke (start small: `BashTool`, `FileReadTool`, `FileEditTool`; exact names verified by phase 01 spike).
2. **Model resolver (D.17):** `scripts/framework/providers/openhands_sdk/model_resolver.py` — maps short model names (`claude-sonnet-4-6`) to LLM config objects per §1.4. Reuses any global model alias map from harness.
3. **Event extractor (D.18):** `scripts/framework/providers/openhands_sdk/event_extractor.py`:
   - Consumes SDK events (callback or stream).
   - Maps to spec §1.2 `ToolCallRecord` + `TurnResult` shapes.
   - Buffers events per turn; resets on each `turn()` call.
4. **Agent factory (D.19):** `scripts/framework/providers/openhands_sdk/agent_factory.py` — composes `LLM + Agent + Conversation + Tool[]` per spike findings.
5. **Provider class (D.20):** `scripts/framework/providers/openhands_sdk/provider.py`:
   - Implements `SDKProvider` Protocol (see `_contract.py`).
   - `init(cfg)` → builds `Session` containing the LLM, agent, conversation, event extractor.
   - `turn(session, input)` → sends one user message; collects events; returns `TurnResult`.
   - `finalize(session)` → returns `FinalResult` (event summary + token totals).
   - `shutdown(session)` → closes conversation, frees subscriptions.
   - Idempotent on repeat shutdown.
6. **Layer 3 mock-SDK tests (D.20):** `scripts/framework/providers/openhands_sdk/provider.test.py`:
   - Replaces `openhands.sdk` symbols with a `MockOpenHandsSDK` (no network).
   - Exercises init → 3 turns → finalize → shutdown; asserts each turn produces a `TurnResult` matching spec §1.2.
   - Covers failure modes: tool-call error mid-turn, LLM timeout, malformed event from SDK.
7. **Dispatch wiring (D.21):** Update `scripts/framework/_node_bridge.js` `KIND_REGISTRY.openhands_sdk` to subprocess-spawn via `uv run --python 3.12 --with openhands-sdk==1.22.1 python -m scripts.framework.providers._python_adapter openhands_sdk`.

### Non-functional

- Layer 3 tests run without `ANTHROPIC_API_KEY` set.
- Provider module is < 200 lines per file (per project rule).
- `ruff check` + `ruff format` clean.

## Architecture

```text
scripts/framework/providers/openhands_sdk/
├── __init__.py
├── provider.py            # SDKProvider impl — init/turn/finalize/shutdown
├── provider.test.py       # Layer 3 mock-SDK
├── tool_registry.py
├── model_resolver.py
├── event_extractor.py
├── event_extractor.test.py
├── agent_factory.py
└── README.md              # local-run instructions

scripts/framework/providers/_python_adapter.py
  └── dispatch: importlib → openhands_sdk.provider.create() → SDKProvider instance

scripts/framework/_node_bridge.js
  └── KIND_REGISTRY.openhands_sdk = {
        mode: 'subprocess',
        spawn: ['uv', 'run', '--python', '3.12',
                '--with', 'openhands-sdk==1.22.1',
                'python', '-m', 'scripts.framework.providers._python_adapter',
                'openhands_sdk']
      }
```

## Related Code Files

- **Create:**
  - `scripts/framework/providers/openhands_sdk/__init__.py`
  - `scripts/framework/providers/openhands_sdk/provider.py`
  - `scripts/framework/providers/openhands_sdk/provider.test.py`
  - `scripts/framework/providers/openhands_sdk/tool_registry.py`
  - `scripts/framework/providers/openhands_sdk/model_resolver.py`
  - `scripts/framework/providers/openhands_sdk/event_extractor.py`
  - `scripts/framework/providers/openhands_sdk/event_extractor.test.py`
  - `scripts/framework/providers/openhands_sdk/agent_factory.py`
  - `scripts/framework/providers/openhands_sdk/README.md`
  - `tests/_mock_openhands_sdk/__init__.py` (mock module)
  - `tests/_mock_openhands_sdk/sdk.py` (mock LLM/Agent/Conversation classes)
- **Modify:**
  - `scripts/framework/_node_bridge.js` (KIND_REGISTRY.openhands_sdk entry)
  - `scripts/framework/providers/_python_adapter.py` (dispatch map — already in phase 03; just confirm registry entry)
  - `config/sdk-pins.toml` (verify extras list matches spike verdict)
- **Delete:** none.

## Implementation Steps

### D.16 — Tool registry

1. Read phase 01 verdict `spike-openhands-sdk-shape.md` for tool surface details.
2. Author `tool_registry.py`:
   - Whitelist of allowed tool classes from `openhands.sdk.tools`.
   - `get_allowed_tools()` returns instantiated tools ready for `Agent`.
   - Defensive: raise on unknown tool names.
3. Commit: `feat(vd-2174-5): seed OpenHands SDK tool registry (D.16)`.

### D.17 — Model resolver

4. Author `model_resolver.py`:
   - `resolve_model(name)` returns `LLMConfig` with model name, max tokens, temperature defaults from `config/eval-models.toml` (or equivalent existing file).
   - Raises with actionable message if model unknown.
5. Author Layer 1 test `model_resolver.test.py`.
6. Commit: `feat(vd-2174-5): wire OpenHands SDK model resolver (D.17)`.

### D.18 — Event extractor

7. Author `event_extractor.py`:
   - Class `EventExtractor` with `start_turn()`, `on_event(evt)`, `end_turn() -> TurnResult`.
   - Maps SDK events → `ToolCallRecord` per §1.2.
   - Captures assistant text, tool calls, latency, errors.
8. Author `event_extractor.test.py`:
   - Feeds fixture JSON of raw SDK events (captured by the phase 01 spike).
   - Asserts produced `TurnResult` matches spec §1.2 invariants.
9. Commit: `feat(vd-2174-5): land OpenHands event extractor + tests (D.18)`.

### D.19 — Agent factory

10. Author `agent_factory.py`:
    - `build_agent(cfg, tool_registry, model_resolver)` returns `(agent, conversation)` per spike findings.
    - Passes config-driven `system_prompt`, `temperature`, `max_iterations`.
11. Smoke-load it from a Python REPL with mock SDK — confirms wiring.
12. Commit: `feat(vd-2174-5): assemble OpenHands agent factory (D.19)`.

### D.20 — Provider class + Layer 3 tests

13. Author `tests/_mock_openhands_sdk/sdk.py`:
    - Mock `LLM`, `Agent`, `Conversation`, `Tool[]` classes.
    - Deterministic responses keyed by input string.
    - Records `init` / `turn` / `finalize` / `shutdown` invocations.
14. Author `provider.py`:
    - `create()` factory returning a `SDKProvider` instance.
    - `init(cfg) -> Session` — composes LLM/agent/conversation/extractor.
    - `turn(session, input_str) -> TurnResult` — sends message, collects events, returns.
    - `finalize(session) -> FinalResult`.
    - `shutdown(session)` — idempotent.
15. Author `provider.test.py`:
    - Monkey-patches `openhands.sdk` symbols with the mock module.
    - Exercises init → 3 turns → finalize → shutdown.
    - Failure cases: tool-call error mid-turn, LLM timeout, malformed event.
16. Run `pytest scripts/framework/providers/openhands_sdk/ -q` — green.
17. Commit: `feat(vd-2174-5): land OpenHands SDK provider + Layer 3 tests (D.20)`.

### D.21 — Dispatch wiring

18. Update `_node_bridge.js`:
    - `KIND_REGISTRY.openhands_sdk = { mode: 'subprocess', spawn: [...uv args...] }`.
    - Confirm semaphore is wrapped around subprocess spawn AND each turn.
19. Update `_python_adapter.py` (if changes needed) so importing `scripts.framework.providers.openhands_sdk.provider` resolves under uv.
20. Author Layer 2 test `scripts/framework/_node_bridge.openhands_sdk.test.js` — DISPATCH RESOLUTION ONLY (do NOT duplicate the full NDJSON round-trip; phase 03's `_node_bridge.test.js` already owns the protocol coverage per spec §2.4):
    - Asserts `KIND_REGISTRY.openhands_sdk.spawn` resolves to the expected `uv` argv shape with the pinned SDK version.
    - Asserts dispatch routes a `kind: openhands_sdk` call to the subprocess path (mode === 'subprocess'), NOT to the in-proc path.
    - Asserts `PYTHONPATH` override is respected when set (mock SDK loadable).
    - Does NOT re-test init/turn/finalize/shutdown NDJSON framing — that lives in phase 03.
21. Commit: `feat(vd-2174-5): dispatch OpenHands SDK through bridge subprocess (D.21)`.

## Todo List

- [x] D.16: tool_registry.py.
- [x] D.17: model_resolver.py + tests.
- [x] D.18: event_extractor.py + tests with fixture events.
- [x] D.19: agent_factory.py.
- [x] D.20: provider.py + Layer 3 mock-SDK tests (all green).
- [x] D.21: _node_bridge.js dispatch entry + Layer 2 dispatch-resolution-only test (NDJSON round-trip is owned by phase 03).
- [x] Confirm `pytest` and `npm test` both green.

## Success Criteria

- All D.16-D.21 commits land on the feature branch.
- Layer 3 mock-SDK tests green; Layer 2 dispatch-resolution test green; full NDJSON round-trip lives in phase 03's `_node_bridge.test.js`.
- `pytest --cov=scripts/framework/providers/openhands_sdk` ≥ 70 %.
- `ruff check` + `ruff format` clean.
- No live `ANTHROPIC_API_KEY` needed for CI tests.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Phase 01 spike verdict had spec edits not applied | L | H | Re-read verdict at the start of D.16; apply any pending spec edits before touching code. |
| SDK event shape drifts (1.22.1 → newer) | M | M | Pinned in `sdk-pins.toml`; canary build in phase 09 catches drift before publish. |
| Mock SDK diverges from real SDK | M | M | Layer 4 (opt-in) scenario in phase 08 hits real API on a developer laptop / nightly job. |
| Subprocess spawn cost amplified by tool init | M | M | Phase 03 A.7 benchmark already gated; re-run after dispatch wired (D.21). |

## Security Considerations

- `tool_registry` whitelist is the security boundary — bash and file-edit tools run against the workspace dir guard from phase 07 (§7.3).
- Mock SDK module under `tests/_mock_openhands_sdk/` is loaded ONLY via test PYTHONPATH; never on the runtime path.
- Anthropic key never enters the mock module; live API is gated by phase 08 Layer 4 scenario configuration.

## Next Steps

- Unblocks phase 08 (scenarios — needs the SDK provider for `openhands-mock-multi-turn`).
- Phase 07 (cross-cutting) overlaps — workspace assertion built there protects bash/file tools spawned here.
