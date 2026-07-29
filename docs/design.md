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

Package configs must define `metadata.eval_tier` and must not define `providers`. Provider wiring is injected by `scripts/framework/resolve-promptfoo-config.js` from `config/eval-tiers.toml`. This holds for multi-turn packages too: a v0-tier package whose tests declare `vars.turns` auto-routes to the SDK bridge using the top-level `[multiturn]` block (the single-turn tier CLI provider cannot drive `vars.turns`), so it still declares only `metadata.eval_tier`. See `docs/setup.md` → "Tier-driven multi-turn".

`resolveConfigFile()` enforces this contract: a package config that declares its own `providers` throws immediately, before any v0/v1/multiturn resolution runs, regardless of which tier-config shape `config/eval-tiers.toml` uses. Before this check existed (VD-3792), a package-level `providers` array was silently discarded and replaced by the tier-derived block with no warning — a package could declare, say, its own OpenHands/Docker provider and never actually run against it, with no signal that a substitution had occurred. A package that needs an OpenHands-backed run must migrate `config/eval-tiers.toml` to the v1 shape and give the relevant tier a `provider_kind = "openhands_agent_server"` (or `openhands_sdk`) entry instead of declaring its own `providers` block.

### Package-declared-providers validation (VD-3792)

**Functional spec:** [`docs/functional/vd-3792-provider-declaration-validation/README.md`](functional/vd-3792-provider-declaration-validation/README.md) (AC-1 – AC-5).

**Decision.** The check lives at the very top of `resolveConfigFile()`, immediately after `readYaml()` parses the package config and before `_isV1RawShape`/`_hasMultiTurnTest` branching or the `metadata.eval_tier` presence check. Placing it there — rather than duplicating it inside each of the three resolution branches (v0, v1, multiturn) — means one guard clause covers all three paths (AC-1, AC-2, AC-3) with no risk of a future fourth branch forgetting to include it.

**Check.** `if (parsed.providers) throw new Error(...)`. Truthy-check, not `Array.isArray`, so a malformed non-array `providers` value is caught too — the point is "the package declared this key at all," not "declared it correctly."

**Error message (AC-4).** Includes the normalized package path, names both `providers` and `metadata.eval_tier`, and states the fix:

```text
${normalizedPath} declares its own "providers" array, which the framework silently discards — remove it and rely on metadata.eval_tier (see docs/design.md § Package Contract).
```

**Non-goal (AC-5).** No change to the success path — a config without `providers` flows through v0/v1/multiturn resolution exactly as before. The new `providers` key this function returns (the tier-derived block) is a distinct value assigned after the check passes; the check never inspects the resolver's own output.

#### Key source files

| File | Purpose |
| --- | --- |
| `scripts/framework/resolve-promptfoo-config.js` | `resolveConfigFile()` gains the guard clause. |
| `scripts/framework/resolve-promptfoo-config.test.js` | New `assert.throws` coverage for AC-1/AC-2/AC-3/AC-4, plus a no-`providers` regression case for AC-5. |
| `CHANGELOG.md` | New `[1.6.0] — TBD` section; `package.json` bump 1.5.0 → 1.6.0. |

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
| `codex_sdk` | stable | inproc (`@openai/codex-sdk@0.133.0` + `@openai/codex@0.133.0` CLI bin, requires Node ≥ 20) | `gpt-4o`, `gpt-4.1` (any model the Codex SDK accepts) | per Codex CLI sandbox/reasoning profile | `sandbox_mode` ∈ `{read-only, workspace-write, danger-full-access}`; `model_reasoning_effort` ∈ `{low, medium, high}` |
| `openhands_agent_server` | stable | wrapper Node (`framework://openhands-agent-server-provider.js`); CLI auto-manages a `uvx --from openhands-agent-server@<pin> agent-server` daemon on a free `127.0.0.1` port and injects `OPENHANDS_SERVER_URL` | LiteLLM-prefixed (`openai/...`, `anthropic/...`, gateway-shaped slugs) | per adapter's `agent` map entry in `openhands.json` | adapter block (`agent_id`, `agent_entrypoint_file`, `agent_semantics`, `eval_mode_preamble`) is required; see "Daemon-Lifecycle Providers" below |

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

Auto-start is the only supported path: callers should not spawn `opencode serve` ahead of time. Each `provider_kind=opencode_sdk` provider instance owns exactly one server with a dynamic port (Phase 9.5 caches one instance per run; parallel cases share that one server via per-case `session.create`).

### Cleanup contract (v1.3.3)

`shutdown()` already closes the in-proc server in its `finally` block once per case, but unhandled signals or `uncaughtException` previously left the spawned `opencode serve` child process orphaned. v1.3.3 adds a module-scoped `_activeServers` registry plus a one-time `_installSignalHooks()` arming step inside `init()`:

