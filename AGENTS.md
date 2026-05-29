# promptfoo-eval-harness

Shared Promptfoo + OpenCode eval harness. Owns model/tier policy, provider wiring, package discovery, Promptfoo state export, and artifact guards. Consumers own eval YAML, prompts, fixtures, and assertions.

## Layout

| Path | Owner | Purpose |
| --- | --- | --- |
| `bin/ad-evals.js` | Framework | CLI: `smoke`, `regression`, `run`, `view`, `doctor`, `test`, raw `promptfoo` passthrough |
| `bin/eval-harness-init.sh` | Framework | Bootstrap shell script — scaffolds `tests/evals/` in a consumer repo |
| `scripts/framework/` | Framework | Path/env resolution, package discovery, provider wiring, OpenCode CLI provider, runtime guards |
| `scripts/*.test.js` | Framework | Harness contract tests run on every CI build |
| `scripts/promptfoo.sh` | Framework | Thin shell wrapper for piping raw flags into the Node CLI |
| `config/eval-tiers.toml` | Framework | Default tier → agent mapping. Templates copy this for new repos |
| `templates/` | Framework | Files copied into consumer repos at init time |
| `examples/harness-smoke/` | Framework | Minimal package config used to verify a fresh install |
| `docs/setup.md` | Docs | Step-by-step setup guide for engineers and coding agents |
| `docs/design.md` | Docs | Framework architecture and ownership boundary |

## Commands (this repo)

| Command | Effect |
| --- | --- |
| `npm test` | Run framework contract tests (`scripts/*.test.js`, `scripts/framework/**/*.test.js`, `scripts/framework/providers/**/*.test.*js`) |
| `npm run lint:md` | Markdown lint |
| `npm run bench` | `bench:spawn-cost` + `bench:throughput` gates (CI must not set `BENCH_OVERRIDE_REASON`) |
| `bash -n bin/eval-harness-init.sh` | Syntax-check the bootstrap script |

## Setup (consumer repo)

Detailed walkthrough lives in `docs/setup.md`. Quickstart:

1. `npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init` — scaffolds `tests/evals/` with `package.json`, `opencode.json`, `config/eval-tiers.toml`, `packages/harness-smoke/`, and a copy of `templates/AGENTS.md` as `tests/evals/AGENTS.md` (the LLM-facing onboarding doc for teammates).
2. `cd tests/evals && npm test && npm run doctor && npm run eval:harness-smoke` — all three must pass before adding packages.
3. Add packages under `tests/evals/packages/<name>/promptfooconfig.{json,yaml}`. Each package MUST set `metadata.eval_tier` (`light|standard|high|x_high`) and contain exactly one `[smoke]`-prefixed test. Do NOT declare a `providers` block — the framework injects it from `config/eval-tiers.toml`.

Prereqs: Node ≥ 20 (SDK providers require it), `opencode --version` resolves if you use `opencode_cli`, `uv` on PATH if you use the Python subprocess providers, Claude Code allows `Bash(npx *)` (see `CLAUDE.md`).

**For teammates onboarding with an LLM (Claude Code, opencode, codex CLI, …):** point the LLM at the scaffolded `tests/evals/AGENTS.md` (canonical source: [`templates/AGENTS.md`](./templates/AGENTS.md)). It is ordered top-to-bottom for an LLM-runnable workflow — first-time setup, picking a `provider_kind`, writing a package, running, diagnosing, and the gotchas list that catches the operational pitfalls we've hit in practice (`OPENHANDS_BASE_URL` leak, darwin lockfile drift, `openhands_sdk` + small-model tool calls, etc.).

## Providers

`config/eval-tiers.toml` binds each tier to one `provider_kind`. Pick per tier; full matrix + permission gates live in `docs/design.md` §"Provider matrix". Cheat sheet:

