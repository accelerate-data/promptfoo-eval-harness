# promptfoo-eval-harness

Shared Promptfoo + OpenCode eval harness. Owns model/tier policy, provider wiring, package discovery, Promptfoo state export, and artifact guards. Consumers own eval YAML, prompts, fixtures, and assertions.

## Layout

| Path | Owner | Purpose |
| --- | --- | --- |
| `bin/ad-evals.js` | Framework | CLI: `smoke`, `regression`, `run`, `view`, `doctor`, `test`, raw `promptfoo` passthrough |
| `bin/eval-harness-init.sh` | Framework | Bootstrap shell script — scaffolds `tests/evals/` in a consumer repo |
| `scripts/framework/` | Framework | Path/env resolution, package discovery, provider wiring, OpenCode CLI provider, runtime guards |
| `scripts/framework/openhands-agent-server-provider.js` | Framework | OpenHands Agent Server provider (REST + WS, LiteLLM-routed, adapter-configurable) |
| `scripts/*.test.js` | Framework | Harness contract tests run on every CI build |
| `scripts/promptfoo.sh` | Framework | Thin shell wrapper for piping raw flags into the Node CLI |
| `config/eval-tiers.toml` | Framework | Default tier → agent mapping. Templates copy this for new repos |
| `templates/` | Framework | Files copied into consumer repos at init time |
| `examples/harness-smoke/` | Framework | Minimal package config used to verify a fresh install |
| `docs/setup.md` | Docs | Step-by-step setup guide for engineers and coding agents |
| `docs/design.md` | Docs | Framework architecture and ownership boundary |

## Commands

| Command | Effect |
| --- | --- |
| `npm test` | Run framework contract tests (`scripts/*.test.js`, `scripts/framework/*.test.js`) |
| `npm run lint:md` | Markdown lint |
| `bash -n bin/eval-harness-init.sh` | Syntax-check the bootstrap script |

## Rules for New Code

- Framework modules must NOT hardcode consumer-specific paths beyond the canonical `tests/evals/` layout.
- Provider IDs use the `framework://` scheme to reference framework-shipped providers (resolved via `FRAMEWORK_ROOT`).
- The CLI must set `AD_EVALS_ROOT` before any framework module reads it. `roots.js` reads the env var with a `__dirname` fallback for in-package tests.
- Adding a runtime dependency requires updating both `package.json` and the `templates/package.json` if consumers also need it at runtime.
- Shell-only entrypoints stay shell. Do not introduce a Node CLI wrapper around `eval-harness-init.sh`.

## Out Of Scope

- Project-specific assertions, scenarios, fixtures, and `eval-map.json`. Those belong in the consumer repo.
- Live model API keys. The harness never bundles secrets.
- Python/UV tooling. The harness is Node-only.
