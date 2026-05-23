# Shared Eval Harness Design

> **Primary code:** `bin/ad-evals.js`, `scripts/framework/`

## Overview

The shared eval harness separates reusable Promptfoo/OpenCode execution mechanics from project-owned eval content. The framework owns model and tier policy, runtime environment setup, provider wiring, Promptfoo state export, config materialization, package discovery, and cleanup guards. Projects keep package configs, prompts, fixtures, assertions, and scenario rationale under `tests/evals/`.

Published to npm as `@accelerate-data/promptfoo-eval-harness`. Consumer repos install it via `npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init`.

## Design Scope

### Covers

- Promptfoo/OpenCode CLI execution through `ad-evals`.
- Suite-level model and tier policy.
- Runtime state and artifact directories.
- Package discovery and config materialization.
- Cleanup guard behavior.
- Eval-local navigation for coding agents.
- Framework extraction boundary.

### Does not cover

- Package-specific prompt quality.
- Product-specific eval assertions.
- Full regression pass rates for live model behavior.

## Key Decisions

| Decision | Rationale |
| --- | --- |
| Keep a local `ad-evals` CLI first | Proves package boundaries without taking on package publishing and cross-repo versioning in the same change. |
| Make suite-level tier policy framework-owned | Model selection, agent sizing, and OpenCode runtime options should be consistent across projects instead of duplicated in every package config. |
| Keep eval content project-owned | YAML/JSON configs, prompts, fixtures, and domain assertions change with each repo's product behavior. |
| Export Promptfoo/OpenCode state at runtime | Eval state belongs to the Git common dir and should not depend on worktree creation or symlinks. |
| Use generated resolved configs under `.tmp` | Package configs stay provider-free while Promptfoo receives concrete provider blocks for execution. |
| Continue multi-package sweeps after scenario failures | Harness validation should prove all packages execute; model assertion failures are report output, not framework execution failure. |
| Keep cleanup guard failures hard-failing | Dirtying tracked or protected eval files is a harness safety failure, not a scenario result. |
| Add `eval-map.json` for coding agents | Coding agents need a stable eval-local map before adding or changing packages, similar to repo-level `repo-map.json`. |

## Architecture

The harness entrypoint is `tests/evals/bin/ad-evals.js`. It resolves paths, prepares environment variables, creates required state/artifact directories, discovers package configs, and delegates Promptfoo execution through `scripts/framework/run-promptfoo-with-guard.js`.

The framework modules split responsibilities:

| Module | Responsibility |
| --- | --- |
| `scripts/framework/paths.js` | Resolves repo root, eval root, Git common dir, shared state dirs, and worktree-local artifact dirs. |
| `scripts/framework/environment.js` | Builds `PROMPTFOO_*`, `XDG_STATE_HOME`, `CLAUDE_PLUGIN_ROOT`, and temp-dir environment exports. |
| `scripts/framework/package-discovery.js` | Discovers package Promptfoo configs named `promptfooconfig.*` or `suite.*`. |
| `scripts/framework/eval-tier-config.js` | Loads and validates suite-owned tier policy from `config/eval-tiers.toml`. |
| `scripts/framework/resolve-promptfoo-config.js` | Rewrites package configs into resolved configs with provider blocks and stable file URLs. |
| `scripts/framework/opencode-cli-provider.js` | Adapts Promptfoo provider calls into `opencode run` invocations. |
| `scripts/framework/run-promptfoo-with-guard.js` | Splits multi-config Promptfoo calls, materializes configs, runs Promptfoo, and enforces cleanup safety. |
| `scripts/framework/roots.js` | Centralizes eval-root and repo-root constants for moved framework modules. |

## State Model

Runtime state is resolved by `scripts/framework/paths.js`:

