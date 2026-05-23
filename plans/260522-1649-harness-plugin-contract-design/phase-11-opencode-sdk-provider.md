---
title: "Phase 11 — OpenCode SDK provider (v1.2.0)"
description: "Add opencode_sdk in-process Node provider on top of Phase 9.5's generic in-proc dispatch; harness owns ephemeral 127.0.0.1:0 OpenCode server."
status: pending
priority: P2
effort: ~4 days
branch: feature/vd-2174-multi-sdk-plugin-contract
tags: [opencode, sdk, node, provider, multi-sdk]
created: 2026-05-23
---

# Phase 11 — OpenCode SDK Provider (v1.2.0 / VD-2174-10)

> **Sub-issue:** VD-2174-10. **Status:** PLANNED. **Blocked by:** Phase 9.5 (generic in-proc dispatch + hierarchical concurrency).
> Time budget: ~4 days. **No PR raised at end of phase** (per user directive).

## Context Links

- Lead judgment applied: Minimalist #2 (Phase 9.5 owns generic in-proc dispatch), Minimalist #4 (drop Express, use module-level SDK stub), Minimalist #5 (drop sdk-pins.toml Node fields; pin in `package.json`), Minimalist #8 (drop per-provider README), Minimalist #9 (Layer 2 callApi round-trip), Architect #4 (explicit server-lifecycle section — harness owns it), Skeptic #6 (regenerate lockfile on Linux, do NOT restore).
- Spike: [`spike-opencode-sdk-shape.md`](spike-opencode-sdk-shape.md) — VERDICT: PASS (2026-05-22).
- Spec: [`spec.md`](spec.md) §2.2 (KIND_REGISTRY), §2.5 (amended in Phase 9.5; Node in-proc dispatch via bridge), §6.4 (sdk-pins schema), §8.3 (Layer 3 mock-SDK pattern).
- Foundation: [`phase-09.5-bridge-inproc-and-hierarchical-concurrency.md`](phase-09.5-bridge-inproc-and-hierarchical-concurrency.md) — `_dispatch()` already routes `mode === 'inproc'` entries through `_dispatchInproc(kind, registry, ...)`. This phase only adds a new registry entry plus a provider module conforming to the in-proc Node SDK contract introduced in 9.5.
- Reference impls: [`phase-06-openhands-sdk-provider.md`](phase-06-openhands-sdk-provider.md) (Python subprocess shape, contract symmetry), [`scripts/framework/opencode-cli-provider.js`](../../scripts/framework/opencode-cli-provider.js) (existing CLI provider — for naming/sibling cohesion only; opencode_sdk is independent).

## Overview

- **Priority:** Second post-v1.0.0 SDK addition; first **Node in-proc** provider, validating the generic in-proc dispatch added in Phase 9.5 with a real third-party SDK.
- **Brief:** Add `opencode_sdk` as an in-process Node provider that drives `@opencode-ai/sdk` against an OpenCode server owned by the harness (ephemeral `127.0.0.1:0` boot at provider `init`, graceful stop at `shutdown`). Reuses the generic in-proc lifecycle path landed in Phase 9.5; this phase contributes only the registry entry + provider module + mock + scenario.
- **Out of scope:** consumer-supplied OpenCode server URLs (harness owns the server), authenticated SaaS OpenCode endpoints, agent-mode switching mid-run, custom OpenCode tool plugins.

## Key Insights

