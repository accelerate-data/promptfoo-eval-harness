---
title: "Phase 10 — Claude Agent SDK provider (v1.1.0)"
description: "Add claude_agent_sdk Python subprocess provider with async lifecycle, ClaudeSDKClient from turn 1 on multi-turn, derived allowed_tools, single provider.py."
status: pending
priority: P2
effort: ~5 days
branch: feature/vd-2174-multi-sdk-plugin-contract
tags: [claude, sdk, python, provider, multi-sdk]
created: 2026-05-23
---

# Phase 10 — Claude Agent SDK Provider (v1.1.0 / VD-2174-9)

> **Sub-issue:** VD-2174-9. **Status:** PLANNED. **Blocked by:** Phase 9.5 (async-aware adapter foundation).
> Time budget: ~5 days. **No PR raised at end of phase** (per user directive).

## Context Links

- Lead judgment applied: Skeptic #2 (async adapter — now in Phase 9.5), Skeptic #3 / Architect #6 (multi-turn `ClaudeSDKClient` from turn 1), Skeptic #8 (CI mock wiring), Skeptic #10 (Layer 2 round-trip via Phase 9.5 test), Architect #7 (derive `allowed_tools`, default web/Bash OFF), Minimalist #3 (single `provider.py`), Minimalist #6 (trim env allowlist), Minimalist #8 (drop per-provider README).
- Spike: [`spike-claude-agent-sdk-shape.md`](spike-claude-agent-sdk-shape.md) — VERDICT: PASS WITH DESIGN NOTES (2026-05-22).
- Spec: [`spec.md`](spec.md) §0.2 (Phase 2 roadmap), §1.2 (`TurnResult` / `FinalResult` / `ToolCallRecord`), §2.2 (KIND_REGISTRY), §2.5 (amended in Phase 9.5; subprocess path used by Claude), §2.6 (`_python_adapter.py` dispatch — now async-aware), §6.4 (sdk-pins.toml schema), §8.3 (Layer 3 mock-SDK pattern), §9.7 (v1.1.0 success criteria).
- Reference impl: [`phase-06-openhands-sdk-provider.md`](phase-06-openhands-sdk-provider.md) — same subprocess shape, mirror the dispatch wiring (different SDK semantics).
- Foundation: [`phase-09.5-bridge-inproc-and-hierarchical-concurrency.md`](phase-09.5-bridge-inproc-and-hierarchical-concurrency.md) — adapter now wraps async lifecycle calls with `asyncio.run()`; no per-provider work needed here.

## Overview

- **Priority:** First post-v1.0.0 SDK addition; validates the kind-dispatch contract supports a second Python SDK with async lifecycle.
- **Brief:** Build `claude_agent_sdk` as a second Python subprocess provider. Reuses `_python_adapter.py` dispatch (now async-aware after Phase 9.5); registers a new entry in `_python_adapter._PROVIDER_REGISTRY` and `_node_bridge.KIND_REGISTRY`. Multi-turn → `ClaudeSDKClient` reused from turn 1. Single-turn → stateless `query()`. Built-in tools whitelist derived from `cfg.tools` + `cfg.permissions`; web and Bash tools default OFF.
- **Out of scope:** custom MCP tools, thinking mode, streaming, Bedrock/Vertex/Foundry auth backends — all deferred to a future phase.

## Key Insights