| State | Location | Why |
| --- | --- | --- |
| Promptfoo config/database | Git common dir, `ad-evals/promptfoo` | Shared across worktrees without repo-visible symlinks. |
| OpenCode state | Git common dir, `ad-evals/opencode-state` | Reuses OpenCode runtime state across worktrees. |
| Promptfoo cache | `tests/evals/.cache/promptfoo` | Worktree-local generated artifact. |
| Promptfoo logs | `tests/evals/results/logs` | Worktree-local generated artifact. |
| Promptfoo media | `tests/evals/output/media` | Worktree-local generated artifact. |
| Temp files | `tests/evals/.tmp` | Worktree-local resolved configs and temporary files. |

`scripts/worktree.sh` no longer creates Promptfoo symlinks. Running an eval command is the dependency-resolution point for state directories.

## Package Contract

Each eval package lives under `tests/evals/packages/<package-name>/` and owns:

- `promptfooconfig.json`, `promptfooconfig.yaml`, `promptfooconfig.yml`, `suite.json`, `suite.yaml`, or `suite.yml`
- `prompt.txt` when the suite uses a prompt file
- package-specific vars, fixtures, test cases, and assertions
- exactly one `[smoke]` test case for execution validation

Package configs must define `metadata.eval_tier` and must not define `providers`. Provider wiring is injected by `scripts/framework/resolve-promptfoo-config.js` from `config/eval-tiers.toml`.

The eval-local `tests/evals/eval-map.json` records package ownership, commands, directories, framework files, and the package catalog. Deterministic tests assert discovered package configs and `eval-map.json` stay aligned.

## Command Semantics

| Command | Meaning |
| --- | --- |
| `npm test` | Runs deterministic harness and assertion contracts without live model calls. |
| `npm run doctor` | Prints resolved repo, state, cache, log, media, and temp paths. |
| `npm run eval:harness-smoke` | Runs the minimal live execution package. |
| `npm run eval:smoke` | Discovers every package config and runs each package's `[smoke]` scenario. |
| `npm run eval:regression` | Discovers every package config and runs all scenarios. |
| `npm run eval:<package>` | Runs one named package alias. |
| `npm run view` | Opens Promptfoo results using the framework-exported state. |

For multi-config sweeps, Promptfoo eval result failures use status `100`. The framework treats that as completed execution and continues through remaining packages. Non-`100` process failures and cleanup guard violations remain harness failures.

## Cleanup Guard

Promptfoo runs may write only under generated artifact roots:

- `tests/evals/.cache/`
- `tests/evals/.tmp/`
- `tests/evals/output/`
- `tests/evals/results/`

If a run creates or changes files outside those roots, the guard restores new violations when possible and exits non-zero. This protects package configs, prompts, fixtures, and assertions from accidental runtime writes.

## Extraction Boundary

Framework-owned files:

- `bin/ad-evals.js`
- `scripts/framework/**`
- framework contract tests for CLI, discovery, path/env resolution, config materialization, provider wiring, and cleanup guard
- model/tier schema conventions

Project-owned files:

- `packages/**`
- `fixtures/**`
- `assertions/**`
- `docs/scenario-inventory.md`
- `eval-map.json`
- optional package aliases in `package.json`

The next extraction step is to port a second repo without changing the framework files. The extraction notes in `docs/plans/2026-05-03-shared-eval-harness-framework-extraction-notes.md` track that checklist.

## Key Source Files

| File | Purpose |
| --- | --- |
| `tests/evals/bin/ad-evals.js` | CLI facade and command routing. |
| `tests/evals/scripts/framework/paths.js` | Runtime path/state resolution. |
| `tests/evals/scripts/framework/environment.js` | Promptfoo/OpenCode environment export. |
| `tests/evals/scripts/framework/package-discovery.js` | Package config discovery. |
| `tests/evals/scripts/framework/resolve-promptfoo-config.js` | Provider injection and resolved config writing. |
| `tests/evals/scripts/framework/run-promptfoo-with-guard.js` | Promptfoo execution, multi-config split, cleanup guard, and result status handling. |
| `tests/evals/scripts/framework/opencode-cli-provider.js` | OpenCode provider implementation. |
| `tests/evals/config/eval-tiers.toml` | Suite-level model/tier policy. |
| `tests/evals/eval-map.json` | Coding-agent navigation map. |
| `scripts/worktree.sh` | Worktree bootstrap without Promptfoo symlink ownership. |

