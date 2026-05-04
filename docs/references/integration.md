# Integration Reference

Comprehensive guide for engineers integrating the harness into a new
repository. The README covers the happy path; this file covers what the
framework owns, what your repo owns, the full configuration surface, runtime
state, and the common failure modes.

## Ownership Boundary

| Concern | Framework | Consumer |
| --- | --- | --- |
| CLI entrypoint (`ad-evals`) | ✓ | |
| Bootstrap (`eval-harness-init`) | ✓ | |
| Path resolution (repo root, eval root, shared state) | ✓ | |
| Promptfoo / OpenCode environment export | ✓ | |
| Package discovery rules | ✓ | |
| Provider wiring | ✓ | |
| Resolved config materialization | ✓ | |
| Artifact cleanup guard | ✓ | |
| Tier → agent mapping | ✓ (default) | ✓ (per-repo override) |
| `opencode.json` agent definitions (model, steps, permissions) | template | ✓ |
| Package configs (`packages/<name>/promptfooconfig.json`) | | ✓ |
| Prompts, fixtures, vars | | ✓ |
| Domain assertions | | ✓ |
| `eval-map.json` (coding-agent navigation) | | ✓ |
| Scenario inventory and per-package documentation | | ✓ |
| Live model API keys | | ✓ |

The rule of thumb: if it changes runtime mechanics, it belongs to the
framework. If it describes what your prompts should do, it belongs to your
repo.

## Required Repo Layout

After `eval-harness-init`, your repo contains:

```text
tests/evals/
├─ package.json               # consumer; uses scripts that call ad-evals
├─ opencode.json              # consumer; agent definitions (model, steps, perms)
├─ config/eval-tiers.toml     # consumer; tier names + framework:// provider id
├─ packages/
│  └─ <package-name>/
│     ├─ promptfooconfig.json (or .yaml / .yml, or suite.*)
│     └─ prompt.txt           # optional, when the package uses a prompt file
├─ scripts/
│  └─ *.test.js               # consumer-owned contract tests
├─ docs/                      # consumer-owned scenario inventory etc.
└─ .gitignore
```

The framework recognises only these config filenames as runnable packages:
`promptfooconfig.json`, `promptfooconfig.yaml`, `promptfooconfig.yml`,
`suite.json`, `suite.yaml`, `suite.yml`. Other JSON/YAML files in a package
folder are treated as data and ignored by discovery.

## Configuration Surface

### `tests/evals/config/eval-tiers.toml`

The consumer-owned tier policy. The default scaffolded version uses the
`framework://` scheme so the framework's bundled provider is used:

```toml
[runtime]
provider_id = "framework://opencode-cli-provider.js"
opencode_config = "opencode.json"
project_dir = "../.."
format = "default"
log_level = "ERROR"
print_logs = false
empty_output_retries = 1

[tiers.light]
agent = "eval_light"

[tiers.standard]
agent = "eval_standard"

[tiers.high]
agent = "eval_high"

[tiers.x_high]
agent = "eval_x_high"
```

`provider_id` accepts three forms:

- `framework://<file>` — resolves inside the framework package
- `file://<relative>` — resolves relative to your `tests/evals/` directory
- Anything else — passed verbatim to Promptfoo (use this for built-in
  Promptfoo providers)

### `tests/evals/opencode.json`

The consumer-owned agent definitions. Each tier in `eval-tiers.toml` references
an `agent` here. The framework's contract tests do not pin the model name —
swap models, step budgets, and temperatures freely.

### Package configs

Every package config must declare `metadata.eval_tier`. The framework injects
the correct provider block at run time, so package configs must NOT declare
`providers`:

```json
{
  "description": "Behaviour of the foo prompt.",
  "metadata": {
    "eval_tier": "standard"
  },
  "prompts": ["file://prompt.txt"],
  "tests": [
    {
      "description": "[smoke] foo prompt produces structured output",
      "assert": [
        { "type": "javascript", "value": "output.trim().length > 0" }
      ]
    }
  ]
}
```

Every package must include exactly one test whose description starts with
`[smoke]`. The smoke filter is how `npm run eval:smoke` identifies the
minimum-viable test for that package.

## Runtime State

The framework exports state in three classes:

