# Review — Skeptic

## Verdict (one line): REJECT

## Findings

1. [HIGH] Phase 11/12 in-process providers are registered but never dispatched
   - File: plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:51, plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:130, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:64, scripts/framework/_node_bridge.js:425, scripts/framework/_node_bridge.js:527, scripts/framework/_node_bridge.js:551, scripts/framework/_node_bridge.js:552
   - Failure scenario: `opencode_sdk` or `codex_sdk` is added to `KIND_REGISTRY` with `mode: 'inproc'`, but `_dispatch()` only has a special in-process branch for `opencode_cli`; every other kind falls into the "SDK kinds — subprocess + NDJSON IPC" branch and calls `_buildSpawnSpec(kind, registry.adapter)`. For an in-proc registry entry there is no adapter, so the bridge builds a generic `uv run ... _python_adapter --kind=<node-kind>` path instead of loading the Node provider module.
   - Lens principle: prove-it-works
   - Recommendation: Add and test a generic `mode === 'inproc'` dispatch branch before adding either Node SDK provider. The Layer 2 tests must call `HarnessBridgeProvider.callApi()` end-to-end for an in-proc test provider, not just assert registry shape.

2. [HIGH] Phase 10 plans async Claude SDK calls behind a synchronous Python adapter
   - File: plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:119, plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:125, plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:126, scripts/framework/providers/_python_adapter.py:244, scripts/framework/providers/_python_adapter.py:265, scripts/framework/providers/_python_adapter.py:309, scripts/framework/providers/_python_adapter.py:332
   - Failure scenario: the plan tells the provider to consume `query()` as an async generator and to use `ClaudeSDKClient` as an async context manager, but `_python_adapter.py` calls `provider.init`, `provider.turn`, `provider.finalize`, and `provider.shutdown` synchronously. A provider implemented as described will return coroutine/async-generator objects or require `await`, and the adapter will try to read `result.text` from the wrong object or skip async cleanup.
   - Lens principle: prove-it-works
   - Recommendation: Decide whether the adapter becomes async-aware (`asyncio.run` around lifecycle handlers, with no nested loop hazards) or the Claude provider hides all async SDK calls behind synchronous wrappers. Add adapter tests proving async `init/turn/finalize/shutdown` work before implementing the provider.

3. [HIGH] Claude multi-turn design discards the first turn's context
   - File: plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:43, plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:125, plans/260522-1649-harness-plugin-contract-design/spike-claude-agent-sdk-shape.md:40, plans/260522-1649-harness-plugin-contract-design/spike-claude-agent-sdk-shape.md:41, plans/260522-1649-harness-plugin-contract-design/spike-claude-agent-sdk-shape.md:238, plans/260522-1649-harness-plugin-contract-design/spike-claude-agent-sdk-shape.md:241, plans/260522-1649-harness-plugin-contract-design/spike-claude-agent-sdk-shape.md:243
   - Failure scenario: the plan says the first turn may use stateless `query()` and only the second turn lazy-creates `ClaudeSDKClient`. The spike states `query()` is independent/new-session behavior, while `ClaudeSDKClient` is the stateful path. A 3-turn eval where turn 2 asks "now edit the file you read" will run turn 2 in a new client session that never saw turn 1.
   - Lens principle: fix-root-causes
   - Recommendation: If `vars.turns` has more than one turn, create `ClaudeSDKClient` before turn 1 and use it for every turn. Keep stateless `query()` only for true single-turn cases, with tests where turn 2 depends on turn 1.

4. [HIGH] Per-provider concurrency drops the existing global inner cap
   - File: plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:59, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:61, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:123, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:127, scripts/framework/_node_bridge.js:409, scripts/framework/_node_bridge.js:411, scripts/framework/_node_bridge.js:412, scripts/framework/concurrency.js:13, scripts/framework/concurrency.js:15
   - Failure scenario: current bridge behavior wraps every `callApi` in one global `AD_EVALS_MAX_CONCURRENCY` gate. The Phase 12 plan changes `_dispatch()` to call `concurrency.acquire(kind)` and explicitly tests that kind A saturation does not block kind B. That means two providers can each consume the default cap concurrently, so total in-process inner concurrency can exceed `AD_EVALS_MAX_CONCURRENCY=4`, violating the binding constraint that inner × outer pressure still works.
   - Lens principle: serialize-shared-state-mutations
   - Recommendation: Compose gates instead of replacing the global gate: acquire global first, then per-kind, and release in reverse order. Test total concurrency across mixed kinds never exceeds `AD_EVALS_MAX_CONCURRENCY`, while per-kind caps still constrain each provider.

5. [HIGH] Phase 12 concurrency config schema conflicts with the existing spec shape
   - File: plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:61, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:68, plans/260522-1649-harness-plugin-contract-design/spec.md:1120, plans/260522-1649-harness-plugin-contract-design/spec.md:1121, plans/260522-1649-harness-plugin-contract-design/spec.md:1136
   - Failure scenario: the plan says `[concurrency] default = <existing global>` and per-kind keys like `codex_sdk = 4`. The spec's tier config table already uses `[concurrency] default_max_concurrency = 4` and strict unknown-key validation. Implementing the plan literally either ignores the existing `default_max_concurrency` field or makes current configs fail strict validation.
   - Lens principle: fix-root-causes
   - Recommendation: Amend the schema first and provide a migration/compat path. Keep `default_max_concurrency` accepted, define the exact new keys, and add validator tests for old config, new config, and mixed invalid config.