- **SDK is `claude-agent-sdk==0.2.85`** on PyPI (alpha but stable per spike §2). Python `>=3.10,<3.14`; pin **3.12** in `sdk-pins.toml` to match openhands_sdk.
- **Multi-turn requires `ClaudeSDKClient` from turn 1** (lead-accepted per Skeptic #3 + Architect #6). The spike documents that stateless `query()` is a **new session per call** — a `ClaudeSDKClient` created on turn 2 cannot inherit turn 1's context. Provider logic: when `len(vars.turns) > 1`, instantiate the client BEFORE turn 1 (during `init` or lazily on first `turn`) and reuse for every subsequent turn. Stateless `query()` is used only when `len(vars.turns) == 1` (confirmed single-turn).
- **Async lifecycle is now safe** — Phase 9.5 made `_python_adapter.py` wrap `provider.init/turn/finalize/shutdown` with `asyncio.run()` when those methods are `async def`. Claude provider declares all four as `async def`.
- **Derived `allowed_tools`** (Architect #7): the provider does NOT pass every built-in tool through. Instead, it reads `cfg.tools` (consumer-declared) and `cfg.permissions` (consumer-declared), validates each name against the SDK's known built-in set, REJECTS unsupported names with `ProviderError(code="UNSUPPORTED_TOOL", retryable=False)`, and constructs the allowlist from the intersection. **Defaults:** `WebSearch`, `WebFetch`, `Bash` are OFF unless `cfg.permissions.allow_web === True` or `cfg.permissions.allow_shell === True` flips them on. Read/Write/Edit/Glob/Grep stay enabled by default (filesystem-only inside the phase 07 workspace guard).
- **Single `provider.py`** (Minimalist #3): collapse the originally-planned `tool_registry.py`, `agent_factory.py`, `model_resolver.py`, `event_extractor.py` into a single `provider.py` under 200 lines. If `provider.py` exceeds 200 lines after collapsing, split out ONLY `tools.py` (tool derivation + validation) — no other splits. The OpenHands template is shaped that way because OpenHands has registration ceremony; Claude does not.
- **Mock SDK (Layer 3)** patches `sys.modules["claude_agent_sdk"]` via `tests/_mock_claude_agent_sdk/sitecustomize.py` (same pattern as `tests/_mock_openhands_sdk/`).
- **CI mock parity** (Skeptic #8): nightly workflow PYTHONPATH must include `tests/_mock_claude_agent_sdk` for the Claude scenario job. Must coexist with `tests/_mock_openhands_sdk` PYTHONPATH (colon-separated list).
- **`--compare` multi-model fan-out stays deferred** to a later phase (spec §0.2 Phase 5+). v1.1.0 is provider-add-only.

## Requirements

### Functional

1. **Provider package (`scripts/framework/providers/claude_agent_sdk/`):** at most two files — `provider.py` (async lifecycle + tool derivation + event extraction) and OPTIONALLY `tools.py` (only if `provider.py` exceeds 200 lines after the collapse). Plus `__init__.py` and `provider.test.py`. **No** `tool_registry.py`, `model_resolver.py`, `event_extractor.py`, `agent_factory.py`, `README.md`.

2. **Provider class implements `SDKProvider` Protocol** from `scripts/framework/providers/_contract.py`, with `async def init/turn/finalize/shutdown`. `create()` returns the provider instance (sync factory; the lifecycle methods are async).

3. **Multi-turn lifecycle (lead-accepted per Skeptic #3 + Architect #6):**
   - `init(cfg)` builds the session container holding `{ options: ClaudeAgentOptions, client: Optional[ClaudeSDKClient], turn_count: int, total_turns_planned: int, extractor: EventExtractor }`. `total_turns_planned` is read from `cfg.extra["total_turns"]` (the bridge passes `vars.turns` length here — see Step 4 wiring).
   - If `total_turns_planned > 1`: create `ClaudeSDKClient(options)`, enter its async context, store on session. Every `turn()` calls `client.query(input)` + `client.receive_messages()`.
   - If `total_turns_planned == 1`: skip the client; `turn()` calls stateless `query(prompt=input, options=options)` directly.
   - `shutdown(session)` `await`s `client.__aexit__(None, None, None)` if open; idempotent.

4. **Event extraction (inlined in `provider.py`):** maps SDK messages to spec §1.2 shapes. `AssistantMessage.content` blocks → `TurnResult.text`; `ToolCallMessage` / `ToolResultMessage` → `ToolCallRecord(name, args, result, status)`; `ResultMessage` consumed at `finalize` → `FinalResult.cost_usd` + `FinalResult.tokens` (`result.usage.input_tokens` / `output_tokens`); `SystemMessage` / `StreamEvent` ignored for v1.1.0.

5. **Derived `allowed_tools` (Architect #7):**
   - SDK built-in set: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `AskUserQuestion` (per spike §4).
   - **Default-on:** `Read`, `Write`, `Edit`, `Glob`, `Grep` (filesystem, contained by phase 07 workspace guard).
   - **Default-off:** `Bash`, `WebSearch`, `WebFetch`, `AskUserQuestion`.
   - `cfg.tools` (consumer-declared) is intersected with the built-in set: any name NOT in the set → `ProviderError(code="UNSUPPORTED_TOOL", retryable=False)` at `init` time.
   - `cfg.permissions.allow_shell === True` adds `Bash` to the allowlist; `cfg.permissions.allow_web === True` adds `WebSearch` + `WebFetch`. If a default-off tool is in `cfg.tools` but its permission flag is False, the provider rejects with `ProviderError(code="PERMISSION_DENIED", retryable=False)`.
   - The final allowlist is passed to `ClaudeAgentOptions(allowed_tools=...)`.

6. **Model resolution (inlined in `provider.py`):** `resolve_model(name)` returns the slug unchanged if it matches the v1.1.0 supported set: raw slugs (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`) plus aliases (`opus`, `sonnet`, `haiku`). Anything else → `ProviderError(code="UNSUPPORTED_MODEL", retryable=False)`.

7. **Layer 3 mock-SDK tests (`provider.test.py`):**
   - **Single-turn case (stateless `query()` path):** init → 1 turn → finalize → shutdown. Mock `query()` async-generator yielding `AssistantMessage` + `ResultMessage`. Assert `TurnResult` shape and `FinalResult.cost_usd`/tokens populated.
   - **Multi-turn case (`ClaudeSDKClient` from turn 1):** init with `cfg.extra.total_turns = 3` → 3 turns → finalize → shutdown. Mock `ClaudeSDKClient.__aenter__/__aexit__/query/receive_messages`. Assert turn 2's `extractor.start_turn()` sees the client established before turn 1 ran (i.e. session.client is non-None at turn 1 entry).
   - **Multi-turn dependency test (Skeptic #3):** turn 1 prompts "remember the number 42"; turn 2 prompts "what number did I tell you?" — mock client's `receive_messages()` reads from a shared mock-state dict keyed by client identity, asserting turn 2 sees turn 1's context. If the provider mistakenly creates a new client on turn 2, the test fails.
   - **Failure cases:** tool-error mid-turn → `TurnResult.error` populated; malformed SDK message → `ProviderError(code="SDK_ERROR", retryable=False)`; auth error → `ProviderError(code="AUTH", retryable=False)`.
   - **Tool derivation tests:** `cfg.tools = ["Read", "Bash"]` with `cfg.permissions = {}` → `UNSUPPORTED_TOOL`? No — `Bash` is recognized but default-off → `PERMISSION_DENIED`. `cfg.tools = ["Bash"]` with `cfg.permissions = {"allow_shell": True}` → success, allowlist contains `Bash`. `cfg.tools = ["NotARealTool"]` → `UNSUPPORTED_TOOL`.

8. **`sdk-pins.toml` entry (Minimalist #6 — trimmed env allowlist):** new `[claude_agent_sdk]` section with `version = "0.2.85"`, `python = ">=3.12,<3.14"`, `extras = []`, and `env_allowlist = ["ANTHROPIC_API_KEY"]` plus only the env vars exercised by v1.1.0 tests. **Drop** `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_AWS_WORKSPACE_ID`. Re-add when a Bedrock/Vertex backend is in scope.

9. **`_python_adapter._PROVIDER_REGISTRY`:** add `"claude_agent_sdk": "scripts.framework.providers.claude_agent_sdk.provider"`. The adapter's Phase 9.5 async detection auto-discovers that `init/turn/finalize/shutdown` are coroutines and wraps with `asyncio.run`.

10. **`_node_bridge.KIND_REGISTRY.claude_agent_sdk`:** subprocess mode, `getter`-based spawn so `sdk-pins.toml` version edits propagate without code change (mirror the existing `openhands_sdk` getter at `_node_bridge.js:81-102`).

11. **Bridge passes `total_turns` to the provider (Skeptic #3 wiring):**
    - In `_node_bridge.js` subprocess branch, after `parseTurns`, add `cfgWithWorkspace.extra = { ...(cfg.extra || {}), total_turns: turns.length };` before sending the `init` IPC message.
    - The provider reads `cfg.extra.total_turns` in `init()` to decide single-turn vs multi-turn.
    - This change is generic; OpenHands SDK ignores `extra.total_turns` (no-op).

12. **CI mock parity (Skeptic #8):**
    - `.github/workflows/nightly-scenarios.yml` PYTHONPATH must include both `tests/_mock_openhands_sdk` AND `tests/_mock_claude_agent_sdk` for any scenario run that exercises Claude.
    - Pattern: `PYTHONPATH=${{ github.workspace }}/tests/_mock_openhands_sdk:${{ github.workspace }}/tests/_mock_claude_agent_sdk` (colon-separated). Both `sitecustomize.py` files coexist because each scopes its module injection to a single key in `sys.modules`.
    - Add a Claude mock scenario under `tests/harness-scenarios/packages/claude-mock-multi-turn/` (mirror `openhands-mock-multi-turn`).
    - Pre-warm step for the Claude uv cache: `uv run --python 3.12 --with claude-agent-sdk==0.2.85 python -c "import claude_agent_sdk"`.

13. **Layer 2 bridge round-trip is OWNED by Phase 9.5** (Skeptic #10): this phase does NOT add a registry-shape-only test. The Phase 9.5 round-trip test covers generic in-proc; this phase's Step 3 only asserts the `KIND_REGISTRY` entry resolves (a single-line sanity check inside `provider.test.py` to confirm `_node_bridge.js` picked up the new kind — exercised indirectly by running a scenario in CI).

### Non-functional

- Layer 3 tests run with `ANTHROPIC_API_KEY` **unset** (mock SDK has zero network).
- `ruff check` + `ruff format --check` + `npm test` + `pytest` all clean.
- Coverage `pytest --cov=scripts/framework/providers/claude_agent_sdk` ≥ 70 %.
- Subprocess cold-spawn within phase 03 A.7 budget (re-run benchmark with `--kind=claude_agent_sdk` as part of release validation).

## Architecture

```text
scripts/framework/providers/claude_agent_sdk/
├── __init__.py
├── provider.py            # async init/turn/finalize/shutdown + tool derivation + event extraction
├── provider.test.py       # Layer 3 mock-SDK (single-turn + multi-turn + multi-turn-dependency + failure + tool derivation cases)
└── tools.py               # OPTIONAL — only created if provider.py > 200 lines

tests/_mock_claude_agent_sdk/
├── __init__.py
├── sitecustomize.py       # injects mock into sys.modules["claude_agent_sdk"]
└── sdk.py                 # mock query(), ClaudeSDKClient, message classes

scripts/framework/_node_bridge.js  (modified)
  └── KIND_REGISTRY.claude_agent_sdk = {
        mode: 'subprocess', adapter: _ADAPTER_PATH,
        get spawn() { return ['uv','run','--python','3.12','--with',
          `claude-agent-sdk==${loadSdkPins().claude_agent_sdk.version}`,
          'python','-m','scripts.framework.providers._python_adapter',
          '--kind=claude_agent_sdk']; }
      }
  └── _dispatch() subprocess path: cfgWithWorkspace.extra.total_turns = turns.length

.github/workflows/nightly-scenarios.yml  (modified)
  └── PYTHONPATH: openhands_mock + claude_mock (colon-separated)
  └── Pre-warm: uv run --with claude-agent-sdk==0.2.85 python -c "import claude_agent_sdk"
  └── Scenario: tests/harness-scenarios/packages/claude-mock-multi-turn/

scripts/framework/providers/_python_adapter.py  (no change in this phase)
  └── _PROVIDER_REGISTRY["claude_agent_sdk"] = "scripts.framework.providers.claude_agent_sdk.provider"
```

## Related Code Files

- **Create:**
  - `scripts/framework/providers/claude_agent_sdk/__init__.py`
  - `scripts/framework/providers/claude_agent_sdk/provider.py`
  - `scripts/framework/providers/claude_agent_sdk/provider.test.py`
  - `scripts/framework/providers/claude_agent_sdk/tools.py` (only if `provider.py` exceeds 200 lines)
  - `tests/_mock_claude_agent_sdk/__init__.py`
  - `tests/_mock_claude_agent_sdk/sitecustomize.py`
  - `tests/_mock_claude_agent_sdk/sdk.py`
  - `tests/harness-scenarios/packages/claude-mock-multi-turn/` (full scenario: `package.yaml`, `cases/*.yaml`, fixtures)
- **Modify:**
  - `config/sdk-pins.toml` (add `[claude_agent_sdk]` section, trimmed env_allowlist)
  - `scripts/framework/providers/_python_adapter.py` (extend `_PROVIDER_REGISTRY` — single dict entry)
  - `scripts/framework/_node_bridge.js` (extend `KIND_REGISTRY`; thread `total_turns` into `cfgWithWorkspace.extra`)
  - `scripts/framework/sdk-pins.js` (expose `[claude_agent_sdk]` section if loader is section-aware)
  - `.github/workflows/nightly-scenarios.yml` (extend PYTHONPATH, add pre-warm, add scenario run)
  - `docs/design.md` (provider table — add `claude_agent_sdk` row)
  - `package.json` (bump version to `1.1.0`)
- **Delete:** none.

## Implementation Steps

### Step 1 — sdk-pins + adapter registry (additive, no behavior change yet)

1. Edit `config/sdk-pins.toml`: add `[claude_agent_sdk]` with `version="0.2.85"`, `python=">=3.12,<3.14"`, `extras=[]`, `env_allowlist=["ANTHROPIC_API_KEY"]`. (Add more env vars only when a v1.1.0 test exercises them.)
2. Edit `scripts/framework/providers/_python_adapter.py`: add `"claude_agent_sdk": "scripts.framework.providers.claude_agent_sdk.provider"` to `_PROVIDER_REGISTRY` (line ~88).
3. Commit: `feat(vd-2174-9): pin claude-agent-sdk and register adapter kind`.

### Step 2 — Mock SDK + provider module + Layer 3 tests

4. Author `tests/_mock_claude_agent_sdk/sdk.py`:
   - Mock `query()` as async generator yielding `AssistantMessage` + `ResultMessage`. Deterministic outputs keyed by prompt prefix.
   - Mock `ClaudeSDKClient` with `__aenter__`/`__aexit__`/`query()`/`receive_messages()`. Holds per-instance state so the multi-turn-dependency test can verify context persists.
   - Mock message classes: `SystemMessage`, `AssistantMessage`, `ResultMessage`, `ToolCallMessage`, `ToolResultMessage`.
   - Mock `ClaudeAgentOptions` dataclass capturing constructor kwargs.
5. Author `tests/_mock_claude_agent_sdk/sitecustomize.py`: at import time, `sys.modules["claude_agent_sdk"] = importlib.import_module("tests._mock_claude_agent_sdk.sdk")`. Coexists with `tests/_mock_openhands_sdk/sitecustomize.py` because both only set their own `sys.modules` key.
6. Author `scripts/framework/providers/claude_agent_sdk/provider.py`:
   - All four lifecycle methods declared `async def`.
   - `_derive_allowed_tools(cfg)` validates `cfg.tools` against `_BUILTIN_TOOLS`, applies the default-on/default-off table, gates `Bash`/`WebSearch`/`WebFetch` behind `cfg.permissions.allow_shell` / `allow_web`. Returns the final list or raises `ProviderError`.
   - `_resolve_model(name)` validates against the v1.1.0 set; raises `ProviderError(code="UNSUPPORTED_MODEL")` on mismatch.
   - `_EventExtractor` class (inlined): `start_turn()`, `on_message(msg)`, `end_turn() -> TurnResult`.
   - `Provider` class (exposed via module-level `create()` factory) holds `_BUILTIN_TOOLS` constant, async lifecycle methods, and the extractor.
   - `init(cfg)` reads `cfg.extra.get("total_turns", 1)`; if > 1, creates and `__aenter__`s `ClaudeSDKClient`; else leaves session.client None.
   - `turn(session, input)` routes single-turn vs multi-turn paths; drains messages through extractor; returns `TurnResult`.
   - `finalize(session)` returns `FinalResult` from last `ResultMessage`.
   - `shutdown(session)` `await`s `client.__aexit__()` if non-None; idempotent.
   - If file exceeds 200 lines after authoring, extract ONLY the tool derivation helper into `tools.py` (`_BUILTIN_TOOLS`, `derive_allowed_tools`).
7. Author `scripts/framework/providers/claude_agent_sdk/provider.test.py`:
   - Patch `sys.modules["claude_agent_sdk"]` via the mock at test setup.
   - Cases: single-turn happy / multi-turn happy / multi-turn-dependency / tool-error / malformed message / auth error / tool derivation (3 cases: unsupported tool, permission denied, permission granted) / model unsupported.
   - Use `pytest.mark.asyncio` (or `asyncio.run` directly) to drive the async lifecycle.
8. Run `pytest scripts/framework/providers/claude_agent_sdk/ -q` — green.
9. Commit: `feat(vd-2174-9): land claude_agent_sdk async provider + Layer 3 mock-SDK tests`.

### Step 3 — Bridge wiring + `total_turns` plumbing

10. Edit `scripts/framework/_node_bridge.js`:
    - Add `claude_agent_sdk` entry to `KIND_REGISTRY` with `mode: 'subprocess'`, `adapter: _ADAPTER_PATH`, and a `get spawn()` reading `loadSdkPins().claude_agent_sdk.version`. Argv: `['uv', 'run', '--python', '3.12', '--with', \`claude-agent-sdk==${version}\`, 'python', '-m', 'scripts.framework.providers._python_adapter', '--kind=claude_agent_sdk']`.
    - In the subprocess dispatch branch (~line 567), update `cfgWithWorkspace` to include `extra: { ...(cfg.extra || {}), total_turns: turns.length }` before sending the `init` IPC message.
    - **Verify** the OpenHands SDK regression suite still passes — its provider ignores `cfg.extra.total_turns`.
11. Run `npm test` — green; existing tests untouched.
12. Commit: `feat(vd-2174-9): dispatch claude_agent_sdk through bridge subprocess + thread total_turns`.

### Step 4 — Nightly CI scenario + mock-mode parity

13. Create `tests/harness-scenarios/packages/claude-mock-multi-turn/`:
    - `package.yaml`: tier=`smoke`, provider_kind=`claude_agent_sdk`, model=`claude-sonnet-4-6`.
    - Cases: one single-turn case, one multi-turn (3-turn) case where turn 2 references turn 1 ("remember 42" / "what was the number?").
    - Fixtures: mock-deterministic prompts.
14. Edit `.github/workflows/nightly-scenarios.yml`:
    - Update PYTHONPATH to colon-separated list including both `tests/_mock_openhands_sdk` and `tests/_mock_claude_agent_sdk`.
    - Add pre-warm step: `uv run --python 3.12 --with claude-agent-sdk==0.2.85 python -c "import claude_agent_sdk"`.
    - The existing `node bin/ad-evals.js run tests/harness-scenarios/packages` step picks up the new scenario automatically.
15. Run the scenario locally via the same env vars to confirm green.
16. Commit: `ci(vd-2174-9): wire claude_agent_sdk mock scenario into nightly workflow`.

### Step 5 — Doc touch + version bump

17. Update `docs/design.md` provider table to list `claude_agent_sdk` row (single line; no per-provider README).
18. Bump `package.json` version to `1.1.0`.
19. Commit: `chore(vd-2174-9): release v1.1.0 — claude_agent_sdk provider`.

## Todo List

- [ ] Step 1: sdk-pins entry (trimmed env_allowlist) + `_python_adapter._PROVIDER_REGISTRY` entry.
- [ ] Step 2a: mock SDK module + sitecustomize hook coexisting with openhands mock.
- [ ] Step 2b: `provider.py` async lifecycle + tool derivation + event extraction (single file, OPT `tools.py` if > 200 lines).
- [ ] Step 2c: `provider.test.py` — single-turn + multi-turn + multi-turn-dependency + failure + tool derivation cases all green.
- [ ] Step 3: `_node_bridge.js` `KIND_REGISTRY.claude_agent_sdk` + `total_turns` threaded through subprocess `cfgWithWorkspace.extra`.
- [ ] Step 4a: `tests/harness-scenarios/packages/claude-mock-multi-turn/` package created.
- [ ] Step 4b: `.github/workflows/nightly-scenarios.yml` PYTHONPATH + pre-warm + scenario green.
- [ ] Step 5: `docs/design.md` provider row + version bump to 1.1.0.
- [ ] Re-run phase 03 A.7 cold-spawn benchmark with `--kind=claude_agent_sdk` — within budget.
- [ ] `pytest` + `npm test` + `ruff check` + `npm run lint:md` all green.
- [ ] OpenHands SDK + OpenCode CLI providers regress green.

## Success Criteria

- All commits land on the feature branch (no PR).
- Layer 3 mock-SDK tests green INCLUDING the multi-turn-dependency case (turn 2 sees turn 1's context); a regression where the provider creates a new client on turn 2 makes the test fail.
- Tool derivation tests prove web/Bash default OFF and that consumer YAML controls them via `cfg.permissions`.
- `pytest --cov=scripts/framework/providers/claude_agent_sdk` ≥ 70 %.
- Nightly CI mock scenario runs with `ANTHROPIC_API_KEY` unset; openhands_sdk scenario still green in same job.
- Cold-spawn benchmark within phase 03 A.7 budget.
- `package.json` version → `1.1.0`.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `claude-agent-sdk` is alpha (0.x); message shapes shift before v1 | M | M | Pin exact version in `sdk-pins.toml`; canary on each version bump per spec §9.7; live Layer 4 scenario in a future phase. |
| Async lifecycle hits a hidden running loop in some environment | L | H | Phase 9.5 `_python_adapter_async.test.py` proves the round-trip; if a future production env wraps the adapter in an outer loop, switch to `asyncio.new_event_loop()` + `run_until_complete` (deferred until observed). |
| Multi-turn-dependency test passes locally but fails in CI due to mock state isolation | L | M | Mock client keys state by instance id, not by module global; isolated per test via `pytest` function scope. |
| Default-off tool list out of sync with SDK's actual built-in set in a future SDK release | M | L | `_BUILTIN_TOOLS` constant is the source of truth; canary on version bump catches drift. |
| `_node_bridge.js` `total_turns` threading breaks an existing provider that hardcodes `cfg.extra` | L | M | Existing providers ignore `cfg.extra.total_turns` (spread of `cfg.extra` preserves all existing keys). Regression suite for OpenHands SDK + OpenCode CLI must pass before commit. |

## Security Considerations

- Built-in `Read`/`Write`/`Edit` run inside the phase 07 workspace guard — no escape outside `tests/evals/.tmp/workspaces/<run_id>/<case_id>/`.
- `Bash` and web tools default OFF and require explicit `cfg.permissions.allow_shell` / `allow_web`. Lead-accepted (Architect #7) — consumers must opt in.
- Mock SDK lives under `tests/_mock_claude_agent_sdk/` and is loaded only via test-scope PYTHONPATH; never on the runtime path.
- `ANTHROPIC_API_KEY` redaction already centralized in `scripts/framework/_secret_redactor.py` (phase 07); no new redaction code needed.
- Env allowlist is the security boundary — trimmed to `["ANTHROPIC_API_KEY"]` for v1.1.0; Bedrock/Vertex/Foundry envs re-added when those backends are in scope.

## Next Steps

- Unblocks Phase 11 (OpenCode SDK provider) and Phase 12 (Codex SDK provider) — both reuse the KIND_REGISTRY extension pattern; the generic in-proc dispatch already landed in Phase 9.5.
- Custom MCP tools, thinking mode, streaming, Bedrock/Vertex auth, `--compare` fan-out remain deferred (spec §0.2 Phase 5+).

## Open Questions

- None — the lead's judgment table resolved every open item flagged in the adversarial reviews. If the SDK ships a stable v1.x within v1.1.0's life, re-evaluate the alpha-pinning strategy in a follow-on patch phase.