| State | Location | Reason |
| --- | --- | --- |
| Promptfoo config / database | `<git-common-dir>/ad-evals/promptfoo` | Shared across worktrees without symlinks |
| OpenCode state | `<git-common-dir>/ad-evals/opencode-state` | Reuses runtime state across worktrees |
| Promptfoo cache | `tests/evals/.cache/promptfoo` | Worktree-local |
| Promptfoo logs | `tests/evals/results/logs` | Worktree-local |
| Promptfoo media | `tests/evals/output/media` | Worktree-local |
| Temp / resolved configs | `tests/evals/.tmp` | Worktree-local |

Worktree bootstrap scripts must NOT create `tests/evals/.promptfoo` symlinks.
The runtime owns state export — `ad-evals` reads `git rev-parse --git-common-dir`
on every invocation and exports `XDG_STATE_HOME`, `PROMPTFOO_CONFIG_DIR` and
related env vars before running Promptfoo.

Run `npm run doctor` (which calls `ad-evals doctor`) to print resolved paths.
Use this when diagnosing state-resolution issues.

## Cleanup Guard

Promptfoo runs may only write under these prefixes:

- `tests/evals/.cache/`
- `tests/evals/.tmp/`
- `tests/evals/output/`
- `tests/evals/results/`

If a run writes outside those prefixes, the guard restores any new files it
can and exits non-zero. The guard exists to keep package configs, prompts,
fixtures, and assertions free of accidental runtime writes.

## Eval Result Status

For multi-config sweeps (`smoke` and `regression`), Promptfoo exits with
status `100` if any test assertion failed. The framework treats status `100`
as completed execution and continues through remaining packages. Non-`100`
process failures and cleanup guard violations remain hard failures.

This means a green `eval:smoke` run proves every package executed through the
harness; assertion failures are reported as content, not framework failure.
Use this distinction when wiring CI:

- For framework-port verification: pass on status `100`.
- For full regression gates: fail on any non-zero exit.

## Common Failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `metadata.eval_tier` missing | Package config is missing the tier selector | Add `metadata.eval_tier` with `light`, `standard`, `high`, or `x_high` |
| Package data JSON is executed as a config | File is named like a runnable config | Use a non-canonical filename for data; reserve `promptfooconfig.*` and `suite.*` |
| Provider path is unresolved | `eval-tiers.toml` `provider_id` points outside the framework | Use `framework://opencode-cli-provider.js` |
| Promptfoo dirties package files | Eval writes outside generated artifact roots | Move outputs under `.cache/`, `.tmp/`, `output/`, or `results/` |
| `eval:smoke` reports failures but exits cleanly | Scenario assertions failed after execution | Treat as content feedback, not harness-port failure |
| `git rev-parse --show-toplevel` fails inside CI | CI checked out without git history | Set `AD_EVALS_ROOT` explicitly to the absolute path of `tests/evals/` |

## Upgrade Path

The harness is published to npm. Bumping is a normal `npm update` operation:

```bash
npm update @accelerate-data/promptfoo-eval-harness
```

`eval-harness-init` adds a Dependabot entry to `.github/dependabot.yml`
in the consumer repo root that covers `tests/evals/`. Dependabot will
open a PR automatically when a new version is published.

When a major version bumps the wire format (provider scheme, tier schema,
artifact prefixes), the release notes will spell out the migration. The
framework will not silently migrate consumer files.

## Worktree Setup

The consumer's worktree bootstrap (if any) should:

- NOT create `tests/evals/.promptfoo` symlinks
- NOT pre-warm shared state — the runtime exports it

`ad-evals` automatically runs `npm install` in `tests/evals/` on startup
when `package-lock.json` has changed since the last run (tracked via
`node_modules/.install-stamp`), so no explicit install step is needed in
worktree scripts.

If migrating from a pre-extraction layout, remove any worktree script step
that touches Promptfoo state.

## Validation Checklist

After a fresh install:

```bash
cd tests/evals
npm test                     # contract tests
npm run doctor               # print resolved paths
npm run eval:harness-smoke   # one live execution against the smoke package
npm run eval:smoke           # discover and execute every package's smoke
```

If all four succeed, the integration is healthy.
