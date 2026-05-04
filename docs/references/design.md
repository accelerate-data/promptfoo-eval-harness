# Shared Eval Harness Design

> **Primary code:** `bin/ad-evals.js`, `scripts/framework/`

## Overview

The shared eval harness separates reusable Promptfoo/OpenCode execution mechanics from project-owned eval content. The framework owns model and tier policy, runtime environment setup, provider wiring, Promptfoo state export, config materialization, package discovery, and cleanup guards. Projects keep package configs, prompts, fixtures, assertions, and scenario rationale under `tests/evals/`.

Published to npm as `@accelerate-data/promptfoo-eval-harness`. Consumer repos install it via `npx @accelerate-data/promptfoo-eval-harness eval-harness-init`.

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

## Open Questions

1. `[extraction]` What package name and versioning policy should the standalone harness use?
2. `[extraction]` Should project-owned `eval-map.json` be hand-maintained, generated, or both?
3. `[ci]` Should CI treat `eval:smoke` status `100` as success everywhere, or only for framework-port verification jobs?