## In-proc Node SDK dispatch (added in Phase 9.5, v1.0.1)

VD-2174-12 lands three orthogonal foundation pieces that unblock the Node-SDK-based providers (Claude Agent SDK, OpenCode SDK, Codex SDK) shipping in Phases 10/11/12.

### 1. Generic `mode === 'inproc'` dispatch in `_node_bridge.js`

`KIND_REGISTRY` now recognises a generic in-proc shape distinct from the OpenCode CLI special case:

```js
KIND_REGISTRY = {
  some_node_sdk_kind: {
    mode: 'inproc',
    module: '/abs/path/to/provider.js', // CJS or ESM
    factoryName: 'create',               // optional, defaults to 'create'
  },
  // ...
}
```

`HarnessBridgeProvider#_dispatch` detects `mode === 'inproc'` and routes through the new `_dispatchInproc(kind, registry, cfg, context, prompt, accum)` class method instead of spawning a subprocess. The lifecycle exactly mirrors the subprocess path:

1. `parseTurns(vars.turns)` — empty arrays → `errorReturn`.
2. `_ensureWorkspace(runId, caseId)` and inject `workspace_root` into the cfg passed to `init`.
3. One-time per-kind provider instantiation cached in module-level `_inprocProviderCache` (`Map<kind, providerInstance>`); `session` is created fresh per `callApi` from `provider.init(cfgWithWorkspace)`.
4. Sequential `provider.turn(session, turns[i])` calls; each turn captures latency and pushes `{ input, output, tool_calls }` into `transcript`/`turnOutputs`. Any thrown exception OR populated `res.error` object short-circuits to `errorReturn` with the appropriate `provider_error` shape.
5. `provider.finalize(session)` merges `cost_usd`, `tokens`, `transcript_summary` into the returned metadata symmetric with the subprocess path.
6. `finally{}` calls `provider.shutdown(session)` best-effort and `_cleanWorkspace(runId, caseId)`.

The existing `opencode_cli` specialized in-proc branch (lines 425-524) is untouched. The generic branch fires only when `kind !== 'opencode_cli'` AND `registry.mode === 'inproc'`. Errors flow through `normalizeErr` → `errorReturn` to keep the cfg-error / provider-error / runtime-error categorization identical across paths.

Test exports `makeBridge._clearInprocCache()` and `makeBridge._lastInprocSession()` let L2 round-trip tests inject a `test_inproc_mock` kind and assert workspace injection without polluting production state.

### 2. Hierarchical `acquire(kind?)` in `concurrency.js`

`concurrency.js` now supports an optional per-kind nested limiter. `acquire(kind)` first acquires the global gate (`AD_EVALS_MAX_CONCURRENCY`, default 4), then — if `[concurrency.<kind>]` is configured in `config/eval-tiers.toml` — acquires the kind-specific gate, returning a single `release()` that releases in reverse order. This lets a kind like `openhands_sdk` cap its own parallelism below the global without starving other kinds.

### 3. Async-aware `_python_adapter.py`

`scripts/framework/providers/_python_adapter.py` now wraps each lifecycle call through `_maybe_await(provider, name, *args, **kwargs)` which calls `inspect.iscoroutinefunction(method)` and, if true, runs the coroutine via `asyncio.run()`. The four call sites (`_handle_init`, `_handle_turn`, `_handle_finalize`, `_handle_shutdown`) plus the `finally:` shutdown in `main()` all route through the wrapper. The provider registry gains two test-only fixtures (`async_mock`, `async_mock_raising`) used by harness L2 contract tests.

These three changes ship together in v1.0.1.

## Claude Agent SDK provider (added in Phase 10, v1.1.0)

VD-2174-9 lands the first of the three Node-SDK-flavoured providers that piggyback on the Phase 9.5 generic bridge dispatch. The Claude Agent SDK is Python-only, so it runs in the subprocess branch via `_python_adapter.py`, not the in-proc branch.

