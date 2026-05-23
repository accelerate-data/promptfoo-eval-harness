---
title: "Phase 12 — Codex SDK provider (v1.3.0)"
description: "Add codex_sdk in-proc Node provider on top of Phase 9.5 (SDK owns CLI subprocess); per-case git workspace + per-session HOME isolation; no per-provider concurrency."
status: pending
priority: P2
effort: ~4 days
branch: feature/vd-2174-multi-sdk-plugin-contract
tags: [codex, sdk, node, provider, multi-sdk]
created: 2026-05-23
---

# Phase 12 — Codex SDK Provider (v1.3.0 / VD-2174-11)

> **Sub-issue:** VD-2174-11. **Status:** PLANNED. **Blocked by:** Phase 9.5 (generic in-proc dispatch + hierarchical concurrency).
> Time budget: ~4 days. **No PR raised at end of phase** (per user directive).

## Context Links

- Lead judgment applied: **Minimalist #1 (DROP per-provider concurrency from this phase entirely — Phase 9.5 already has the primitive; v1.3.0 ships under global gate only)**, Minimalist #4 (`require.cache` module-level mock — already the chosen pattern, just confirmed), Minimalist #5 (drop `sdk-pins.toml` Node fields; pin in `package.json`), Minimalist #7 (drop `cli_version` + version handshake), Minimalist #8 (drop per-provider README), Minimalist #9 (Layer 2 callApi round-trip), Architect #4 (workspace boundary already in phase 07 — this phase narrows it for Codex), Architect #8 (`skipGitRepoCheck: false` — per-case `mkdtemp` + `git init -q`), Skeptic #6 (regenerate lockfile on Linux), Skeptic #9 (per-session `HOME` isolation via env override + parallel-scenario test).
- Spike: [`spike-codex-sdk-shape.md`](spike-codex-sdk-shape.md) — VERDICT: PASS WITH CAVEATS (2026-05-22).
- Spec: [`spec.md`](spec.md) §2.2 (KIND_REGISTRY), §2.5 (amended in Phase 9.5; Node in-proc dispatch via bridge), §6.4 (sdk-pins schema), §8.3 (Layer 3 mock-SDK pattern).
- Foundation: [`phase-09.5-bridge-inproc-and-hierarchical-concurrency.md`](phase-09.5-bridge-inproc-and-hierarchical-concurrency.md) — generic in-proc dispatch + `acquire(kind?)` hierarchical concurrency primitive already in place. This phase contributes registry entry + provider module + mock + scenario; NO concurrency code change.
- Reference impls: [`phase-11-opencode-sdk-provider.md`](phase-11-opencode-sdk-provider.md) (ESM in-proc Node SDK shape — Codex SDK is CJS-compat, mirror structure but use `require()` + `require.cache`), [`phase-06-openhands-sdk-provider.md`](phase-06-openhands-sdk-provider.md) (Python subprocess shape, contract symmetry).

## Overview

- **Priority:** Third post-v1.0.0 SDK addition; second in-proc Node provider. Validates the CJS-side mock pattern (`require.cache` injection) parallel to Phase 11's ESM-side `Module.register()` pattern.
- **Brief:** Add `codex_sdk` as an in-process Node provider that drives `@openai/codex-sdk`. The SDK itself owns the `@openai/codex` CLI subprocess; the harness owns per-case git-initialized workspaces and per-session `HOME` isolation. Reuses the generic in-proc lifecycle path landed in Phase 9.5.
- **Out of scope:** **per-provider concurrency caps (deferred — no concrete need)**, Codex SaaS endpoints, custom Codex MCP plugins, Codex agent profile switching mid-run.

## Key Insights

