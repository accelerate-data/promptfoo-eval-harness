# Changelog

All notable changes to `@accelerate-data/promptfoo-eval-harness` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versions follow
[Semantic Versioning](https://semver.org/).

---

## [Unreleased]

---

## [1.7.2] — TBD

### Fixed

- `_buildBridgeProviderEntry()` (`scripts/framework/resolve-promptfoo-config.js`) now
  merges `config/eval-tiers.toml`'s shared `[runtime]` defaults
  (`opencode_config`, `project_dir`, `format`, `log_level`, and any other
  `[runtime]`-level field) into a v1 tier provider entry's config when the
  entry itself doesn't declare that field, for both the standard bridge
  branch and the `openhands_agent_server` branch. `[runtime].provider_id`
  is excluded (it is a v0-only field, not a per-provider config field).
  Entry-declared fields still win over `[runtime]` defaults. Fixes every
  v1-tier package that relies on `[runtime]` for shared defaults instead of
  repeating them per-provider — the gap VD-3912 didn't close (VD-3913).

---

## [1.7.1] — TBD

### Fixed

- `resolveConfigFile()` / `_buildBridgeProviderEntry()` (`scripts/framework/resolve-promptfoo-config.js`)
  no longer nests a v1 tier-config provider entry's per-provider fields
  (`agent`, `opencode_config`, `extra`, `openhands_config`, …) under a
  `config.provider_options` bag. They now land at the top level of the
  emitted provider config, matching what every bridge-routed provider
  module (`opencode-cli-provider.js`, `opencode_sdk`, `codex_sdk`,
  `openhands_sdk`'s `agent_factory.py`) already reads directly off its
  config object. Previously, nesting under `provider_options` silently
  dropped every consumer field a v1-configured provider needed —
  including OpenHands gateway mode's `extra.base_url`, which could never
  activate for a v1-configured `openhands_sdk` tier (VD-3912).

---

## [1.7.0] — TBD

### Summary

Adds an idle/stall watchdog to `openhands-agent-server-provider.js`,
matching the behavior the legacy `openhands-provider.js` already had
(VD-3814).

### Added

- `OPENHANDS_STREAM_IDLE_TIMEOUT_MS` (default `900000` / 15 min) —
  if the OpenHands agent-server WebSocket event stream goes silent for
  longer than this, the provider concludes the turn with whatever
  partial output it has collected instead of hanging until the outer
  Promptfoo timeout.

---

## [1.6.0] — TBD

### Summary

Closes a silent provider-override bug (VD-3792): a package config that
declared its own `providers` array had that array discarded and replaced
by the tier-derived provider block with no warning, so a package could
believe it was running against a specific provider (e.g. an
OpenHands/Docker-backed one) and never actually exercise it.

### Fixed

- `resolveConfigFile()` (`scripts/framework/resolve-promptfoo-config.js`)
  now throws immediately — before any v0/v1/multi-turn resolution runs —
  when a package config declares its own `providers` field. The error
  names the offending package path and points at the fix: drop
  `providers` and rely on `metadata.eval_tier` (migrating
  `config/eval-tiers.toml` to the v1 shape with a
  `provider_kind = "openhands_agent_server"` or `openhands_sdk` tier
  entry, if an OpenHands-backed run is needed).

### Breaking

- A package config that previously declared `providers` alongside
  `metadata.eval_tier` — and silently ran against the tier-derived
  provider instead — now fails fast at config-resolution time. Remove
  the package-level `providers` field to restore the (previously
  silently-substituted) tier-derived behavior.

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