- Every successful `init()` registers `{server, port, url}` in `_activeServers` and calls `_installSignalHooks()` (idempotent via `_signalHooksInstalled`).
- `shutdown()` always deregisters the server after `_stopServer()` finishes — both the timer-finally branch and the no-close-fn branch.
- `process.on('exit')` and `process.once('SIGINT'|'SIGTERM')` re-raise the signal after draining; `process.once('uncaughtException')` drains then exits with code 1 so no orphan child outlives the harness.
- `_drainActiveServers()` and `_activeServerCount()` are exposed for tests (`scripts/framework/providers/opencode_sdk/cleanup.test.js`) — NOT a stable public surface.

Net effect: every harness run auto-starts a fresh server on a dynamic port AND guarantees that server is killed — by per-case `finally`, by signal, or by `uncaughtException` — before the harness process exits.

### Response shape (SDK v1.15.10)

Every `client.session.*` call returns `{data, request, response}` on success or `{error, request, response}` on failure. The provider reads `createResp.data.id` for the session id, `promptResp.data.parts` for the assistant parts, and `final.data.{cost, tokens, title}` in finalize. `session.prompt` requires `body.model` to be a `{providerID, modelID}` object — harness configs carry the model as a `"providerID/modelID"` string and `_parseModel` in `provider.js` splits on the first `/` before sending. (v1.3.2 hotfix; legacy `info.id` / `info.parts` fallbacks are retained for the test mock and any future shape regressions.)

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

## In-proc Node provider — `codex_sdk`

`provider_kind=codex_sdk` lives at `scripts/framework/providers/codex_sdk/provider.js` and is dispatched in-proc through Phase 9.5's `_dispatchInproc` (no subprocess, no NDJSON). The bridge's `KIND_REGISTRY` entry resolves to that module path so a single Promptfoo `file://` provider face still covers all five kinds uniformly. The real `@openai/codex-sdk@0.133.0` is ESM-only (`"type": "module"` with `import`-only `exports`), so the provider does `await import('@openai/codex-sdk')` lazily inside `init()` — tests intercept the resolution through an ESM `Module.register` loader hook installed by `tests/_mock_codex_sdk/register.mjs` (v1.3.1 hotfix; v1.3.0 had a CJS `Module._resolveFilename` patch which could not resolve the real package against its `exports` field).

### Session and workspace isolation

`init(cfg)` reserves a per-session HOME directory via `mkdtempSync` (prefix `ad-evals-codex-home-`) so concurrent `codex_sdk` cases never share auth/config state — the Codex SDK reads HOME from `opts.env.HOME`, and the provider forwards `process.env` with `HOME` overridden to the per-session temp dir. The first `turn()` then lazily `mkdtemp`s a per-case workspace under the run's `workspace_root` and runs `git init -q --initial-branch=main` followed by `git commit --allow-empty -q -m init` with inline `-c user.email=ad-evals@local -c user.name="AD Evals"` so codex's `skipGitRepoCheck: false` accepts the workdir without depending on whatever global git identity is configured on the host. `shutdown()` best-effort removes the per-case workspace AND the per-session HOME directory.

### Thread reuse for multi-turn

