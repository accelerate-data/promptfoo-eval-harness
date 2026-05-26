# @accelerate-data/promptfoo-eval-harness

Shared Promptfoo + OpenCode eval harness. Owns model/tier policy, provider
wiring, package discovery, Promptfoo state export, and artifact guards.
Consumers own eval YAML, prompts, fixtures, and assertions.

## Providers

All providers route through the single Promptfoo bridge
`file://scripts/framework/_node_bridge.js`. Set `provider_kind` in the
provider `config:` block to select a provider.

| `provider_kind` | Status | Model alias examples | Notes |
| --- | --- | --- | --- |
| `opencode_cli` | stable | `opencode-mock`, `opencode-anthropic` | In-process; requires `opencode` binary on `PATH`. |
| `openhands_sdk` | stable | `mock/openhands-mock`, `openhands/anthropic-claude-3-5-sonnet` | Subprocess via `uv run --with openhands-sdk==1.22.1`; supports multi-turn. |
| `claude_agent_sdk` | stable | `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` (aliases: `opus`, `sonnet`, `haiku`) | Subprocess via `uv run --with claude-agent-sdk==0.2.85`; async lifecycle; multi-turn via stateful `ClaudeSDKClient`; default tools `Read`/`Write`/`Edit`/`Glob`/`Grep` (Bash & web gated via `permissions.allow_shell` / `allow_web`). |
| `opencode_sdk` | stable | `anthropic/claude-sonnet-4-6`, `openai/gpt-4o` (any model the OpenCode server accepts) | In-proc Node provider via `@opencode-ai/sdk`; boots an ephemeral `127.0.0.1:0` OpenCode server per run, dispatches turns through one `client.session.prompt` per case; agents limited to `{build, plan, general}`; requires Node ≥ 20. |
| `codex_sdk` | stable | `gpt-4o`, `gpt-4.1` (any model the Codex SDK accepts) | In-proc Node provider via `@openai/codex-sdk` (CJS); reserves a per-session HOME and a per-case `git init`-ed workspace before invoking `Codex.startThread`; multi-turn via a single Thread; defaults `sandbox_mode=workspace-write` and `model_reasoning_effort=medium` (overridable via `extra`); requires Node ≥ 20. |

### Plugin Glue Providers

Plugin glue providers wrap or augment the bridge-routed kinds above with
runtime metadata, auto-reply gates, plugin discovery, and run telemetry.
They are referenced from tier scenarios via the `framework://` URL scheme
and consume the new optional `[runtime]` fields documented in
[`docs/setup.md`](docs/setup.md).

| Wrapper | Wraps | Reads (optional `[runtime]` fields) |
| --- | --- | --- |
| `framework://codex-sdk-provider.js` | `codex_sdk` (via bridge) | `bootstrap_prompt`, `agent_id`, `agent_entrypoint_file`, `opencode_config`, `model`, `project_dir` |
| `framework://claude-agent-sdk-provider.js` | `claude_agent_sdk_node` (Node-side, NOT the Python `claude_agent_sdk` bridge) | `bootstrap_prompt`, `auto_reply_text`, `max_auto_replies`, `idle_turn_stop`, `plugin_subdirs`, `agent_id`, `agent_entrypoint_file`, `opencode_config`, `model`, `empty_output_retries` |
| `framework://opencode-cli-plugin-provider.js` | `opencode_cli` (sibling of `framework://opencode-cli-provider.js`) | `bootstrap_prompt`, `opencode_plugin_link_path`, `capture_on_failure`, `write_run_metadata`, `load_local_env`, `opencode_parser_module`, `opencode_runner_command`, `agent_id`, `agent_entrypoint_file` |

The base `framework://opencode-cli-provider.js` (the locked §7.4 contract)
is byte-identical and stays the default for non-plugin scenarios; the
plugin sibling composes the base without subclassing it. The Claude
wrapper introduces a **second** transport (`claude_agent_sdk_node`)
alongside the existing Python-bridge `claude_agent_sdk` kind — see
[`docs/design.md`](docs/design.md) for when to pick which.

## Scenarios

Framework-owned mock-mode scenarios under
[`tests/harness-scenarios/packages/`](tests/harness-scenarios/packages/).
All run without live API keys and are exercised by the nightly CI
workflow on `main`.

