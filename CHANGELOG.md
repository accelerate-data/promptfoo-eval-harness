# Changelog

All notable changes to `@accelerate-data/promptfoo-eval-harness` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versions follow
[Semantic Versioning](https://semver.org/).

---

## [Unreleased]

<!-- Add entries for unreleased changes here. -->

---

## [1.5.1] — TBD

### Fixed

- **D1** Bridge NDJSON framing now buffers across stdout chunks (no more spurious `Malformed NDJSON` on heavy turns).
- **D2** Bridge honors the harness-prepared `context.vars.workspace` at both the single-turn and multi-turn call-sites.
- **D3** `openhands_sdk` wires `AgentContext` (consumer plugin skills + system-message suffix) instead of running plugin-blind.
- **D4** `openhands_sdk` falls back to the `finish` tool's `message` when turn text is otherwise empty.
- **D5** `opencode_cli` honors `OPENCODE_MODEL` by injecting `--model` into the run argv.
- **D6** Directory mode resolves the `promptfoo` entrypoint across hoisted/pnpm/nested installs.
- **D8** Directory mode spawns Promptfoo with `cwd = EVAL_ROOT` so dotenv finds `tests/evals/.env`.
- **D9** `openhands_sdk` provider test imports its provider via the canonical `scripts.framework.providers.openhands_sdk.provider` path (matching the `claude_agent_sdk` test), so a whole-suite `pytest --import-mode=importlib` run no longer resolves the bare `provider` module to the wrong sibling and fails 15 tests.

### Added

- **D7** `AD_EVALS_INIT_TIMEOUT_MS` (default `600000`) scales the subprocess `init` handshake separately from per-turn bounds.

---

## [1.5.0] — TBD

### Summary

Ports the three plugin-glue providers from the `vibedata-data-engineering`
consumer into the harness so any repo can opt into bootstrap-prompt
injection, Claude streaming-input + auto-reply, and OpenCode CLI
plugin metadata by pinning a published harness version. The base
`scripts/framework/opencode-cli-provider.js` (§7.4 contract) remains
byte-identical; plugin features live in a new sibling wrapper. Tracked
under VD-2174-12.

### Added

- Plugin glue providers in `scripts/framework/`:
  - `codex-sdk-provider.js`: tier → `codex_sdk` bridge wrapper with
    `bootstrap_prompt` injection and workspace precedence.
  - `claude-agent-sdk-provider.js`: Node-side streaming-input + auto-reply
    gate + `qa-log.jsonl` (NEW transport `claude_agent_sdk_node`;
    coexists with the existing Python `claude_agent_sdk` bridge).
  - `opencode-cli-plugin-provider.js`: NEW sibling of
    `opencode-cli-provider.js`. Adds plugin hooks (`bootstrap_prompt`,
    `opencode_plugin_link_path`, `capture_on_failure`,
    `write_run_metadata`, `load_local_env`, `opencode_parser_module`).
    Base provider unchanged.
- 15 new optional `[runtime]` fields validated by
  `eval-tier-config.js` and exposed via `ALLOWED_RUNTIME_FIELDS`:
  `agent_id`, `agent_entrypoint_file`, `bootstrap_prompt`,
  `auto_reply_text`, `max_auto_replies`, `idle_turn_stop`,
  `plugin_subdirs`, `opencode_runner_command`,
  `opencode_plugin_link_path`, `model`, `capture_on_failure`,
  `write_run_metadata`, `load_local_env`, `opencode_parser_module`,
  `empty_output_retries`.
- `scripts/framework/provider-run-metadata.js` utility (`writeProviderRunMetadata`,
  `writeTrajectory`) for emitting `<workspace>/.eval-run/{provider,trajectory}.json`.
- Contract tests:
  - `scripts/framework/opencode-cli-plugin-provider.test.js` (25 tests
    locking sibling shape, parser dual-shape resolution, plugin-link
    detection, run-metadata emission, base byte-identity).
  - `scripts/framework/runtime-fields-allowlist.test.js` (static scan
    ensures every `cfg.<field>` read in the wrappers is in
    `ALLOWED_RUNTIME_FIELDS` or `ALLOWED_TIER_FIELDS`).
  - Fixtures under `tests/_fixtures/opencode-plugin-parsers/` for both
    parser module shapes plus a negative case.
- `docs/setup.md` expanded with six new sections aimed at consumers
  porting evals across repos: Scenarios (harness-shipped table +
  consumer-package authoring), Provider Key Matrix (env vars per
  `provider_kind` + tier-swap pattern), Parallelism (outer
  `AD_EVALS_OUTER_CONCURRENCY` vs inner `--max-concurrency`), Multi-turn
  Conversational Evals (`vars.turns` JSON-array pattern +
  `claude_agent_sdk_node` auto-reply gate), LLM Judge & Custom
  Assertions (llm-rubric + `file://`-backed assertion pattern), and
  Workspace Isolation & Git Operations (`beforeEach` extension hook
  with fixture-copy + plugin symlink + setup script + `.run-started-at`
  timestamp).
- `README.md` Scenarios table now lists all six harness-shipped
  scenarios (added `claude-mock-multi-turn`,
  `codex-sdk-mock-multi-turn`, `opencode-sdk-mock-multi-turn`) and
  links to the new setup.md sections from the Documentation table.

### Changed

- `scripts/framework/eval-tier-config.js`: now exports
  `ALLOWED_RUNTIME_FIELDS`, `REQUIRED_RUNTIME_FIELDS`,
  `OPTIONAL_RUNTIME_FIELDS`, and `ALLOWED_TIER_FIELDS` so the allowlist
  guard rail has a single source of truth.
- `scripts/framework/index.js`: re-exports
  `makeCodexSdkProvider`, `makeClaudeAgentSdkProvider`, and
  `makeOpenCodeCliPluginProvider` factories.

### Coordinated consumer changes (separate PR after this version publishes)

- Consumer's `tests/evals/scripts/{codex-sdk-provider,claude-agent-sdk-provider,opencode-provider,provider-run-metadata}.js`
  to be deleted (replaced by harness equivalents).
- `parse-opencode-json.js` stays in the consumer; wired via the
  `opencode_parser_module` runtime field.

---

## [1.0.0] — 2026-05-23

### Summary

This release refactors the harness from a thin OpenHands HTTP wrapper into a
**4-SDK plugin contract**. v1.0.0 ships two providers: **OpenCode CLI** (preserved
from v0 and locked by contract tests) and **OpenHands SDK** (new, via
`uv run --with openhands-sdk==1.22.1`). Three additional SDKs — Claude Agent SDK,
OpenCode SDK, and Codex SDK — are staged as `KIND_REGISTRY` slots for Phases 2-4
and marked `planned` in the provider matrix. The single `file://scripts/framework/_node_bridge.js`
Promptfoo bridge replaces the previous per-provider URL pattern. A scenario harness,
dir-walk run mode, structured logger, secret redactor, and `--upgrade --migrate-from-v0`
CLI flag ship alongside.

### Added

- **OpenHands SDK provider** (`provider_kind: openhands_sdk`): drives multi-turn
  conversations via `uv run --with openhands-sdk==1.22.1`; IPC over NDJSON on
  stdin/stdout; adapter at `scripts/framework/providers/_python_adapter.py`.
- **Scenario harness** with 3 mock-mode scenarios under
  `tests/harness-scenarios/packages/`:
  - `minimal-smoke` — single-turn opencode_cli smoke (no live key).
  - `opencode-cli-compatibility` — Layer 4 regression, 3 cases, locks §7.4 behaviors.
  - `openhands-mock-multi-turn` — 3-turn openhands_sdk via mock SDK (no live key).
- **`ad-evals run <dir>`** directory-walk mode: discovers every `promptfooconfig.json`
  under the given path and fans out with outer p-limit concurrency control.
- **`eval-harness-init --upgrade --migrate-from-v0`**: in-place v0→v1 tier config
  rewrite; idempotent; prints diff before writing.
- **Structured NDJSON logger** to stderr (`scripts/framework/_structured_logger.js`):
  replaces ad-hoc `console.error` calls; consumed by CI log parsers.
- **Defense-in-depth secret redactor** (Node + Python parity): strips `*_API_KEY`,
  `*_TOKEN`, `*_SECRET`, and `sk_*` patterns from provider error messages and
  NDJSON events before they reach Promptfoo output or CI logs.
- **Workspace post-run assertion** in `run-promptfoo-with-guard`: verifies the
  Promptfoo workspace was cleaned up after each scenario run.
- **`ad-evals doctor --install-providers`**: uv-run pre-warm step that fetches and
  caches `openhands-sdk` offline-safe; designed for use in CI setup.
- **`config/sdk-pins.toml`**: framework-owned single source of truth for SDK
  version pins and per-provider env allowlists. Consumers do not override this.
- **Nightly CI workflow** (`.github/workflows/nightly-scenarios.yml`): runs all
  `requires_live_key=false` scenarios on `main` at 02:00 UTC.

### Changed

- **Single Promptfoo bridge URL**: all provider kinds now route through
  `file://scripts/framework/_node_bridge.js`. Previously each provider used a
  separate `file://` path. Consumer configs using the old per-provider URLs must
  update to the single bridge.
- **v1 tier shape**: `eval-tiers.toml` entries now require an explicit
  `provider_kind` field per tier. The v0 shape (no `provider_kind`) is still
  accepted via auto-normalization at load time and will be deprecated in v1.1.0.
  Use `eval-harness-init --upgrade --migrate-from-v0` to rewrite in place.

### Breaking Changes

- Consumers relying on **private exports** from
  `scripts/framework/opencode-cli-provider.js` directly (not via the bridge) must
  migrate. The public interface is `file://scripts/framework/_node_bridge.js` with
  a `config.provider_kind` field in the Promptfoo provider config block.
- v0 tier configs **without `provider_kind`** are accepted at runtime (v1 tolerates
  both shapes) but will be **removed in v1.1.0**. Run
  `eval-harness-init --upgrade --migrate-from-v0` to rewrite in place — idempotent
  and safe to run multiple times.

**Migration guide:** [`docs/migration-v0-to-v1.md`](docs/migration-v0-to-v1.md)

---

[Unreleased]: https://github.com/accelerate-data/promptfoo-eval-harness/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/accelerate-data/promptfoo-eval-harness/releases/tag/v1.5.0
[1.0.0]: https://github.com/accelerate-data/promptfoo-eval-harness/releases/tag/v1.0.0
