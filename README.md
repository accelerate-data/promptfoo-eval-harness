# @accelerate-data/promptfoo-eval-harness

Shared Promptfoo + OpenCode eval harness. Owns model/tier policy, provider
wiring, package discovery, Promptfoo state export, and artifact guards.
Consumers own eval YAML, prompts, fixtures, and assertions.

## Quick Start

Bootstrap a new repo:

```bash
npx @accelerate-data/promptfoo-eval-harness eval-harness-init
```

This scaffolds `tests/evals/` with `package.json`, `opencode.json`,
`config/eval-tiers.toml`, and a `harness-smoke` package, installs
dependencies, and adds a Dependabot entry to `.github/dependabot.yml`
so the repo receives PRs when a new version is released.

Verify the install:

```bash
cd tests/evals
npm test                     # contract tests
npm run doctor               # print resolved paths
npm run eval:harness-smoke   # one live execution
npm run eval:smoke           # smoke across all packages
```

Dependencies are installed automatically on the first `ad-evals` run
and re-installed whenever `package-lock.json` changes.

## Usage

```bash
# Run the smoke filter across all packages
npm run eval:smoke

# Run all tests in all packages
npm run eval:regression

# Run one package
node bin/ad-evals.js run packages/my-feature/promptfooconfig.json

# Open the Promptfoo UI
npm run view

# Print resolved state paths
npm run doctor
```

## Documentation

| Doc | What it covers |
| --- | --- |
| [Integration Reference](docs/references/integration.md) | Full integration guide: layout, config surface, runtime state, common failures, upgrade path |
| [Writing a Package](docs/guides/writing-a-package.md) | How to create an eval package with configs, prompts, fixtures, and assertions |
| [Running Evals](docs/guides/running-evals.md) | Smoke, regression, targeted, CI wiring, worktree setup |
| [Design](docs/references/design.md) | Framework architecture and ownership boundary |

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