### Provider matrix

| `provider_kind` | Status | Mode | Model aliases | Default-on tools | Permission gates |
| --- | --- | --- | --- | --- | --- |
| `opencode_cli` | stable | inproc (specialised) | `opencode-mock`, `opencode-anthropic` | n/a (CLI-managed) | n/a |
| `openhands_sdk` | stable | subprocess (`uv run --with openhands-sdk==1.22.1`) | `mock/openhands-mock`, `openhands/anthropic-claude-3-5-sonnet` | per agent profile | per OpenHands `MCPConfig` |
| `claude_agent_sdk` | stable | subprocess (`uv run --with claude-agent-sdk==0.2.85`) | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` (aliases: `opus`, `sonnet`, `haiku`) | `Read`, `Write`, `Edit`, `Glob`, `Grep` | `Bash` requires `permissions.allow_shell=true`; `WebSearch`, `WebFetch`, `AskUserQuestion` require `permissions.allow_web=true` |
| `opencode_sdk` | stable | inproc (`@opencode-ai/sdk@1.15.10`, requires Node ≥ 20) | `anthropic/claude-sonnet-4-6`, `openai/gpt-4o` (any model the OpenCode server accepts) | per OpenCode agent definition (`build` / `plan` / `general`) | per OpenCode agent definition |
| `codex_sdk` | planned (Phase 12 / v1.3.0) | inproc | — | — | — |

### Subprocess shape

The bridge dispatches `provider_kind=claude_agent_sdk` via `_buildSpawnSpec` which emits:

```text
uv run --python 3.12 --with claude-agent-sdk==<version> \
  python -m scripts.framework.providers._python_adapter --kind=claude_agent_sdk
```

`<version>` is read at spawn time from `scripts/framework/providers/sdk-pins.json` so consumer repos can bump the wheel without touching framework code. The adapter loads `scripts/framework/providers/claude_agent_sdk/provider.py:create()` and threads the standard `init`/`turn`/`finalize`/`shutdown` lifecycle over the existing NDJSON IPC contract.

### Single-turn vs multi-turn dispatch

The bridge threads the case-level `vars.turns.length` into `cfg.extra.total_turns` (spec §7.2). The provider branches on this at `init()` time:

- `total_turns == 1` → emits `claude_agent_sdk.query(prompt, options)` directly per turn. No `ClaudeSDKClient` is allocated.
- `total_turns > 1` → allocates a single `ClaudeSDKClient(options)` for the whole session and reuses it across every `turn()` call so conversation history (Anthropic-side prompt cache + SDK-side message log) survives turn boundaries.

The `provider.test.py::TestMultiTurn::test_multi_turn_dependency` test locks the client-identity invariant: turn 2 must observe `id(session.client) == id(client_after_t1)`.

### Tool catalogue + permission gates

`scripts/framework/providers/claude_agent_sdk/tools.py` owns the tool derivation:

- Built-in catalogue: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebSearch`, `WebFetch`, `AskUserQuestion`. Any other name in `cfg.tools[]` raises `UNSUPPORTED_TOOL`.
- Default-on (admitted even when `cfg.tools=[]`): `Read`, `Write`, `Edit`, `Glob`, `Grep`.
- Shell-gated: `Bash` admitted only if `cfg.permissions.allow_shell=true`; otherwise raises `PERMISSION_DENIED`.
- Web-gated: `WebSearch`, `WebFetch`, `AskUserQuestion` admitted only if `cfg.permissions.allow_web=true`.

The `_MODEL_ALIASES` map in `tools.py` resolves `opus`/`sonnet`/`haiku` short-forms to their pinned `claude-*-4-X` IDs; anything else raises `UNSUPPORTED_MODEL`.

### Error taxonomy

The provider maps SDK exceptions onto the contract codes:

