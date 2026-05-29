---
title: "Phase 9.5 — Bridge in-proc dispatch + hierarchical concurrency + async adapter"
description: "Foundation phase: generic mode==='inproc' dispatch in _node_bridge.js, hierarchical acquire(kind) in concurrency.js, async-aware _python_adapter.py. No new user-visible provider."
status: complete
priority: P1
effort: ~3 days
branch: feature/vd-2174-multi-sdk-plugin-contract
tags: [bridge, concurrency, adapter, foundation, multi-sdk]
created: 2026-05-23
---

# Phase 9.5 — Bridge in-proc dispatch + hierarchical concurrency + async adapter (v1.0.1 / VD-2174-12)

> **Sub-issue:** VD-2174-12 (new, splits off the foundation work from VD-2174-9/10/11). **Status:** COMPLETE (2026-05-23).
> **Blocked by:** v1.0.0 ship (phases 01-09 complete on this branch). **Blocks:** Phase 10, 11, 12 — UNBLOCKED.
> Time budget: ~3 days (actual: 1 day). **No PR raised at end of phase** (per user directive).

## Context Links

- Lead judgment (consensus): Skeptic findings #1 + #2 + #4 + #10; Architect findings #2 + #3; Minimalist findings #2 + #9.
- Adversarial review reports:
  - `plans/260522-1649-harness-plugin-contract-design/reports/review-skeptic.md`
  - `/tmp/adversarial-review.PMCoek/architect.md`
  - `/tmp/adversarial-review.PMCoek/minimalist.md`
- Spec: [`spec.md`](spec.md) §2.1 (subprocess rationale — now relaxed for Node SDKs), §2.2 (KIND_REGISTRY shape), §2.5 (cold-spawn cost — Node in-proc skips this entirely), §4.2 (INNER global semaphore), §5.3 (multi-scenario fan-out + `PROMPTFOO_CONFIG_DIR` isolation).
- Existing in-proc reference: `scripts/framework/_node_bridge.js:425-524` (the `opencode_cli` branch that this phase generalizes).
- Async-aware adapter target: `scripts/framework/providers/_python_adapter.py:228-336` (the four `_handle_*` functions).
- Concurrency baseline: `scripts/framework/concurrency.js:80-96` (`getGlobalLimit`).

## Overview

- **Priority:** P1 — gates all three v1.x SDK additions (Claude / OpenCode SDK / Codex). The adversarial review found the bridge cannot dispatch any generic in-proc Node provider, the adapter cannot drive async Python providers, and per-kind concurrency must compose with the global cap rather than replace it.
- **Brief:** Land three orthogonal foundation changes in one phase so that Phases 10/11/12 reduce to "register the kind, ship the provider". No user-visible provider in this phase. Version bumps to `1.0.1`.
- **Three deliverables:**
  1. `_node_bridge.js` gains a generic `mode === 'inproc'` dispatch branch that loads `registry.module` (resolved absolute path) and calls its exported `create()` → `init/turn/finalize/shutdown` lifecycle, mirroring the `opencode_cli` shape but driven by registry metadata only.
  2. `concurrency.js` exposes `acquire(kind?)` that always takes the global gate first; if `kind` is provided AND `[concurrency.<kind>]` is configured in `config/eval-tiers.toml`, it ALSO takes a per-kind gate (nested, released in reverse). No `kind` AND no config → behavior is identical to today (the existing `getGlobalLimit()` path is preserved).
  3. `_python_adapter.py` detects async lifecycle handlers (via `inspect.iscoroutinefunction` on the bound provider methods) and wraps each call with `asyncio.run(...)`. Sync providers (OpenHands SDK) are unchanged.

## Key Insights

