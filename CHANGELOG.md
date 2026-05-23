# Changelog

All notable changes to `@accelerate-data/promptfoo-eval-harness` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versions follow
[Semantic Versioning](https://semver.org/).

---

## [Unreleased]

<!-- Add entries for unreleased changes here. -->

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

[Unreleased]: https://github.com/accelerate-data/promptfoo-eval-harness/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/accelerate-data/promptfoo-eval-harness/releases/tag/v1.0.0