- **`@opencode-ai/sdk` is ESM-only** (spike §1). The bridge uses `await import('@opencode-ai/sdk')` at provider load time — Phase 9.5's `_dispatchInproc` already handles dynamic ESM import via the `module` registry field.
- **Server lifecycle is harness-owned** (Architect #4):
  - At `init(cfg)` the provider calls `createOpencodeServer({ hostname: '127.0.0.1', port: 0 })` (or the canonical helper the SDK exposes — to be verified at implementation time, fallback documented below). Bound port read back from the returned server handle.
  - Provider keeps an instance `_server` reference on the session.
  - At `shutdown(session)` the provider calls the server's stop method (`server.close()` / `server.stop()` — exact name verified at implementation; the contract is: graceful close, drain in-flight requests, timeout after 5 s with forced kill).
  - One server per provider INSTANCE — not one per case. The bridge holds the provider in `_inprocProviderCache` (added in Phase 9.5), so when 30 cases of kind `opencode_sdk` run, they share one server but each gets its own SDK client session via `client.session.create()`.
  - **Fallback if `createOpencodeServer()` helper doesn't exist in the installed package version:** spawn `npx opencode serve --port 0 --hostname 127.0.0.1` as a child process from the provider, read the bound port from stdout. Document which path was taken inside `provider.js` header comment.
- **Module-level SDK stub** (Minimalist #4): tests inject a fake `@opencode-ai/sdk` module via dynamic-import interception (`Module._resolveFilename` redirect or a registered ESM loader hook) instead of standing up an Express clone of the server. Mirror Phase 12's `require.cache` approach but adapted for ESM dynamic imports — implementation detail: `tests/_mock_opencode_sdk/loader.mjs` registers with `Module.register()` (Node ≥ 20) and intercepts `@opencode-ai/sdk` imports, returning the mock. **No `express` devDependency, no HTTP fixture, no port allocation in tests.**
- **`package.json` is the single source of truth for the Node SDK pin** (Minimalist #5):
  - `@opencode-ai/sdk` exact-pinned in `dependencies` (e.g. `"@opencode-ai/sdk": "0.13.4"`).
  - `engines.node` bumped to `>=20` (required for `Module.register()` + native fetch).
  - **`config/sdk-pins.toml`:** NO `[opencode_sdk]` entry. The bridge does not read a TOML pin for in-proc Node providers. `sdk-pins.toml` stays a Python-subprocess manifest only.
- **Lockfile regenerated on Linux** (Skeptic #6): the `darwin-lockfile-drift-from-ensureDepsInstalled` gotcha shows that running `npm install` on darwin prunes Linux-only optional deps and dirties `package-lock.json`. Workflow: run `npm install --package-lock-only` on a Linux runner (or via container) when committing the new dep; do NOT `git restore package-lock.json` after a local darwin install. The committed lockfile MUST be Linux-clean.
- **Layer 2 round-trip test** (Minimalist #9): one `callApi()` test that parses turns, dispatches the provider, returns transcript/metadata. Uses the module-level SDK stub. Replaces any registry-shape-only assertion. Phase 9.5 already proves the generic in-proc lifecycle; this phase only proves the opencode_sdk provider plugs into it.
- **No spec amendment in this phase** — Phase 9.5 owns the §2.5 amendment paragraph.
- **No per-provider README** (Minimalist #8): central docs (`docs/design.md` provider table) only.

## Requirements

### Functional

1. **Provider module (`scripts/framework/providers/opencode_sdk/provider.js`):** Node CJS-or-ESM file exporting `{ create() }` matching the SDKProvider contract introduced in Phase 9.5 (`init`, `turn`, `finalize`, `shutdown` — all may be `async`). Single file under 200 lines; split only if a second call site emerges.

2. **Server lifecycle (Architect #4 — explicit contract):**
   - `init(cfg)` boots the OpenCode server at `127.0.0.1:0` (kernel-assigned port). Stores `{ server, client, baseUrl, agent }` on session.
   - Readiness probe: poll `client.session.list({ limit: 1 })` until success or 5 s timeout → `ProviderError(code="STARTUP_TIMEOUT", retryable=False)`.
   - One server per provider instance (cached in Phase 9.5's `_inprocProviderCache`). Per-case isolation handled by `client.session.create()` returning a new session id per case.
   - `shutdown(session)` calls server's graceful close; on 5 s timeout, force-kill. Idempotent.
   - **No consumer override of server URL in v1.2.0** — harness owns the lifecycle entirely.

3. **Per-case SDK session:**
   - `init(cfg)` does NOT create the session id; it creates the server + a single SDK client.
   - `turn(session, input)` lazily creates an OpenCode session via `client.session.create()` on first turn, stores `sessionId` on session, reuses for subsequent turns.
   - Multi-turn context is maintained server-side by OpenCode keyed on `sessionId`.
   - `finalize(session)` reads final-state metadata (cost, tokens) from `client.session.get(sessionId)`.
   - `shutdown(session)` calls `client.session.delete(sessionId)` if non-null, then stops the server.

4. **Event extraction (inlined in `provider.js`):** maps OpenCode SDK SSE/stream events to spec §1.2 shapes. Per the spike: `message.part.updated` with `type=text` → `TurnResult.text`; `type=tool` → `ToolCallRecord(name, args, result, status)`. Cost/tokens from final `session.get()` → `FinalResult`.

5. **Agent mode:** read `cfg.extra.opencode_agent` (default `"build"`). Pass to `client.session.create({ agent })`. v1.2.0 supports only the agents OpenCode exposes (`build`, `plan`, etc. per spike §3); unsupported value → `ProviderError(code="UNSUPPORTED_AGENT", retryable=False)`.

6. **Model resolution (inlined):** `cfg.model` is passed through unchanged to the SDK; SDK's own provider catalog handles validation. Unknown-model errors from the SDK → `ProviderError(code="UNSUPPORTED_MODEL", retryable=False)`.

7. **Layer 2 round-trip test (`provider.test.js`):**
   - Single `callApi()` test exercising parse turns → in-proc dispatch (via Phase 9.5's `_dispatchInproc`) → mock SDK → transcript + metadata.
   - Mock SDK provides `createOpencodeServer`, `createOpencodeClient`, `client.session.create/get/delete`, and a streaming events generator.
   - Module-level stub via `tests/_mock_opencode_sdk/loader.mjs` registered with `Module.register()` before test execution.
   - Asserts: returned `metadata.transcript` length, `metadata.cost_usd`, `metadata.tokens`, `metadata.tool_calls`.
   - Failure cases: server start timeout → `STARTUP_TIMEOUT`; SDK throws auth error → `AUTH`; unsupported agent → `UNSUPPORTED_AGENT`.
   - **No** registry-shape-only test; Phase 9.5 covers that.

8. **`_node_bridge.KIND_REGISTRY.opencode_sdk`:** `{ mode: 'inproc', module: require.resolve('./providers/opencode_sdk/provider.js') }`. Phase 9.5's `_dispatchInproc` reads `registry.module`, dynamic-imports it (via `await import(pathToFileURL(registry.module))` to handle ESM-or-CJS), calls `provider.create()` for the cached factory, and drives the lifecycle.

9. **CI mock parity:**
   - New scenario at `tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn/`.
   - `.github/workflows/nightly-scenarios.yml`: add a step that registers the mock SDK loader before invoking the harness for the OpenCode SDK scenario job. Pattern: `NODE_OPTIONS="--import ./tests/_mock_opencode_sdk/register.mjs" node bin/ad-evals.js run tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn`.
   - Server lifecycle in CI uses the mock — no real `npx opencode serve` boot in CI.

10. **`package.json` deps:**
    - `dependencies`: `"@opencode-ai/sdk": "<exact-spike-version>"`.
    - `engines.node`: bump to `">=20"`.
    - **No** `express` or `supertest` devDependencies for this phase.
    - `package-lock.json` regenerated on Linux (commit the Linux-clean lockfile; do NOT `git restore` after a local darwin run).

### Non-functional

- `npm test` clean (existing tests untouched).
- `npm run lint:md` clean.
- `node --experimental-vm-modules ./scripts/framework/providers/opencode_sdk/provider.test.js` exits 0.
- Bridge round-trip latency: in-proc dispatch overhead ≤ 50 ms compared to subprocess kinds (spec §3.A.7 update — measure once and record in `plans/.../benchmarks/`).

## Architecture

```text
scripts/framework/providers/opencode_sdk/
├── provider.js            # in-proc Node provider — init/turn/finalize/shutdown + server lifecycle + event extraction
└── provider.test.js       # Layer 2 callApi round-trip via mock SDK

tests/_mock_opencode_sdk/
├── register.mjs           # Module.register() entry — invoked via NODE_OPTIONS=--import
├── loader.mjs             # ESM loader hook — intercepts @opencode-ai/sdk dynamic imports
└── sdk.mjs                # mock createOpencodeServer + createOpencodeClient + session API + events generator

scripts/framework/_node_bridge.js  (modified)
  └── KIND_REGISTRY.opencode_sdk = {
        mode: 'inproc',
        module: require.resolve('./providers/opencode_sdk/provider.js'),
      }
  └── (no other change — _dispatchInproc landed in Phase 9.5 already handles this kind)

package.json  (modified)
  └── dependencies: "@opencode-ai/sdk": "<pinned>"
  └── engines.node: ">=20"

package-lock.json  (regenerated on Linux, committed)

.github/workflows/nightly-scenarios.yml  (modified)
  └── NODE_OPTIONS="--import ./tests/_mock_opencode_sdk/register.mjs" step
  └── Scenario: tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn/
```

## Related Code Files

- **Create:**
  - `scripts/framework/providers/opencode_sdk/provider.js`
  - `scripts/framework/providers/opencode_sdk/provider.test.js`
  - `tests/_mock_opencode_sdk/register.mjs`
  - `tests/_mock_opencode_sdk/loader.mjs`
  - `tests/_mock_opencode_sdk/sdk.mjs`
  - `tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn/` (full scenario)
- **Modify:**
  - `scripts/framework/_node_bridge.js` (extend `KIND_REGISTRY` — single entry)
  - `package.json` (add `@opencode-ai/sdk`; bump `engines.node`; bump version to `1.2.0`)
  - `package-lock.json` (regenerated on Linux)
  - `docs/design.md` (provider table — add `opencode_sdk` row)
  - `.github/workflows/nightly-scenarios.yml` (NODE_OPTIONS + scenario step)
- **Delete:** none.

## Implementation Steps

### Step 1 — Provider module + mock SDK loader

1. Author `scripts/framework/providers/opencode_sdk/provider.js`:
   - Module exports `{ create() }` factory returning a provider instance with `init`, `turn`, `finalize`, `shutdown`.
   - `init(cfg)`: dynamic `await import('@opencode-ai/sdk')`. Call `createOpencodeServer({ hostname: '127.0.0.1', port: 0 })` (fallback: spawn `npx opencode serve --port 0` if helper missing — document chosen path inline). Create client. Run readiness probe. Store `{ server, client, baseUrl, agent }` on session.
   - `turn(session, input)`: lazily create OpenCode session on first call; iterate stream events; map to `TurnResult`.
   - `finalize(session)`: `client.session.get(sessionId)` → `FinalResult`.
   - `shutdown(session)`: delete session, stop server gracefully, force-kill on 5 s timeout.
   - Header comment documents which server-boot path was chosen (`createOpencodeServer` vs `npx opencode serve`) based on SDK version installed.
2. Author `tests/_mock_opencode_sdk/sdk.mjs`:
   - Mock `createOpencodeServer({ hostname, port })` returning `{ url: 'http://127.0.0.1:<random-mock-port>', close: async () => {} }`. NO real network bind.
   - Mock `createOpencodeClient({ baseUrl })` returning `{ session: { create, get, delete, list } }`.
   - Deterministic in-memory state keyed by `sessionId`; supports the multi-turn-dependency test (turn 2 sees turn 1's recorded prompt).
   - Streaming events generator emitting `message.part.updated` events with text + tool parts.
3. Author `tests/_mock_opencode_sdk/loader.mjs`:
   - ESM loader hook (Node ≥ 20 API): `resolve(specifier, ctx, next)` — when specifier is `@opencode-ai/sdk`, return URL of `./sdk.mjs`. Otherwise delegate to `next`.
4. Author `tests/_mock_opencode_sdk/register.mjs`:
   - `import { register } from 'node:module'; register('./loader.mjs', import.meta.url);`
5. Author `scripts/framework/providers/opencode_sdk/provider.test.js`:
   - Use `child_process.spawn` to fork a sub-process with `NODE_OPTIONS="--import ${path-to}/register.mjs"` and run the bridge's `callApi()` end-to-end.
   - Cases: single-turn happy, multi-turn happy, server-start timeout, SDK auth error, unsupported agent.
   - Assert `metadata.transcript`, `metadata.cost_usd`, `metadata.tokens`, `metadata.tool_calls`.
6. Commit: `feat(vd-2174-10): add opencode_sdk in-proc provider + module-level SDK stub`.

### Step 2 — Bridge registry entry

7. Edit `scripts/framework/_node_bridge.js`:
   - Add `opencode_sdk` entry to `KIND_REGISTRY` with `mode: 'inproc'` and `module: require.resolve('./providers/opencode_sdk/provider.js')`.
   - No other change — Phase 9.5's `_dispatchInproc` is invoked automatically.
8. Run `npm test` — existing tests still green; new provider test green when run with the loader register.
9. Commit: `feat(vd-2174-10): register opencode_sdk kind in bridge KIND_REGISTRY`.

### Step 3 — Add dependency + regenerate lockfile (LINUX)

10. On a Linux host (CI runner or local container — e.g. `docker run --rm -v $(pwd):/w -w /w node:20 npm install @opencode-ai/sdk@<exact>`):
    - Edit `package.json`: add `"@opencode-ai/sdk": "<exact>"` to `dependencies`; set `"engines"."node"` to `">=20"`; bump version to `1.2.0`.
    - Run `npm install --package-lock-only` to regenerate `package-lock.json` with Linux-compatible optional deps intact.
11. Verify `npm ci` succeeds on Linux against the new lockfile.
12. Do NOT run `git restore package-lock.json` afterwards. Commit the Linux-regenerated lockfile.
13. Commit: `chore(vd-2174-10): pin @opencode-ai/sdk + bump engines.node to >=20`.

### Step 4 — Nightly CI scenario + mock-mode parity

14. Create `tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn/`:
    - `package.yaml`: tier=`smoke`, provider_kind=`opencode_sdk`, agent=`build`.
    - Cases: one single-turn, one multi-turn (3-turn) with cross-turn dependency.
15. Edit `.github/workflows/nightly-scenarios.yml`:
    - Add a step: `NODE_OPTIONS="--import ${{ github.workspace }}/tests/_mock_opencode_sdk/register.mjs" node bin/ad-evals.js run tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn`.
    - The mock loader runs only for this step — other scenarios remain unaffected.
16. Run locally to confirm green.
17. Commit: `ci(vd-2174-10): wire opencode_sdk mock scenario into nightly workflow`.

### Step 5 — Doc touch + version bump

18. Update `docs/design.md` provider table to list `opencode_sdk` row (in-proc Node row).
19. Confirm `package.json` version is `1.2.0`.
20. Commit: `chore(vd-2174-10): release v1.2.0 — opencode_sdk in-proc provider`.

## Todo List

- [ ] Step 1a: `provider.js` with full server lifecycle + event extraction + fallback boot path comment.
- [ ] Step 1b: `tests/_mock_opencode_sdk/` (sdk.mjs + loader.mjs + register.mjs).
- [ ] Step 1c: `provider.test.js` callApi round-trip green for all 5 cases.
- [ ] Step 2: `_node_bridge.js` `KIND_REGISTRY.opencode_sdk` entry; existing tests still green.
- [ ] Step 3a: `@opencode-ai/sdk` exact-pinned in `package.json`; `engines.node` ≥ 20.
- [ ] Step 3b: `package-lock.json` regenerated on Linux (NOT restored) and committed.
- [ ] Step 4a: `opencode-sdk-mock-multi-turn` scenario created.
- [ ] Step 4b: `nightly-scenarios.yml` NODE_OPTIONS step green.
- [ ] Step 5: `docs/design.md` provider row + version bump to 1.2.0.
- [ ] In-proc dispatch latency benchmark recorded.
- [ ] `npm test` + `npm run lint:md` clean.
- [ ] OpenHands SDK + OpenCode CLI + Claude Agent SDK providers regress green.

## Success Criteria

- All commits land on the feature branch (no PR).
- `provider.test.js` Layer 2 round-trip green via module-level SDK stub (no Express).
- `package-lock.json` Linux-clean (no `@swc/core-darwin-*` divergence).
- Nightly CI scenario runs without booting a real OpenCode server.
- Server lifecycle owned by harness: provider boots ephemeral `127.0.0.1:0` at init, stops at shutdown, fallback to `npx opencode serve` documented if helper missing.
- `package.json` version → `1.2.0`; `engines.node` ≥ 20.
- No `[opencode_sdk]` section in `config/sdk-pins.toml`.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `createOpencodeServer()` helper doesn't exist in pinned SDK version | M | M | Fallback to `npx opencode serve --port 0`; provider header documents which path is active; document choice in commit message. |
| ESM `Module.register()` loader hook breaks under future Node minor (deprecated experimental API) | L | M | Pin Node major in `engines.node`; canary on Node 22 LTS bump; loader hook is test-only — production providers do `await import('@opencode-ai/sdk')` directly. |
| Lockfile regeneration on Linux requires CI runner or container access | M | L | Documented step in Phase 11 implementation; can be done in `act` locally or via a one-off CI workflow_dispatch. |
| In-proc dispatch latency exceeds 50 ms budget due to dynamic import overhead | L | L | Phase 9.5 caches provider modules in `_inprocProviderCache`; first-import cost amortized across all cases in a run. |
| Server graceful close hangs in CI (zombie OpenCode process) | M | M | 5 s timeout → SIGKILL; CI matrix job timeout = 10 min; orphan process cleanup test in `provider.test.js`. |
| Bumping `engines.node` to ≥ 20 breaks consumer repos still on Node 18 | M | M | Coordinate with consumer-repo upgrades; document in `docs/setup.md` v1.2.0 entry; rollback path is to revert this phase. |
| Mock SDK behavior drifts from real SDK between minor versions | M | L | Canary scenario in a future phase using real SDK against a sandbox; mock pinned to spike-tested behavior shape. |

## Security Considerations

- Server bound to `127.0.0.1` only — never exposed externally. Random port avoids collision.
- No auth tokens in mock SDK. Real SDK passes `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` etc. through OpenCode server's own provider config (out of scope for v1.2.0; the harness only owns the server lifecycle, not its provider credentials — those flow through the existing env allowlist).
- Workspace isolation guard from phase 07 unchanged — in-proc providers receive `cfg.workspace.dir` and must honor it (`provider.js` passes the dir to `client.session.create({ cwd: workspace })` when SDK supports it; otherwise no-op).
- Module-level SDK stub lives under `tests/_mock_opencode_sdk/` and is loaded ONLY when `NODE_OPTIONS=--import` includes the register file. Never on production path.

## Next Steps

- Unblocks Phase 12 (Codex SDK provider) — both reuse Phase 9.5's in-proc dispatch; Phase 12 adds CJS-side `require.cache` stubbing, this phase added ESM-side `Module.register()` stubbing. Future Node SDKs pick the appropriate pattern.
- v1.2.0 ships harness-owned-server only; consumer-owned-server (URL override) deferred to a future phase.

## Open Questions

- None — the lead's judgment table resolved every open item flagged in the adversarial reviews. Server-boot helper name (`createOpencodeServer` vs `npx opencode serve`) confirmed at implementation time; both paths designed.