- **Spec §2.2 was drafted assuming Python subprocess for every SDK kind.** Concrete spike experience (Phases 11/12 spikes) shows that Node SDK providers are HTTP clients or thin CLI wrappers — neither benefits from a `_node_adapter.js` subprocess shim. The cold-spawn cost (spec §2.5) does not apply because the Node module loads inside the bridge process. Spec §2.5 needs a one-paragraph amendment in this phase (see Implementation Step 1).
- **The existing `opencode_cli` branch (`_node_bridge.js:425-524`) is not generic — it hardcodes `require('./opencode-cli-provider.js')` and a single-turn validation that does not belong in a generic dispatcher.** The new branch reads `registry.module`, loads it once per kind (cached in a module-level Map), and runs the full `vars.turns` loop with workspace injection and per-turn error normalization — symmetric with the subprocess path at lines 526-754.
- **Per-provider concurrency MUST NOT replace the global gate.** The existing pattern at `_node_bridge.js:409-412` wraps every `callApi` in `getGlobalLimit()`. If we switch to `acquire(kind)` alone with independent per-kind limits, total in-process concurrency can sum to `Σ kind caps` and blow past `AD_EVALS_MAX_CONCURRENCY=4`. The hierarchical primitive composes the two: global first, then per-kind, then release per-kind, then release global. Tests must prove total concurrency under mixed-kind load NEVER exceeds the global cap.
- **Async-aware adapter is the single point of change for any future Python async SDK** (Claude Agent SDK is the first; future Anthropic/Vertex/OpenAI SDKs are also async-by-default in 2026). Wrapping at the `_handle_*` boundary means each provider stays free to use `async def` or plain `def` without the adapter caring. `asyncio.run()` is safe here because the adapter is a single-threaded NDJSON loop — no parent event loop exists.
- **Backwards compatibility is non-negotiable.** OpenHands SDK (sync, Python), OpenCode CLI (sync, in-proc Node), and every Promptfoo-side caller must keep working with zero source edits. The Layer 2 bridge test must include a round-trip against the existing `opencode_cli` provider to prove no regression.

## Requirements

### Functional

1. **`_node_bridge.js` generic in-proc dispatch:**
   - `_dispatch()` detects `registry.mode === 'inproc'` and falls through to a single shared in-proc handler regardless of `kind`.
   - The handler loads `registry.module` (an absolute path resolved at registry-construction time) via `require(registry.module)`. Cached per kind in a module-level `Map<kind, providerInstance>` so repeated `callApi` invocations re-use the loaded module (no per-call require overhead).
   - The handler invokes the provider's exported lifecycle: `create()` → `init(cfg)` → `turn(session, input)` per `vars.turns` entry → `finalize(session)` → `shutdown(session)`. Lifecycle errors map to the same `ProviderError`-shaped `errorReturn(...)` already used by the subprocess branch.
   - Workspace injection (`cfgWithWorkspace`) and `transcript`/`turnOutputs`/`latencyPerTurn` recording are symmetric with the subprocess path. The existing `opencode_cli` special-case at lines 425-524 stays exactly as-is (no migration in this phase — that is a future cleanup once the generic branch has soaked).
   - The handler accepts both sync (`Promise.resolve(value)`) and async (`async function`) lifecycle exports.