| `provider_kind` | Mode | Pick when |
| --- | --- | --- |
| `opencode_cli` | inproc Node (spawns `opencode` CLI) | OpenCode CLI is on `PATH` and you want zero per-call Node/Python overhead |
| `opencode_sdk` | inproc Node (`@opencode-ai/sdk@1.15.10`) | OpenCode agents via typed SDK; harness auto-boots a fresh `127.0.0.1:0` server per case (dynamic port) and shuts it down in `finalize` |
| `codex_sdk` | inproc Node (`@openai/codex-sdk@0.133.0`) | Codex/GPT-family with explicit `sandbox_mode` / `model_reasoning_effort` controls |
| `openhands_sdk` | subprocess (`uv run --with openhands-sdk@<pin>`) | OpenHands agent loop; supports gateway mode (`model` + `base_url` + `OPENHANDS_API_KEY`) for any OpenAI-compatible endpoint |
| `claude_agent_sdk` | subprocess (`uv run --with claude-agent-sdk@<pin>`) | Claude as the eval target; multi-turn + file-edit tools; permission gates on `Bash` / `WebSearch` / `WebFetch` |

Selection guidance:

- **Multi-turn isolation** → `opencode_sdk`, `codex_sdk`, `claude_agent_sdk`. Each Promptfoo case gets its own session/server; state never leaks across cases.
- **Cost + tokens** → SDK providers expose `cost_usd` and per-session token counts via `finalize` metadata; `opencode_cli` does not.
- **Lowest latency** → `opencode_cli` (no SDK import, no server boot).
- **No external binary on PATH** → SDK providers (server/runtime spawned in-proc per case).
- **Parallel runs** → multi-model AND multi-scenario parallelism use the `concurrency.js` hierarchical semaphore; SDK providers run on isolated dynamic ports so the bottleneck is upstream model rate limits, not local resources.

### OpenHands gateway mode (v1.4.0)

Point `openhands_sdk` at any OpenAI-compatible endpoint (Accelerate gateway, LiteLLM proxy, vLLM, …) with two inputs: a model name and a `base_url`. Auth collapses to a single env var `OPENHANDS_API_KEY` — the LiteLLM prefix-routing alias table is bypassed and the model name passes through verbatim.

Tier config (`config/eval-tiers.toml`, v1 schema):

```toml
[[tiers.standard.providers]]
provider_kind = "openhands_sdk"
model = "gpt-4o"

[tiers.standard.providers.extra]
base_url = "https://gateway.internal/v1"
```

Then `export OPENHANDS_API_KEY=sk-...` in the consumer repo's `.env`. Omit `base_url` to fall back to the legacy `_MODEL_MAP` resolver + `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` prefix routing. Full reference: `docs/setup.md` → "OpenHands SDK — gateway mode".

## Running evals (consumer repo)

Run from the consumer repo's `tests/evals/` directory:

| Command | Effect |
| --- | --- |
| `npm run eval:smoke` | Every `[smoke]`-prefixed test across all packages. Exit 100 = assertion failed (NOT a harness failure). |
| `npm run eval:regression` | Every test in every package — use as a blocking quality gate |
| `ad-evals run packages/<name>/promptfooconfig.json` | One specific package |
| `ad-evals view` | Open the Promptfoo viewer for the latest run |
| `ad-evals doctor [--install-providers]` | Print resolved paths; `--install-providers` pre-warms uv-backed SDKs |
| `npm test` | Framework contract tests (deterministic, no API calls) |

Per-case lifecycle for SDK providers (`opencode_sdk`, `codex_sdk`): every call goes through `init → turn[*] → finalize → shutdown`. `init()` boots a fresh ephemeral server on a dynamic port; `shutdown()` closes it within 5 s. There is no long-lived daemon and no port pinning — verified end-to-end against both the mock and the real SDKs.

Secrets must be present in `process.env` before invocation — the harness has no dotenv loader at the framework level. Consumers keep keys in `tests/evals/.env`, add that path to `.gitignore` themselves (the bootstrap does NOT auto-ignore it), and either `set -a; . tests/evals/.env; set +a` from their shell rc / CI step before running, OR opt into `framework://opencode-cli-plugin-provider.js` with `load_local_env = true` in `[runtime]` (the plugin variant auto-reads `<repo-root>/.env` then `tests/evals/.env`). The framework never bundles or ships keys. Step-by-step (including the per-`provider_kind` env-var matrix and the leaked `OPENHANDS_BASE_URL` gotcha): `docs/setup.md` → "Step 1.5 — Configure secrets".

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