- **`@openai/codex-sdk` is CJS-compat** (spike §1). The provider uses `require('@openai/codex-sdk')`; mocks inject via `require.cache` (Node CJS module cache). Phase 9.5's `_dispatchInproc` calls `await import(pathToFileURL(registry.module))` which works for both CJS (default export wrapped) and ESM modules, so the same in-proc lifecycle applies.
- **Per-provider concurrency is DROPPED from this phase** (Minimalist #1):
  - Phase 9.5 already exposes `acquire(kind?)` as a hierarchical primitive (`global` first, then optional per-kind). The primitive exists; it does not need to be USED by Codex in v1.3.0.
  - Codex v1.3.0 runs under `AD_EVALS_MAX_CONCURRENCY` and `AD_EVALS_OUTER_CONCURRENCY` only — same as every other kind today. NO `[concurrency.codex_sdk]` entry in `config/eval-tiers.toml`, NO per-kind cap, NO threading of kind through `_dispatch()` for concurrency purposes.
  - If a future scenario proves global caps cannot solve a Codex saturation problem, add a per-kind cap then. Until then, omit.
- **`skipGitRepoCheck: false` + per-case `mkdtemp` + `git init -q`** (Architect #8):
  - The spike explicitly says `skipGitRepoCheck: false` enforces the git-repo invariant; the original Phase 12 plan flipped to `true` without justification. Lead rejected that flip.
  - At `turn` time (or `init` time for single-turn scenarios), the provider calls `fs.mkdtemp()` to create `${workspace.dir}/.codex-case-${caseId}/` and runs `git init -q` inside it. The Codex SDK is then started with `cwd: thatDir` and `skipGitRepoCheck: false`.
  - Cleanup: at `shutdown`, the per-case dirs are removed (best-effort `rm -rf`).
  - The phase 07 workspace guard already provides the parent `workspace.dir`; this phase only adds the `.codex-case-${caseId}/` subdir + `git init`.
- **Per-session `HOME` isolation** (Skeptic #9):
  - Each Codex session gets `HOME` overridden to `fs.mkdtemp(${workspace.dir}/.codex-home-${caseId}/)`.
  - Implemented by setting `env: { ...process.env, HOME: tempHome }` on the SDK constructor call (the SDK forwards env to its CLI subprocess).
  - At `shutdown`, cleanup the temp home (best-effort `rm -rf`).
  - **Parallel-scenario test in `provider.test.js`:** run two sessions concurrently (`Promise.all([provider.turn(s1, ...), provider.turn(s2, ...)])`), each writes a marker file to `$HOME/marker.txt`, assert each session's `$HOME` content is independent (no shared state).
- **`require.cache` module-level mock** (Minimalist #4 — confirmed pattern):
  - `tests/_mock_codex_sdk/index.js` defines the mock as a CJS module.
  - `tests/_mock_codex_sdk/register.js` does `require.cache[require.resolve('@openai/codex-sdk')] = { exports: require('./index.js') }` BEFORE the provider's first `require('@openai/codex-sdk')`.
  - In-process test setup: `provider.test.js` calls `require('../../../tests/_mock_codex_sdk/register.js')` at the top.
  - CI scenario uses `NODE_OPTIONS="--require ./tests/_mock_codex_sdk/register.js"` to install the cache stub before the bridge starts.
- **`@openai/codex` CLI dep stays as a bin** (Minimalist #5 + #7):
  - Both `@openai/codex-sdk` and `@openai/codex` exact-pinned in `package.json` `dependencies` (the SDK invokes the CLI bin shipped alongside).
  - **NO `[codex_sdk]` section in `config/sdk-pins.toml`.** Drop `cli_version`, `npm_version`, `node` fields. Drop the `init()` version handshake.
  - Drift control: `package-lock.json` integrity check on `npm ci` enforces the pin; runtime version assertion is unnecessary ceremony.
- **Lockfile regenerated on Linux** (Skeptic #6): same workflow as Phase 11 — Linux-clean lockfile committed; do NOT `git restore` after a local darwin install.
- **Layer 2 round-trip test** (Minimalist #9): one `callApi()` test that parses turns, dispatches the provider, returns transcript/metadata. Replaces any registry-shape-only assertion.
- **No spec amendment in this phase** — Phase 9.5 owns the §2.5 amendment paragraph.
- **No per-provider README** (Minimalist #8): central docs only.

## Requirements

### Functional

1. **Provider module (`scripts/framework/providers/codex_sdk/provider.js`):** Node CJS file exporting `{ create() }` matching the SDKProvider contract introduced in Phase 9.5 (`init`, `turn`, `finalize`, `shutdown` — all may be `async`). Single file under 200 lines; split only if a second call site emerges.

2. **Per-case git workspace (Architect #8):**
   - `init(cfg)` does NOT create the case workspace; it stores `cfg.workspace.dir` and config for later.
   - `turn(session, input)` on first invocation:
     - `caseWorkDir = fs.mkdtemp(${cfg.workspace.dir}/.codex-case-${caseId}/)`.
     - `await execFile('git', ['init', '-q'], { cwd: caseWorkDir })`.
     - Stamp an empty initial commit so Codex sees a non-empty repo: `git commit --allow-empty -m "init" -q` (verify with the actual SDK at impl time; some Codex flows require HEAD).
     - Construct Codex SDK with `{ workingDirectory: caseWorkDir, skipGitRepoCheck: false }`.
   - Subsequent turns reuse the case work dir (multi-turn context continuity).
   - `shutdown(session)`: best-effort `fs.rm(caseWorkDir, { recursive: true, force: true })`.

3. **Per-session HOME isolation (Skeptic #9):**
   - `init(cfg)`: stash `caseHomeDir = fs.mkdtempSync(${cfg.workspace.dir}/.codex-home-${caseId}/)` on session.
   - SDK constructor called with `env: { ...process.env, HOME: caseHomeDir }`.
   - The SDK forwards `env` to the CLI subprocess (`@openai/codex` bin), so the CLI's own state-file writes land in `caseHomeDir` not `~/.codex/`.
   - `shutdown(session)`: best-effort `fs.rm(caseHomeDir, { recursive: true, force: true })`.

4. **Codex SDK lifecycle:**
   - `init(cfg)`: validate config; reserve `caseHomeDir` (see above); store SDK constructor args. No SDK instantiation yet.
   - `turn(session, input)`:
     - Lazily create case workspace + git init on first turn.
     - Instantiate SDK with `{ workingDirectory: caseWorkDir, env: { ...process.env, HOME: caseHomeDir }, skipGitRepoCheck: false }`.
     - Call SDK's primary method (per spike: likely `sdk.run({ prompt: input })` or `sdk.exec(input)` — verify at impl).
     - Stream events; map to `TurnResult`.
   - `finalize(session)`: aggregate metadata (cost, tokens) from the last response.
   - `shutdown(session)`: best-effort cleanup of `caseWorkDir` and `caseHomeDir`.

5. **Event extraction (inlined in `provider.js`):** maps Codex SDK events to spec §1.2 shapes. Per spike: text deltas → `TurnResult.text` accumulator; tool invocations → `ToolCallRecord`. Cost/tokens from final-response metadata → `FinalResult`.

6. **Model resolution (inlined):** `cfg.model` passed through unchanged. Unsupported-model errors from SDK → `ProviderError(code="UNSUPPORTED_MODEL", retryable=False)`.

7. **Layer 2 round-trip test (`provider.test.js`):**
   - Top-level `require('../../../tests/_mock_codex_sdk/register.js')` to install `require.cache` stub before provider import.
   - Single-turn callApi round-trip.
   - Multi-turn (3-turn) callApi round-trip — mock verifies `workingDirectory` is the SAME across turns (per-case workspace continuity).
   - **Parallel-scenario `HOME`-isolation test:** spawn two concurrent sessions; mock SDK records the `HOME` env value on each call; assert each session sees a distinct `HOME` path.
   - **Git-init verification:** mock SDK asserts `fs.existsSync(workingDirectory + '/.git')` is `true` on every call.
   - Failure cases: git init error → `ProviderError(code="WORKSPACE_SETUP", retryable=False)`; SDK auth error → `AUTH`; SDK unsupported-model → `UNSUPPORTED_MODEL`.
   - **No** registry-shape-only test; Phase 9.5 covers that.

8. **`_node_bridge.KIND_REGISTRY.codex_sdk`:** `{ mode: 'inproc', module: require.resolve('./providers/codex_sdk/provider.js') }`. Phase 9.5's `_dispatchInproc` handles the rest.

9. **NO concurrency code change** (Minimalist #1 — lead-accepted):
   - `config/eval-tiers.toml` unchanged for Codex (no `[concurrency.codex_sdk]` section).
   - `scripts/framework/concurrency.js` unchanged from Phase 9.5 state.
   - `_node_bridge.js _dispatch()` does NOT pass kind to concurrency for this phase.
   - Codex shares the global `AD_EVALS_MAX_CONCURRENCY` gate with every other kind.

10. **CI mock parity:**
    - New scenario at `tests/harness-scenarios/packages/codex-sdk-mock-multi-turn/`.
    - `.github/workflows/nightly-scenarios.yml`: add a step `NODE_OPTIONS="--require ${{ github.workspace }}/tests/_mock_codex_sdk/register.js" node bin/ad-evals.js run tests/harness-scenarios/packages/codex-sdk-mock-multi-turn`.
    - Pre-step: `git config --global user.email ci@local && git config --global user.name CI` so per-case `git init` + `git commit --allow-empty` works in CI runner with no global git config.

11. **`package.json` deps:**
    - `dependencies`: `"@openai/codex-sdk": "<exact>"` + `"@openai/codex": "<exact>"`.
    - `engines.node` already `>=20` from Phase 11.
    - **No** `[codex_sdk]` section added to `sdk-pins.toml`. **No** `cli_version` handshake.
    - `package-lock.json` regenerated on Linux (commit Linux-clean; do NOT `git restore`).

### Non-functional

- `npm test` clean.
- `npm run lint:md` clean.
- All existing kinds (OpenHands SDK, OpenCode CLI, Claude Agent SDK, OpenCode SDK) regress green.
- Cold-start latency for the in-proc dispatch path within the budget recorded in Phase 11's benchmarks.

## Architecture

```text
scripts/framework/providers/codex_sdk/
├── provider.js            # in-proc Node CJS provider — init/turn/finalize/shutdown + per-case git workspace + HOME isolation
└── provider.test.js       # Layer 2 callApi round-trip + parallel HOME isolation + git-init verification

tests/_mock_codex_sdk/
├── register.js            # require.cache injection — invoked via NODE_OPTIONS=--require
└── index.js               # mock SDK constructor + run() + state recorder for HOME / workingDirectory assertions

scripts/framework/_node_bridge.js  (modified)
  └── KIND_REGISTRY.codex_sdk = {
        mode: 'inproc',
        module: require.resolve('./providers/codex_sdk/provider.js'),
      }
  └── (no other change — _dispatchInproc landed in Phase 9.5 already handles this kind)

scripts/framework/concurrency.js   (NO CHANGE — per Minimalist #1)
config/eval-tiers.toml             (NO codex_sdk concurrency entry — per Minimalist #1)

package.json  (modified)
  └── dependencies: "@openai/codex-sdk": "<pinned>", "@openai/codex": "<pinned>"
  └── engines.node already ">=20" from Phase 11

config/sdk-pins.toml  (NO CHANGE — no [codex_sdk] section)

package-lock.json  (regenerated on Linux, committed)

.github/workflows/nightly-scenarios.yml  (modified)
  └── git config --global user.email/name step
  └── NODE_OPTIONS="--require ${{ github.workspace }}/tests/_mock_codex_sdk/register.js" step
  └── Scenario: tests/harness-scenarios/packages/codex-sdk-mock-multi-turn/
```

## Related Code Files

- **Create:**
  - `scripts/framework/providers/codex_sdk/provider.js`
  - `scripts/framework/providers/codex_sdk/provider.test.js`
  - `tests/_mock_codex_sdk/register.js`
  - `tests/_mock_codex_sdk/index.js`
  - `tests/harness-scenarios/packages/codex-sdk-mock-multi-turn/` (full scenario)
- **Modify:**
  - `scripts/framework/_node_bridge.js` (extend `KIND_REGISTRY` — single entry)
  - `package.json` (add `@openai/codex-sdk` + `@openai/codex`; bump version to `1.3.0`)
  - `package-lock.json` (regenerated on Linux)
  - `docs/design.md` (provider table — add `codex_sdk` row)
  - `.github/workflows/nightly-scenarios.yml` (git config + NODE_OPTIONS + scenario step)
- **NOT modified:**
  - `scripts/framework/concurrency.js` (per Minimalist #1)
  - `config/eval-tiers.toml` (per Minimalist #1)
  - `config/sdk-pins.toml` (per Minimalist #5 + #7)
- **Delete:** none.

## Implementation Steps

### Step 1 — Provider module + mock SDK

1. Author `tests/_mock_codex_sdk/index.js`:
   - Export a CJS constructor that the SDK presents (`module.exports = function CodexSDK(opts) { ... }` or `{ CodexSDK }` — verify at impl).
   - Mock records `opts.workingDirectory`, `opts.env.HOME`, `opts.skipGitRepoCheck` on every constructor call into a global recorder (`globalThis.__codexMockState`).
   - Mock `run({ prompt })` returns a deterministic event stream + final metadata.
   - Multi-turn-dependency support: state keyed by `workingDirectory` so turn 2 sees turn 1's prior input.
2. Author `tests/_mock_codex_sdk/register.js`:
   - `const mock = require('./index.js'); require.cache[require.resolve('@openai/codex-sdk')] = { id: '@openai/codex-sdk', filename: '@openai/codex-sdk', loaded: true, exports: mock };`
   - Idempotent: skip if already in cache.
3. Author `scripts/framework/providers/codex_sdk/provider.js`:
   - `require('@openai/codex-sdk')` at module top (mock is already in `require.cache` when running under tests/CI mock).
   - `init/turn/finalize/shutdown` implementing the spec above.
   - Per-case `mkdtemp` + `git init -q` + `git commit --allow-empty -m init -q` at first `turn()`.
   - Per-session HOME via `mkdtempSync` at `init()`.
   - Cleanup at `shutdown()` best-effort.
4. Author `scripts/framework/providers/codex_sdk/provider.test.js`:
   - Top-level `require('../../../tests/_mock_codex_sdk/register.js')`.
   - Single-turn + multi-turn-continuity + parallel-HOME-isolation + git-init-verification + failure cases.
5. Run tests; commit: `feat(vd-2174-11): add codex_sdk in-proc provider + require.cache mock`.

### Step 2 — Bridge registry entry

6. Edit `scripts/framework/_node_bridge.js`:
   - Add `codex_sdk` entry to `KIND_REGISTRY` with `mode: 'inproc'` and `module: require.resolve('./providers/codex_sdk/provider.js')`.
   - No other change.
7. Run `npm test` — existing tests green; new provider test green.
8. Commit: `feat(vd-2174-11): register codex_sdk kind in bridge KIND_REGISTRY`.

### Step 3 — Add dependencies + regenerate lockfile (LINUX)

9. On a Linux host (CI runner or `docker run --rm -v $(pwd):/w -w /w node:20`):
   - Edit `package.json`: add `"@openai/codex-sdk": "<exact>"` + `"@openai/codex": "<exact>"`; bump version to `1.3.0`.
   - Run `npm install --package-lock-only` to regenerate `package-lock.json`.
10. Verify `npm ci` succeeds on Linux.
11. Do NOT `git restore package-lock.json`. Commit Linux-regenerated lockfile.
12. Commit: `chore(vd-2174-11): pin @openai/codex-sdk + @openai/codex`.

### Step 4 — Nightly CI scenario + mock-mode parity

13. Create `tests/harness-scenarios/packages/codex-sdk-mock-multi-turn/`:
    - `package.yaml`: tier=`smoke`, provider_kind=`codex_sdk`.
    - Cases: one single-turn, one multi-turn (3-turn) with cross-turn dependency.
14. Edit `.github/workflows/nightly-scenarios.yml`:
    - Add pre-step: `git config --global user.email "ci@local" && git config --global user.name "CI"` (needed for `git commit --allow-empty` inside per-case dirs).
    - Add scenario step: `NODE_OPTIONS="--require ${{ github.workspace }}/tests/_mock_codex_sdk/register.js" node bin/ad-evals.js run tests/harness-scenarios/packages/codex-sdk-mock-multi-turn`.
15. Run locally to confirm green.
16. Commit: `ci(vd-2174-11): wire codex_sdk mock scenario into nightly workflow`.

### Step 5 — Doc touch + version bump

17. Update `docs/design.md` provider table to list `codex_sdk` row.
18. Confirm `package.json` version is `1.3.0`.
19. Commit: `chore(vd-2174-11): release v1.3.0 — codex_sdk in-proc provider`.

## Todo List

- [ ] Step 1a: `tests/_mock_codex_sdk/` (index.js + register.js) with state recorder.
- [ ] Step 1b: `provider.js` with per-case git workspace + per-session HOME isolation + lifecycle.
- [ ] Step 1c: `provider.test.js` callApi round-trip + parallel HOME isolation + git-init verification — all cases green.
- [ ] Step 2: `_node_bridge.js` `KIND_REGISTRY.codex_sdk` entry; existing tests still green.
- [ ] Step 3a: `@openai/codex-sdk` + `@openai/codex` exact-pinned in `package.json`.
- [ ] Step 3b: `package-lock.json` regenerated on Linux (NOT restored) and committed.
- [ ] Step 4a: `codex-sdk-mock-multi-turn` scenario created.
- [ ] Step 4b: `nightly-scenarios.yml` git-config + NODE_OPTIONS step green.
- [ ] Step 5: `docs/design.md` provider row + version bump to 1.3.0.
- [ ] All existing providers regress green.
- [ ] `npm test` + `npm run lint:md` clean.
- [ ] Confirm `concurrency.js` and `eval-tiers.toml` unchanged from Phase 9.5.

## Success Criteria

- All commits land on the feature branch (no PR).
- `provider.test.js` green INCLUDING the parallel-HOME-isolation test (two concurrent sessions don't share HOME).
- `provider.test.js` git-init verification asserts `.git` present in every case workspace.
- Nightly CI scenario green with `--require` mock loaded.
- `package-lock.json` Linux-clean.
- `config/sdk-pins.toml` UNCHANGED (no `[codex_sdk]` section).
- `scripts/framework/concurrency.js` and `config/eval-tiers.toml` UNCHANGED (no per-kind cap).
- `package.json` version → `1.3.0`.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| `@openai/codex-sdk` exact method name / option shape drifts from spike | M | M | Pin exact version; canary on version bump; verify constructor args at impl with a quick repl. |
| Per-case `git init` fails in CI due to missing global git config | M | M | Pre-step in nightly workflow: `git config --global user.email/name`; provider also sets `--initial-branch=main` for newer git versions. |
| `git commit --allow-empty` requires user identity in some git versions | M | L | Provider passes `-c user.name=... -c user.email=...` inline so it works even without global config; fallback path documented. |
| `HOME` isolation fails because SDK ignores `env` constructor arg | L | H | Mock test confirms SDK forwards env to CLI subprocess; if real SDK doesn't, escalate via Skeptic #9 follow-up (deferred phase to wrap CLI directly). |
| Cleanup of per-case dirs leaves orphan tmp on CI failure | M | L | Best-effort cleanup at shutdown + harness-level workspace janitor from phase 07 (parent dir is `cfg.workspace.dir` already managed). |
| `require.cache` stub leaks between tests in the same Node process | L | M | `provider.test.js` uses isolated workers (`jest --isolate-modules` or equivalent); CI uses subprocess per scenario. |
| Lockfile regeneration step missed locally (darwin drift) | M | L | CONTRIBUTING note + the existing `darwin-lockfile-drift-from-ensureDepsInstalled` GOTCHA in memory; reviewer flags if `package-lock.json` lacks `linux-x64` arches. |
| User reports a real Codex saturation case requiring per-kind cap | M | M | Primitive already in Phase 9.5; just add a `[concurrency.codex_sdk]` entry in `config/eval-tiers.toml` in a one-line follow-up. Out of scope here. |

## Security Considerations

- Per-case git workspace + per-session HOME = full filesystem isolation for Codex's own state files; secrets in `$HOME/.codex/` never cross sessions.
- `skipGitRepoCheck: false` keeps Codex's safety invariant intact (Codex was designed to refuse running outside a repo).
- `require.cache` mock lives under `tests/_mock_codex_sdk/` and is loaded ONLY when `NODE_OPTIONS=--require` is set. Never on production path.
- Workspace guard from phase 07 still owns the parent `cfg.workspace.dir`; this phase only carves sub-dirs inside it.
- No new env vars in the allowlist — Codex auth flows through `OPENAI_API_KEY` already covered by spec §6.4 base allowlist.

## Next Steps

- v1.3.0 closes the v1.x SDK-add tranche. Future phases: `--compare` multi-model fan-out (spec §0.2 Phase 5+); Codex SaaS endpoint support; per-kind concurrency tuning ONLY when a real saturation case appears.
- Phase 9.5's `acquire(kind?)` primitive remains available for future per-kind caps — usage is opt-in, not required by any v1.x provider.

## Open Questions

- None — the lead's judgment table resolved every open item flagged in the adversarial reviews. SDK method name (`sdk.run` vs `sdk.exec` vs other) confirmed at implementation time during Step 1.