2. **`concurrency.js` hierarchical `acquire(kind?)`:**
   - New exported function `acquire(kind)`. With `kind` omitted → returns a release function from the global p-limit (identical to today's `getGlobalLimit()(...)` call shape).
   - With `kind` provided → first acquires the global gate; then, IF `[concurrency.<kind>]` is configured in `config/eval-tiers.toml`, ALSO acquires the per-kind gate; release is in reverse order. If no per-kind config, behavior matches the no-kind case.
   - Per-kind p-limit instances are lazily created at first use, keyed in a `Map<kind, pLimit>`. Reading the tier config is centralized in a small helper that loads `config/eval-tiers.toml` once per process.
   - Existing `getGlobalLimit()` and `concurrency.global` exports remain unchanged. The new `acquire` function is additive; callers may continue using the legacy API.
   - **Critical invariant:** for any kind combination, total active in-process callApi count ≤ `AD_EVALS_MAX_CONCURRENCY`. Per-kind caps may only further restrict — never expand.

3. **`_python_adapter.py` async-aware lifecycle handlers:**
   - The adapter introspects the loaded provider object once after `_load_provider(kind)`. For each of `init/turn/finalize/shutdown`, it checks `inspect.iscoroutinefunction(getattr(provider, name, None))` and records a `bool` in a `_async_handlers` dict keyed by handler name.
   - Each of `_handle_init`, `_handle_turn`, `_handle_finalize`, `_handle_shutdown` consults `_async_handlers` and, when True, wraps the provider call with `asyncio.run(...)`. When False, the call is direct (today's behavior).
   - **Single asyncio loop per call.** Each `asyncio.run` runs a fresh loop in the adapter's single-threaded NDJSON read loop — there is no nested-loop hazard because the adapter never enters an event loop itself.
   - Sync providers (`openhands_sdk`, `mock`) experience zero behavior change.

4. **Layer 2 bridge round-trip test (replaces the registry-shape-only tests previously planned for Phase 10/11/12 Step 3):**
   - New file: `scripts/framework/_node_bridge.inproc-roundtrip.test.js`.
   - Registers a temporary mock kind `test_inproc_mock` in `KIND_REGISTRY` (via a test-only registry mutation helper that resets in `afterEach`).
   - Mock provider module exports `create()` returning sync `init/turn/finalize/shutdown` handlers with deterministic outputs.
   - Test assertions:
     - `HarnessBridgeProvider.callApi(prompt, { vars: { turns: '["t1","t2"]' } })` returns an output composed of two turns plus transcript metadata with `turns_completed === 2`.
     - Error path: provider's `turn()` returning `{ error: { code: "TEST_FAIL", message: "...", retryable: false } }` produces a `bridge_error`-shaped errorReturn with `turns_completed: 0` (or `i` if mid-loop).
     - Workspace path is injected into `cfg.workspace_root` for the in-proc branch (parity with subprocess path).
   - Existing `opencode_cli` regression: same suite runs a second case asserting the existing in-proc branch still works (mock-mode bypass via `OPENCODE_MOCK_MODE=1`).

5. **Hierarchical concurrency tests:**
   - New file: `scripts/framework/concurrency.hierarchical.test.js`.
   - Cases:
     - `acquire()` with no kind → caps to `AD_EVALS_MAX_CONCURRENCY` (set to 2 in test); 5 tasks scheduled, max 2 in-flight observed.
     - `acquire('kindA')` with no per-kind config → identical to no-kind case (5 tasks, max 2 in-flight).
     - `acquire('kindA')` with `[concurrency.kindA] = 1` and global = 2 → max 1 in-flight for kindA.
     - **Mixed-kind invariant:** `acquire('kindA')` AND `acquire('kindB')` with both per-kind caps = 4 each and global = 2 → total in-flight across A+B never exceeds 2 (the global cap dominates).
     - Release ordering: per-kind released before global (verified by acquiring kindA, holding global on a separate task, then releasing kindA — global stays held).

6. **Async-aware adapter tests:**
   - New file: `scripts/framework/providers/_python_adapter_async.test.py` (sibling to existing adapter tests; placement matches `_python_adapter.test.py` if present, otherwise top-level).
   - Cases:
     - Sync mock provider unchanged (regression on OpenHands path).
     - Async mock provider with `async def init/turn/finalize/shutdown` produces correct `init_ack/turn_ack/finalize_ack/shutdown_ack` NDJSON output.
     - Async provider raising in `turn` → `turn_ack` with populated `error` (same shape as sync path).

### Non-functional

- `npm test` + `pytest scripts/framework/providers/*.test.py` + `ruff check` + `ruff format --check` + `npm run lint:md` all green.
- No regression on phase 03 A.7 cold-spawn benchmark (`npm run bench:spawn-cost`) — Node-side adapter unchanged; Python adapter import-time additions limited to `inspect` (stdlib) and `asyncio` (stdlib).
- All existing v1.0.0 tests pass with zero source edits.
- Linux CI (`npm ci --no-audit --no-fund`) passes without lockfile drift — this phase adds no top-level dependencies.

## Architecture

```text
scripts/framework/_node_bridge.js  (modified)
  ├── KIND_REGISTRY                              # unchanged shape
  ├── _inprocProviderCache: Map<kind, instance>  # NEW — module-level
  ├── _dispatch()
  │     ├── if kind === 'opencode_cli'           # unchanged branch (425-524)
  │     ├── else if registry.mode === 'inproc'   # NEW generic in-proc branch
  │     │     ├── load registry.module           # cached after first call
  │     │     ├── ensureWorkspace + cfgWithWorkspace
  │     │     ├── parseTurns / validate
  │     │     ├── init → for-each turn → finalize → shutdown
  │     │     └── errorReturn on any throw / err
  │     └── else                                  # subprocess path (526-754)

scripts/framework/concurrency.js  (modified)
  ├── getGlobalLimit()           # unchanged
  ├── getOuterLimit()            # unchanged
  ├── makeConcurrencyGate(...)   # unchanged
  ├── _perKindLimits: Map<kind, pLimit>          # NEW
  ├── _loadTierConcurrencyConfig()               # NEW — reads config/eval-tiers.toml
  └── acquire(kind?)                              # NEW — hierarchical primitive
        ├── const globalRelease = await getGlobalLimit().acquire?? wrap in p-limit
        ├── if kind && perKindCap: const perKindRelease = await perKindGate(kind)
        └── return { release: () => { perKindRelease?.(); globalRelease(); } }

scripts/framework/providers/_python_adapter.py  (modified)
  ├── _load_provider(kind)                        # unchanged
  ├── _async_handlers: dict[str, bool]            # NEW — populated after load
  ├── _detect_async_handlers(provider)            # NEW — inspect.iscoroutinefunction
  ├── _maybe_await(provider, name, *args, **kw)   # NEW — central wrapper
  └── _handle_init / _handle_turn / _handle_finalize / _handle_shutdown
        └── each replaces `provider.X(...)` with `_maybe_await(provider, 'X', ...)`

config/eval-tiers.toml  (no edit in this phase; doc note only)
  # Phase 9.5 introduces [concurrency.<kind>] OPTIONAL tables. If absent,
  # behavior is identical to today. Phases 10/11/12 do NOT add any per-kind
  # caps; that decision is deferred until a real throttling failure is
  # documented (Minimalist #1).
```

## Related Code Files

- **Create:**
  - `scripts/framework/_node_bridge.inproc-roundtrip.test.js` — Layer 2 round-trip with mock in-proc provider.
  - `scripts/framework/concurrency.hierarchical.test.js` — hierarchical acquire tests.
  - `scripts/framework/providers/_python_adapter_async.test.py` — async-aware adapter tests.
  - `tests/_mock_inproc_provider/provider.js` — minimal sync mock provider for Layer 2 round-trip.
  - `tests/_mock_async_python_provider/provider.py` — minimal async Python provider for adapter tests.
- **Modify:**
  - `scripts/framework/_node_bridge.js` — add generic `mode === 'inproc'` dispatch branch + `_inprocProviderCache` Map.
  - `scripts/framework/concurrency.js` — add `acquire(kind?)`, `_perKindLimits`, `_loadTierConcurrencyConfig`, exported reset helpers for tests.
  - `scripts/framework/providers/_python_adapter.py` — add `_detect_async_handlers`, `_maybe_await`, wire into the four `_handle_*` callers.
  - `plans/260522-1649-harness-plugin-contract-design/spec.md` — §2.5 amendment paragraph (see Step 1 below).
  - `package.json` — version bump to `1.0.1` (no new dependencies in this phase).
- **Delete:** none.

## Implementation Steps

### Step 1 — Spec amendment (lands first; documents the architectural change)

1. Edit `plans/260522-1649-harness-plugin-contract-design/spec.md` §2.5. Append a clearly-marked paragraph:

   > **Amended 2026-05-23 — see Phase 9.5.** Node SDK providers may run **in-process** inside the bridge process via dynamic ESM `await import()` (for ESM-only packages) or plain CJS `require()` (for CJS-compatible packages), instead of via a `_node_adapter.js` subprocess. The generic `mode === 'inproc'` dispatch branch in `_node_bridge.js` (added in Phase 9.5) loads the provider module declared by `KIND_REGISTRY.<kind>.module` and drives the same `init/turn/finalize/shutdown` lifecycle as the subprocess path. The `_node_adapter.js` subprocess shim drawn in §2.2 for Node SDKs is NOT built; future Node SDK kinds follow the in-proc pattern unless they require sandbox isolation that only a subprocess can provide (in which case a new phase would design a Node subprocess adapter). Cold-spawn cost (this section's table) therefore applies only to Python SDK kinds and `opencode_cli`'s CLI binary — not to Node SDKs.

2. Update the §2.2 table row hints to point at Phase 9.5 for `opencode_sdk` / `codex_sdk` (single inline note — no other table edits).
3. Commit: `docs(vd-2174-12): amend spec §2.5 for in-proc Node SDK dispatch (Phase 9.5)`.

### Step 2 — Hierarchical concurrency primitive (lands before bridge wiring)

4. Edit `scripts/framework/concurrency.js`:
   - Add `_perKindLimits = new Map()` at module scope.
   - Add `_loadTierConcurrencyConfig()` that reads `config/eval-tiers.toml` once (using existing `smol-toml`); returns `{ [kind]: cap }` or `{}` on absent/invalid. Memoized.
   - Add `_resetPerKindLimits()` test helper (mirrors `_resetGlobalLimit`).
   - Add `async function acquire(kind?)`:
     - Acquire global via `await new Promise(res => getGlobalLimit()(() => new Promise(r => { res(r); })))` (standard p-limit hold-and-release pattern; if a cleaner idiom exists in current `concurrency.js`, use it). Capture the resolver as `globalRelease`.
     - If `kind` provided and `_loadTierConcurrencyConfig()[kind]` is a positive integer, lazily create / reuse `_perKindLimits.get(kind)` (cap = that integer); acquire it the same way; capture `perKindRelease`.
     - Return `{ release: () => { try { perKindRelease?.(); } finally { globalRelease(); } } }`.
5. Add `scripts/framework/concurrency.hierarchical.test.js`:
   - Use `node --test` style mirroring existing concurrency tests.
   - Test fixtures override `AD_EVALS_MAX_CONCURRENCY` via `process.env` reset and call `_resetAllLimits()` + `_resetPerKindLimits()` between cases.
   - Mixed-kind invariant test: spawn 10 tasks (5 with `kind='a'`, 5 with `kind='b'`), each task records `Date.now()` at start/end into a shared array; after `Promise.all`, walk the array and assert max overlap across both kinds ≤ global cap.
6. Run `npm test` — all existing concurrency tests still green; new file green.
7. Commit: `feat(vd-2174-12): hierarchical acquire(kind?) in concurrency.js`.

### Step 3 — Async-aware Python adapter

8. Edit `scripts/framework/providers/_python_adapter.py`:
   - Add `import asyncio` and `import inspect` at the top (with the other stdlib imports).
   - After `_load_provider(kind)` in `main()` (line ~149), add `_async_handlers = _detect_async_handlers(provider)` and pass the dict into each `_handle_*` invocation OR store it on a module-level singleton (single-process adapter, single provider — module-level is fine and simpler).
   - Define `_detect_async_handlers(provider) -> dict[str, bool]`: for each of `init`, `turn`, `finalize`, `shutdown`, set `bool(inspect.iscoroutinefunction(getattr(provider, name, None)))`.
   - Define `_maybe_await(provider, name, *args, **kwargs)`: if `_async_handlers[name]` → `return asyncio.run(getattr(provider, name)(*args, **kwargs))`; else → `return getattr(provider, name)(*args, **kwargs)`.
   - In `_handle_init`: replace `session = provider.init(cfg)` → `session = _maybe_await(provider, "init", cfg)`.
   - In `_handle_turn`: replace `result: TurnResult = provider.turn(session, message)` → `result: TurnResult = _maybe_await(provider, "turn", session, message)`.
   - In `_handle_finalize`: replace `result_f: FinalResult = provider.finalize(session)` → `result_f: FinalResult = _maybe_await(provider, "finalize", session)`.
   - In `_handle_shutdown`: replace `provider.shutdown(session)` → `_maybe_await(provider, "shutdown", session)`.
   - In the `finally:` block at end of `main()`: replace the loop body `provider.shutdown(sess)` → `_maybe_await(provider, "shutdown", sess)`.
9. Create `tests/_mock_async_python_provider/provider.py`:
   - Exports `create()` returning an object with `async def init(cfg)`, `async def turn(session, message)`, `async def finalize(session)`, `async def shutdown(session)`. Deterministic outputs (echo prompt prefix).
10. Add `scripts/framework/providers/_python_adapter_async.test.py`:
    - Drives the adapter via subprocess (`uv run python -m scripts.framework.providers._python_adapter --kind=async_mock`).
    - Registers the mock kind by patching `_PROVIDER_REGISTRY` via a small test helper module loaded on PYTHONPATH (mirror `tests/_mock_provider`).
    - Asserts NDJSON round-trip: send `init` → `init_ack`; send `turn` → `turn_ack` with expected `text`; send `finalize` → `finalize_ack`; send `shutdown` → `shutdown_ack`.
    - Error case: async `turn` raises → `turn_ack.error` populated.
11. Add `"async_mock": "tests._mock_async_python_provider.provider"` to `_PROVIDER_REGISTRY` in `_python_adapter.py` (or expose a `--registry-extra=<module>` arg if that pattern matches the existing mock — mirror the `mock` kind treatment).
12. Run `pytest scripts/framework/providers/ -q` and `ruff check`. Green.
13. Commit: `feat(vd-2174-12): async-aware lifecycle in _python_adapter.py`.

### Step 4 — Generic in-proc dispatch branch in `_node_bridge.js`

14. Edit `scripts/framework/_node_bridge.js`:
    - Add a module-level `const _inprocProviderCache = new Map();` near the top of the file.
    - In `_dispatch()`, after the existing `opencode_cli` early-return at lines 425-524 and before the SDK subprocess block at line 526, insert a new branch:

    ```js
    // -----------------------------------------------------------------------
    // Generic in-proc dispatch (Phase 9.5) — any kind whose registry entry has
    // mode === 'inproc' and a module path. opencode_cli stays on its own
    // branch above to preserve v1.0.0 semantics; future cleanup may unify.
    // -----------------------------------------------------------------------
    const registry = KIND_REGISTRY[kind];
    if (registry.mode === 'inproc' && registry.module) {
      return await this._dispatchInproc(kind, registry, cfg, context, prompt, {
        startedAt, transcript, turnOutputs, latencyPerTurn,
      });
    }
    ```

    - Add `_dispatchInproc(kind, registry, cfg, context, prompt, accum)` method on the class:
      - Parse turns (same `parseTurns(context?.vars?.turns, prompt)` call).
      - Empty-turns validation → return validation `errorReturn` (mirror lines 535-548).
      - Ensure workspace via `_ensureWorkspace(runId, caseId)`; build `cfgWithWorkspace`.
      - Load provider once: `let provider = _inprocProviderCache.get(kind); if (!provider) { const mod = require(registry.module); provider = await mod.create(); _inprocProviderCache.set(kind, provider); }`.
      - Lifecycle: `const session = await provider.init(cfgWithWorkspace);` then for each turn: `const turnStart = Date.now(); const res = await provider.turn(session, turns[i]);` — record latency, push transcript entry, route errors through `normalizeErr` + `errorReturn`. After all turns: `const final = await provider.finalize(session); await provider.shutdown(session);`.
      - Return shape symmetric with the subprocess path (`output`, `metadata` with `transcript`, `turns_completed`, `final_turn_output`, `latency_ms_per_turn`, `latency_ms_total`, plus any `final.metadata` merged into `baseMetadata`).
    - Wrap the new branch in the EXISTING global gate at line 411-412 — `_dispatch()` is already called via `globalGate(...)` so no change there. **Do NOT** call `concurrency.acquire(kind)` in this phase — that is a future opt-in once a real failing scenario justifies per-kind caps (per lead judgment dropping Phase 12 concurrency feature).

15. Add `tests/_mock_inproc_provider/provider.js`:
    - `module.exports.create = async () => ({ async init(cfg) { return { count: 0, cfg }; }, async turn(s, input) { s.count += 1; return { output: \`echo: ${input}\` }; }, async finalize(s) { return { metadata: { cost_usd: 0, tokens: { input: 1, output: 1 } } }; }, async shutdown(_s) {} });`
    - Error variant exposed via a second export `module.exports.createWithTurnError = async () => ({ ...init/turn that returns `{ error: { code: 'TEST_FAIL', message: 'forced', retryable: false } }`... });`.

16. Add a small test-only registry mutation helper at the top of `_node_bridge.inproc-roundtrip.test.js`:
    - Import the bridge module; reach into `KIND_REGISTRY` to inject `test_inproc_mock = { mode: 'inproc', module: path.resolve(__dirname, '..', '..', 'tests', '_mock_inproc_provider', 'provider.js') }`; restore in `afterEach`.

17. Author `scripts/framework/_node_bridge.inproc-roundtrip.test.js`:
    - Case 1 — happy path 2-turn round-trip: instantiate `HarnessBridgeProvider({ config: { provider_kind: 'test_inproc_mock', model: 'mock' } })`, call `callApi('ignored', { vars: { turns: JSON.stringify(['hello', 'world']) } })`, assert `result.metadata.turns_completed === 2`, `result.metadata.transcript.length === 2`, no `result.error`.
    - Case 2 — error mid-turn: swap to `createWithTurnError`, assert `result.error` matches the forced error code/message and `turns_completed === 0`.
    - Case 3 — workspace injection: stub `process.env.AD_EVALS_RUN_ID` and `case_id`; assert the mock provider received `cfg.workspace_root` matching the per-case workspace path.
    - Case 4 — `opencode_cli` regression: with `OPENCODE_MOCK_MODE=1`, call `callApi('hi', { vars: {} })` with `provider_kind: 'opencode_cli'` — assert the existing branch still returns the mock string.

18. Run `npm test` — all existing tests + new file green.
19. Commit: `feat(vd-2174-12): generic mode==='inproc' dispatch in _node_bridge.js + Layer 2 round-trip test`.

### Step 5 — Version bump + cross-references

20. Bump `package.json` version to `1.0.1`.
21. Update `docs/design.md` (single short section, "In-proc Node SDK dispatch (added in Phase 9.5)") describing the registry shape and the cache.
22. Update `plans/260522-1649-harness-plugin-contract-design/plan.md` overview table (see deliverable #5 in this rework batch).
23. Commit: `chore(vd-2174-12): release v1.0.1 — bridge in-proc + hierarchical concurrency + async adapter foundation`.

## Todo List

- [ ] Step 1: spec §2.5 amendment paragraph + §2.2 table inline note.
- [ ] Step 2a: `concurrency.js` `acquire(kind?)` + `_perKindLimits` + tier config loader.
- [ ] Step 2b: `concurrency.hierarchical.test.js` green (incl. mixed-kind invariant).
- [ ] Step 3a: `_python_adapter.py` `_detect_async_handlers` + `_maybe_await` wired into all four handlers + finally block.
- [ ] Step 3b: `tests/_mock_async_python_provider/provider.py` + `_python_adapter_async.test.py` green.
- [ ] Step 4a: `_node_bridge.js` `_dispatchInproc` method + cache Map.
- [ ] Step 4b: `tests/_mock_inproc_provider/provider.js` (happy + error variants).
- [ ] Step 4c: `_node_bridge.inproc-roundtrip.test.js` green (4 cases).
- [ ] Step 5: docs/design.md note + plan.md table edit + version bump to 1.0.1.
- [ ] Full regression: `npm test`, `pytest`, `ruff check`, `npm run lint:md`, `npm run bench:spawn-cost` (no regression) all green.
- [ ] OpenCode CLI + OpenHands SDK v1.0.0 tests untouched and green.

## Success Criteria

- All commits land on the feature branch (no PR).
- New Layer 2 round-trip test asserts full `callApi → init → 2 turns → finalize → shutdown` against a mock in-proc provider, plus one error path.
- `concurrency.hierarchical.test.js` mixed-kind invariant test passes: total in-flight ≤ global cap regardless of per-kind caps.
- `_python_adapter_async.test.py` proves async lifecycle works; OpenHands SDK regression suite still green.
- `package.json` version → `1.0.1`. No new top-level dependencies.
- `docs/design.md` describes the in-proc dispatch shape; `spec.md` §2.5 carries the amendment paragraph; `plan.md` overview lists Phase 9.5.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `_inprocProviderCache` retains state across `callApi` calls and leaks across cases | M | H | The cache holds the module-level **provider instance** (with `create()` already called), but `session` is per `init()` and is held only inside `_dispatchInproc`. After `shutdown()`, session is garbage-collected. Add a Layer 2 test asserting two sequential calls do not share session state. |
| `asyncio.run()` inside a synchronous adapter triggers "asyncio.run() cannot be called from a running event loop" | L | H | The adapter never enters an event loop itself (single-threaded `readline` loop). Verified by `_python_adapter_async.test.py`. If a future provider tries to wrap the adapter in its own loop, that is a provider bug, not an adapter bug. |
| Per-kind p-limit acquired AFTER global creates a deadlock window | L | M | Hold ordering is fixed: global → per-kind → release per-kind → release global. Single-process, no cross-process contention. Mixed-kind concurrency test exercises this directly. |
| Bridge mutates `KIND_REGISTRY` for tests and leaks across test files | L | M | All registry mutations happen inside `beforeEach`/`afterEach` blocks; the helper deletes the test-injected key in `afterEach`. CI runs files in isolated worker processes via `node --test`, so even a missed cleanup does not corrupt other files. |
| Future Phase 12 (Codex) discovers a real failing scenario that needs per-kind caps | M | L | Phase 9.5 ships the primitive; the per-kind config table in `eval-tiers.toml` is intentionally NOT added by any of Phase 10/11/12. A future patch phase adds the config when a failing scenario is documented (per lead judgment dropping Phase 12 concurrency feature). |

## Security Considerations

- The in-proc dispatch branch loads provider modules via `require(registry.module)` where `registry.module` is an **absolute path** resolved at registry-construction time inside `_node_bridge.js`. No runtime path concatenation from user input. Adding a new kind requires editing `KIND_REGISTRY` in committed source — same audit trail as today.
- Async adapter wrapping uses stdlib `asyncio.run()` only — no new dependencies, no exec/eval. Provider methods retain whatever sandboxing they had under sync invocation.
- Hierarchical `acquire` reads tier config from `config/eval-tiers.toml` (already in-repo, framework-owned). No env-var override of per-kind caps in this phase — keeps the surface small. Consumers cannot inject per-kind caps via YAML.
- Existing redaction (`_secret_redactor.js`, phase 07) continues to run in the bridge's `normalizeErr` path; the new branch reuses `normalizeErr` and `errorReturn`, so no redaction gap.

## Next Steps

- **Unblocks Phase 10** (Claude Agent SDK) — provider can now use `async def` lifecycle handlers without adapter changes; falls back to the existing subprocess path (still Python).
- **Unblocks Phase 11** (OpenCode SDK) — registry-only registration of `mode: 'inproc'` is sufficient; the dispatch branch is already proven by the Layer 2 round-trip test.
- **Unblocks Phase 12** (Codex SDK) — same dispatch branch; per-kind concurrency primitive is available but unused in v1.3.0 ship.
- Future patch phase may unify `opencode_cli` into the generic in-proc branch (drop lines 425-524) once Phase 11 has soaked. Not in scope here.

## Open Questions

- Should `_inprocProviderCache` be flushed at process exit (`process.on('exit')`) to call `shutdown()` on any orphaned sessions? Today the OS reaps the process; if a provider holds external state (e.g. a TCP connection pool), explicit flush would be cleaner. Defer until a real provider needs it.
- Should the spec §2.2 row hints for `opencode_sdk` / `codex_sdk` be rewritten to say "inproc Node module" instead of "spawn node `_node_adapter.js`"? The amendment paragraph in §2.5 covers it, but the table row is now stale. Decision: leave the table row as historical and rely on the §2.5 amendment as the audit trail (matches the lead's "small one-paragraph amendment" instruction). A future spec v9 may rewrite the table.