6. [HIGH] Package-lock handling can break Linux `npm ci`
   - File: plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:54, plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:99, plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:139, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:69, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:137, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:138, .github/workflows/nightly-scenarios.yml:31, .github/workflows/nightly-scenarios.yml:32, bin/ad-evals.js:35, bin/ad-evals.js:47
   - Failure scenario: both Node SDK phases add top-level npm dependencies, but Phase 11 says to restore `package-lock.json` on Darwin if drift surfaces and Phase 12 repeats the same pattern. CI uses `npm ci`, which requires package.json and package-lock to agree. If package.json is committed with new deps and the lockfile is restored, Linux CI fails before tests run.
   - Lens principle: prove-it-works
   - Recommendation: Do not restore the lockfile after adding dependencies. Regenerate on a supported environment, commit package.json and package-lock together, and run `npm ci --no-audit --no-fund` locally or in a Linux container before claiming the phase is green.

7. [MEDIUM] OpenCode SDK mock server lifecycle is not crash-safe
   - File: plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:49, plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:114, plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:123, plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:124
   - Failure scenario: the mock server starts a real Express listener on an ephemeral port, but provider `shutdown()` explicitly does no teardown because the HTTP client is stateless. The plan says tests start the server and run failure paths, but does not require `try/finally` or `afterEach` cleanup. A thrown assertion or unreachable-server test can leak a listener and make parallel test runs hang or collide with process shutdown.
   - Lens principle: serialize-shared-state-mutations
   - Recommendation: Put server ownership in the test harness with mandatory `afterEach` cleanup and an assertion that no server handles remain. Do not conflate provider shutdown with fixture shutdown.

8. [MEDIUM] Mock-mode CI parity is not wired for new provider kinds
   - File: plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:34, plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:53, plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:97, plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:98, plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:99, .github/workflows/nightly-scenarios.yml:41, .github/workflows/nightly-scenarios.yml:44, tests/_mock_openhands_sdk/sitecustomize.py:21, tests/_mock_openhands_sdk/sitecustomize.py:24, tests/_mock_openhands_sdk/sitecustomize.py:25, tests/_mock_openhands_sdk/sitecustomize.py:26
   - Failure scenario: the existing nightly mock-mode workflow only adds `tests/_mock_openhands_sdk` to `PYTHONPATH`. Phase 10 creates `tests/_mock_claude_agent_sdk`, but no workflow or scenario step adds that directory to `PYTHONPATH`. Because `sitecustomize.py` only activates when its own directory appears in `PYTHONPATH`, Claude mock mode will not activate in scenario CI.
   - Lens principle: prove-it-works
   - Recommendation: Add an in-repo Claude mock scenario and update CI to activate the mock path for that scenario without breaking the OpenHands mock path. Prove both mock SDKs can coexist or run them in isolated scenario processes with explicit env.

9. [MEDIUM] Codex provider does not prove CLI stdio/state isolation under Promptfoo parallelism
   - File: plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:27, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:33, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:50, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:67, scripts/framework/dir-walk.js:75, scripts/framework/dir-walk.js:81
   - Failure scenario: the plan acknowledges the SDK spawns the Codex CLI internally, forwards `HOME`, and runs in-process. `dir-walk.js` isolates only `PROMPTFOO_CONFIG_DIR`; it does not isolate `HOME` or Codex state. Parallel scenarios can therefore share `~/.codex` while the SDK-owned CLI subprocesses run concurrently, and the plan has no test proving stdout/stderr from the internal CLI cannot interfere with Promptfoo or that shared Codex state is safe.
   - Lens principle: serialize-shared-state-mutations
   - Recommendation: Give each Codex session an isolated home/state directory or prove the SDK never writes shared mutable state. Add a parallel scenario test with at least two Codex sessions and assert no stdout contamination, no shared-state writes, and clean teardown.

10. [LOW] Phase plans rely on dispatch-resolution tests where behavior tests are required
   - File: plans/260522-1649-harness-plugin-contract-design/phase-10-claude-agent-sdk-provider.md:49, plans/260522-1649-harness-plugin-contract-design/phase-11-opencode-sdk-provider.md:52, plans/260522-1649-harness-plugin-contract-design/phase-12-codex-sdk-provider.md:66, scripts/framework/_node_bridge.js:380, scripts/framework/_node_bridge.js:412
   - Failure scenario: each phase's Layer 2 bridge test is scoped to registry/module resolution and explicitly avoids an NDJSON or callApi round trip. That misses the actual failure surface: `callApi()` config parsing, global/per-kind semaphore acquisition, in-proc versus subprocess branching, workspace injection, and error normalization.
   - Lens principle: prove-it-works
   - Recommendation: Keep cheap registry tests, but add one bridge-level `callApi()` test per new kind using a mock provider that exercises init, multiple turns, finalize, shutdown, and one error path.