| SDK signal | Contract code | Retryable |
| --- | --- | --- |
| `ProcessError` (exit 2 / auth) | `auth` | no |
| `CLIConnectionError` | `sdk_error` | yes |
| `asyncio.TimeoutError` (per-turn) | `LLM_TIMEOUT` | yes |
| `ToolResultMessage(is_error=True)` mid-turn | `tool_error` | no |
| `ProviderRuntimeError` from `tools.py` validation | `UNSUPPORTED_MODEL` / `UNSUPPORTED_TOOL` / `PERMISSION_DENIED` | no |

### Mock-mode scenario

Layer 4 nightly coverage lives at `tests/harness-scenarios/packages/claude-mock-multi-turn/`. `tests/_mock_claude_agent_sdk/sitecustomize.py` monkey-patches `sys.modules["claude_agent_sdk"]` with the deterministic mock from `sdk.py` so the scenario validates the full bridge → adapter → provider → mock-SDK round-trip without a live `ANTHROPIC_API_KEY`. `.github/workflows/nightly-scenarios.yml` pre-warms the real wheel into uv's cache so the mock-mode run does not pay first-fetch latency.

## In-proc Node provider — `opencode_sdk`

`provider_kind=opencode_sdk` lives at `scripts/framework/providers/opencode_sdk/provider.js` and is dispatched in-proc through Phase 9.5's `_dispatchInproc` (no subprocess, no NDJSON). The bridge's `KIND_REGISTRY` entry resolves to that module path so a single Promptfoo `file://` provider face handles all four kinds uniformly.

### Server lifecycle

`init(cfg)` calls `sdk.createOpencodeServer({ hostname: '127.0.0.1', port: 0 })` to boot an ephemeral local OpenCode server (random unprivileged port), then `sdk.createOpencodeClient({ baseUrl: server.url })`, then probes readiness via `client.session.list()` until success or `STARTUP_TIMEOUT_MS`. Each `turn()` dispatches one `client.session.prompt({ path: { id }, body: { parts: [{ type: 'text', text }], agent, model } })` against the session created in `init` so multi-turn cases share history. `shutdown()` deletes the session best-effort, then calls `server.close()` inside a `Promise.race` against a 5-second timeout with `clearTimeout` in `finally` to avoid event-loop hangs.

### Agent allowlist

`opencode_agent` from `cfg.extra` must be one of `{ build, plan, general }` (`SUPPORTED_AGENTS` in `provider.js`). Anything else raises `UNSUPPORTED_AGENT`. Default is `build` if omitted. Tool catalogue and permissions are owned by the OpenCode agent definition on the server side — the harness does not duplicate them here (unlike `claude_agent_sdk` where the harness owns tool gating).

### Error taxonomy (opencode_sdk)

The provider's `_mapError` collapses SDK exceptions onto the contract codes:

| SDK signal | Contract code | Retryable |
| --- | --- | --- |
| HTTP 400 / `e.status === 400` | `validation` | no |
| HTTP 401 / 403 or `/auth/i` in message | `AUTH` | no |
| HTTP 429 | `rate_limit` | yes |
| HTTP 5xx | `sdk_error` | yes |
| `createOpencodeServer` boot failure | `STARTUP_TIMEOUT` | no |
| Anything else | `sdk_error` | no |

### Mock-mode scenario (opencode_sdk)

Layer 4 nightly coverage lives at `tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn/`. `tests/_mock_opencode_sdk/register.mjs` uses ESM `Module.register()` to intercept `import('@opencode-ai/sdk')` for the provider, swapping it for the deterministic mock at `tests/_mock_opencode_sdk/sdk.mjs`. The nightly workflow scopes `NODE_OPTIONS=--import .../register.mjs` to a dedicated step so the loader hook never leaks into the other scenarios; that step runs the scenario via `node bin/ad-evals.js run tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn`, which routes through `dir-walk.spawnScenario` (single-scenario bypass of `EVAL_ROOT`) since the scenario lives in the framework-owned tree.

## Open Questions

1. `[extraction]` What package name and versioning policy should the standalone harness use?
2. `[extraction]` Should project-owned `eval-map.json` be hand-maintained, generated, or both?
3. `[ci]` Should CI treat `eval:smoke` status `100` as success everywhere, or only for framework-port verification jobs?
