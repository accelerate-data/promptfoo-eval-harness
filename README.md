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
| `opencode_sdk` | planned | — | Phase 3 (v1.2.0). |
| `codex_sdk` | planned | — | Phase 4 (v1.3.0). |

## Scenarios

Framework-owned mock-mode scenarios under
[`tests/harness-scenarios/packages/`](tests/harness-scenarios/packages/):

| Scenario | Description |
| --- | --- |
| [`minimal-smoke`](tests/harness-scenarios/packages/minimal-smoke/README.md) | Single-turn `opencode_cli` smoke test; no live API key required. |
| [`opencode-cli-compatibility`](tests/harness-scenarios/packages/opencode-cli-compatibility/README.md) | Layer 4 regression locking all five §7.4 `opencode_cli` behaviors; 3 cases. |
| [`openhands-mock-multi-turn`](tests/harness-scenarios/packages/openhands-mock-multi-turn/README.md) | 3-turn `openhands_sdk` via mock SDK; validates NDJSON IPC multi-turn path. |

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
| [Setup Guide](docs/setup.md) | Bootstrap, verify, write a package, run evals, wire CI — give this to a coding agent |
| [Design](docs/design.md) | Framework architecture and ownership boundary |

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