A single `Codex` instance is constructed in `init()`. The first `turn()` calls `codex.startThread({ workingDirectory, sandboxMode, model, modelReasoningEffort })` and stores the returned `Thread` on the provider instance. Subsequent `turn()` calls reuse the same `Thread` via `thread.run({ input })`, which is how the SDK propagates conversation history across turns. `provider.test.mjs` locks this with a 3-turn dependency test (turn 1 stores `42`, turn 3 must recall it from the mock SDK's per-thread state).

### Defaults and overrides

`sandbox_mode` defaults to `workspace-write` (writes confined to the per-case workspace) and `model_reasoning_effort` defaults to `medium`. Both can be overridden through `cfg.extra.sandbox_mode` / `cfg.extra.reasoning_effort` per case. `cfg.model` is forwarded to `startThread({ model })` unchanged — any model alias accepted by the Codex SDK works; the harness does not maintain a separate alias table.

### Error taxonomy (codex_sdk)

The provider's `_mapError` collapses SDK exceptions onto the contract codes:

| SDK signal | Contract code | Retryable |
| --- | --- | --- |
| HTTP 400 / `e.status === 400` | `validation` | no |
| HTTP 401 / 403 or `/auth/i` in message | `AUTH` | no |
| HTTP 429 | `rate_limit` | yes |
| HTTP 5xx | `sdk_error` | yes |
| Inline `UNSUPPORTED_MODEL` raised by SDK | `UNSUPPORTED_MODEL` | no |
| `git init`/`mkdtemp` failure during workspace setup | `WORKSPACE_SETUP` | no |
| Anything else | `sdk_error` | no |

### Mock-mode scenario (codex_sdk)

Layer 4 nightly coverage lives at `tests/harness-scenarios/packages/codex-sdk-mock-multi-turn/`. `tests/_mock_codex_sdk/register.mjs` calls `Module.register('./loader.mjs', import.meta.url)`; the loader rewrites the bare specifier `@openai/codex-sdk` to the deterministic mock at `tests/_mock_codex_sdk/sdk.mjs` so neither the real `@openai/codex-sdk` nor the `@openai/codex` CLI bin is spawned. The nightly workflow scopes `NODE_OPTIONS=--import file://.../register.mjs` (matching the ESM-only shape of the real package, same as `opencode_sdk`) to a dedicated step so the hook never leaks into the other scenarios; that step runs the scenario via `node bin/ad-evals.js run tests/harness-scenarios/packages/codex-sdk-mock-multi-turn`, which routes through `dir-walk.spawnScenario` (single-scenario bypass of `EVAL_ROOT`) since the scenario lives in the framework-owned tree.

## Daemon-Lifecycle Providers

Some `provider_kind`s need a long-lived child process for the duration of a single eval run. `openhands_agent_server` is the first such kind. It **bypasses `_node_bridge.js` entirely** — there is no entry in `_KIND_REGISTRY` for it. The lifecycle is owned by the CLI; the in-Promptfoo runtime just speaks REST + WebSocket to the daemon.

Three pieces wire it together:

1. **Resolver branch** — `scripts/framework/resolve-promptfoo-config.js` detects `provider_kind = "openhands_agent_server"` in a normalised tier and emits the wrapper provider URL `framework://openhands-agent-server-provider.js` (resolved against `FRAMEWORK_ROOT`) instead of the standard bridge URL. Consumer fields (`agent`, `openhands_config`, `model`) are preserved at the top level of `entry.config`, the same field-placement shape every bridge-routed `provider_kind` now uses (VD-3912) — there is no `provider_options` bag anywhere in the emitted shape.
2. **Lifecycle module** — `scripts/framework/agent-server-lifecycle.js` exports `startAgentServerDaemon({ openhandsJsonPath, internals? })` and `stopAgentServerDaemon(handle)`. `start` allocates a free `127.0.0.1` port via `net.createServer().listen(0)`, spawns `uvx --with libtmux --with "openhands-tools==<pin>" --from "openhands-agent-server==<pin>" agent-server --host 127.0.0.1 --port <port>` as a detached process group, polls `/health` until the daemon is ready (default 30 s budget), and returns a handle `{ url, pid }`. A `ACTIVE_HANDLES` set enforces a single daemon per run; `stop` issues `SIGTERM` to the process group, waits ≤5 s, then `SIGKILL`. The `internals` parameter (`spawn`, `allocateFreePort`, `processKill`, `httpGet`) is the test seam — production passes `_defaultInternals`.
3. **CLI hooks** — `bin/ad-evals.js`, after `runTierConfigValidation` and before `runPromptfooWithGuard`, calls `_anyTierUsesAgentServer(normalised)`; if true, it boots the daemon via the lifecycle module, mutates `process.env.OPENHANDS_SERVER_URL = handle.url`, logs `[ad-evals] agent-server ready on http://127.0.0.1:<port> (<ms>ms)`, then runs promptfoo. A `finally` block restores the prior `OPENHANDS_SERVER_URL` value and tears the daemon down.

The wrapper provider (`scripts/framework/openhands-agent-server-provider.js`) speaks the documented OpenHands 1.21.x REST + WebSocket contract. It reads `OPENHANDS_SERVER_URL` from the env (non-empty string wins over `openhands.json:openhands_server_url`, which is now omitted from templates). Model precedence is `OPENHANDS_MODEL_OVERRIDE` (env) > `this.config.model` (resolver-injected) > `cfg.agent[agent].model` (openhands.json fallback). For manual debugging without the CLI, set `OPENHANDS_SERVER_URL` in the shell — the provider will speak to whatever 127.0.0.1 daemon you started by hand. If the WS event stream goes silent for `OPENHANDS_STREAM_IDLE_TIMEOUT_MS` ms (default 900000 / 15 min), the provider concludes the turn with whatever partial output it has collected instead of hanging until the outer promptfoo timeout — the same watchdog behavior as the legacy `openhands-provider.js` this provider is replacing (VD-3814).

Daemon-lifecycle kinds today: `openhands_agent_server`.

## Plugin Glue Providers (v1.5.0, VD-2174-12)

Plugin glue providers are thin `framework://` wrappers that compose
existing bridge-routed kinds with auto-reply gates, plugin discovery,
workspace metadata, and parser hooks. They were ported into the harness
from the `vibedata-data-engineering` consumer so other repos can pin a
published version instead of vendoring per-repo glue.

### Provider Wrappers vs Bridge

| Choose a wrapper (`framework://*-provider.js`) when… | Choose a bridge `provider_kind` directly when… |
| --- | --- |
| The scenario needs plugin-runtime metadata (`provider.json`, trajectory), bootstrap prefix injection, or auto-reply handling. | The scenario is a plain single-turn or multi-turn case with no plugin gluing. |
| The provider must surface `agent_id` / `agent_entrypoint_file` in run telemetry. | Run telemetry is not required. |
| A custom parser (`opencode_parser_module`) or capture-on-failure semantics are needed. | Default OpenCode CLI behavior is sufficient. |
| The Claude SDK call must stream input across multiple turns with `AskUserQuestion` auto-reply. | Single-turn Python bridge dispatch (`uv run`) is enough. |

All wrappers consume the same `[runtime]` allowlist (see
[setup guide](setup.md#plugin-glue-provider-runtime-fields-v150)).

### Two Claude Agent SDK Transports

The Claude Agent SDK ships in two transports that **coexist** in v1.5.0;
pick by characteristics, not by name:

| | `claude_agent_sdk` (Python bridge) | `claude_agent_sdk_node` (Node wrapper) |
| --- | --- | --- |
| Module | `scripts/framework/providers/claude_agent_sdk/provider.py` via `_python_adapter.py` | `scripts/framework/claude-agent-sdk-provider.js` (in-proc) |
| Spawn | `uv run --with claude-agent-sdk==0.2.85` (subprocess) | none (in-proc) |
| Multi-turn | `ClaudeSDKClient` reused across turns inside the Python adapter | streaming-input async generator inside the Node wrapper |
| `AskUserQuestion` handling | tool gate via `permissions.allow_web=true`; surfaces as `tool_error` if absent | auto-reply with `auto_reply_text` up to `max_auto_replies`; logs to `qa-log.jsonl` |
| Plugin discovery | not supported | walks `plugin_subdirs` relative to `EVAL_ROOT` |
| Idle-turn termination | n/a (Python bridge handles its own lifecycle) | configurable via `idle_turn_stop` |
| Output capture | `transcript_summary` from `finalize()` | per-turn `qa-log.jsonl` plus final `provider.json` |
| When to choose | single-turn or non-plugin multi-turn cases needing native SDK semantics | scenarios that need bootstrap prompts, auto-replies, plugin manifests, or trajectory emission |

The two transports MAY appear in the same scenario suite — they share no
state. The `claude_agent_sdk_node` wrapper does NOT go through the
Promptfoo bridge; it returns a plain `{id, label, callApi}` provider.

### OpenCode CLI: Base + Sibling

`scripts/framework/opencode-cli-provider.js` is the locked §7.4 contract.
The framework refuses ANY edit — even a `module.exports` re-export — and
the byte-identity guard
(`opencode-cli-plugin-provider.test.js` → "base file ... is byte-identical")
fails if the parent SHA stored in `tests/_fixtures/phase-04-parent.sha`
no longer matches `HEAD` for that file.

Plugin features live in a **sibling**, not a subclass:

```text
scripts/framework/
├── opencode-cli-provider.js          ← BASE, locked, no edits ever
└── opencode-cli-plugin-provider.js   ← SIBLING (Shape B wrapper factory)
```

The sibling re-uses the base's `runOpenCode` export and shares the
`OPENCODE_RUNNER_COMMAND` resolution, but it owns its own:

- `TRANSPORT_NAME = 'opencode_cli_plugin'` for concurrency gating
- bootstrap-prompt prefix
- plugin-link detection (`opencode_plugin_link_path`)
- run metadata (`write_run_metadata` → `.eval-run/provider.json`)
- parser hook (`opencode_parser_module`) supporting both module shapes
  (`module.exports = fn` and `module.exports = { parseOpenCodeJsonStream }`)
- empty-output retry loop (inlined because the base helper is
  module-local)

A Shape A subclass was rejected during phase-04 (codex round-2,
finding 3) because the base's `callApi` delegates to a module-local
`callWithEmptyOutputRetries` helper that `extends` cannot intercept.

## Open Questions

1. `[extraction]` What package name and versioning policy should the standalone harness use?
2. `[extraction]` Should project-owned `eval-map.json` be hand-maintained, generated, or both?
3. `[ci]` Should CI treat `eval:smoke` status `100` as success everywhere, or only for framework-port verification jobs?
