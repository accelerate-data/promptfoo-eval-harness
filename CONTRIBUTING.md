# Contributing

## Development

```bash
git clone https://github.com/accelerate-data/promptfoo-eval-harness.git
cd promptfoo-eval-harness
npm install
npm test
```

## Branch Naming

| Prefix | Use |
| --- | --- |
| `feature/` | New functionality |
| `fix/` | Bug fixes |
| `chore/` | Tooling, CI, dependencies |
| `docs/` | Documentation only |
| `refactor/` | Code restructuring with no behavior change |

## Pull Request Requirements

- **Title**: `VD-XXX: Short description` (or `feat:` / `fix:` for non-Linear contributions)
- **Body**: Include `Fixes VD-XXX` to auto-link the Linear ticket when applicable.
- **CI**: All required checks must pass.
- **Review**: At least 1 human approval. Squash merge to `main`.

## What Lives in This Package

- `bin/`, `scripts/framework/`, `config/eval-tiers.toml`: framework-owned. Edits here change behavior for every consumer.
- `templates/`, `examples/`: scaffolded into consumer repos by `eval-harness-init`. Edits change the starting point for new adopters but do not retroactively update existing installs.
- `docs/`: published documentation.

Any change that affects framework runtime behavior must include or update tests under `scripts/` or `scripts/framework/`.

## Reporting Vulnerabilities

See [SECURITY.md](./SECURITY.md).