| Scenario | `provider_kind` | Description |
| --- | --- | --- |
| [`minimal-smoke`](tests/harness-scenarios/packages/minimal-smoke/README.md) | `opencode_cli` | Single-turn smoke test that exercises the bridge end-to-end. |
| [`opencode-cli-compatibility`](tests/harness-scenarios/packages/opencode-cli-compatibility/README.md) | `opencode_cli` | Layer 4 regression locking all five §7.4 `opencode_cli` behaviors; 3 cases. |
| [`openhands-mock-multi-turn`](tests/harness-scenarios/packages/openhands-mock-multi-turn/README.md) | `openhands_sdk` | 3-turn conversation via mock SDK; validates NDJSON IPC multi-turn path. |
| [`claude-mock-multi-turn`](tests/harness-scenarios/packages/claude-mock-multi-turn/README.md) | `claude_agent_sdk` | Multi-turn through the Python `claude_agent_sdk` kind with deterministic mock responses. |
| [`codex-sdk-mock-multi-turn`](tests/harness-scenarios/packages/codex-sdk-mock-multi-turn/README.md) | `codex_sdk` | Multi-turn through the in-proc `codex_sdk` kind. |
| [`opencode-sdk-mock-multi-turn`](tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn/README.md) | `opencode_sdk` | Multi-turn through the in-proc `opencode_sdk` kind (ephemeral server). |

See [Setup Guide → Scenarios](docs/setup.md#scenarios) for the
`vars.turns` multi-turn pattern and consumer-package authoring rules.

## Quick Start

Bootstrap a new repo:

```bash
npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init
```

This scaffolds `tests/evals/` with `package.json`, `opencode.json`,
`config/eval-tiers.toml`, and a `harness-smoke` package, installs
dependencies, and adds a Dependabot entry to `.github/dependabot.yml`
so the repo receives PRs when a new version is released.

Smoke-test the install immediately (no live API key needed):

```bash
OPENCODE_MOCK_MODE=1 npx ad-evals run tests/harness-scenarios/packages/minimal-smoke
```

Verify the full install:

```bash
cd tests/evals
npm test                     # contract tests
npm run doctor               # print resolved paths
npm run eval:harness-smoke   # one live execution
npm run eval:smoke           # smoke across all packages
```

Dependencies are installed automatically on the first `ad-evals` run
and re-installed whenever `package-lock.json` changes.

### Migration from v0

v0 tier configs (no `provider_kind` field) are accepted at runtime but deprecated.
Run the in-place migration to avoid a v1.1.0 breaking change:

```bash
npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init --upgrade --migrate-from-v0
```

Full guide: [`docs/migration-v0-to-v1.md`](docs/migration-v0-to-v1.md)

## Usage

```bash
# Run the smoke filter across all packages
npm run eval:smoke

# Run all tests in all packages
npm run eval:regression

# Run one package
ad-evals run packages/my-feature/promptfooconfig.json

# Open the Promptfoo UI
npm run view

# Print resolved state paths
npm run doctor
```

## Documentation

| Doc | What it covers |
| --- | --- |
| [Setup Guide](docs/setup.md) | Bootstrap, verify, write a package, run evals, wire CI; also covers [scenarios](docs/setup.md#scenarios), [provider key matrix](docs/setup.md#provider-key-matrix), [parallelism](docs/setup.md#parallelism), [multi-turn evals](docs/setup.md#multi-turn-conversational-evals), [LLM judge & custom assertions](docs/setup.md#llm-judge--custom-assertions), [workspace isolation & git ops](docs/setup.md#workspace-isolation--git-operations) — give this to a coding agent |
| [Design](docs/design.md) | Framework architecture and ownership boundary |
| [Changelog](CHANGELOG.md) | Release notes per version |

## What the Framework Owns

- CLI entrypoint (`ad-evals`)
- Bootstrap (`eval-harness-init`)
- Path resolution across worktrees
- Promptfoo and OpenCode environment export
- Package discovery rules
- Provider wiring
- Resolved config materialization
- Artifact cleanup guard
- Default tier → agent mapping

## What Your Repo Owns

- `opencode.json` agent definitions (model, steps, permissions)
- Package configs under `packages/<name>/`
- Prompts, fixtures, vars
- Domain assertions
- Scenario inventory and per-package documentation

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
