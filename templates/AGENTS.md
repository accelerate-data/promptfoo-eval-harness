# Eval Harness — Agent Instructions

This directory (`tests/evals/`) is the eval suite for this repo. It uses
`@accelerate-data/promptfoo-eval-harness` to run Promptfoo evaluations against
OpenCode agents.

## Adding an eval package

1. Create a directory under `packages/`:

   ```text
   tests/evals/packages/<feature-name>/
   ├─ promptfooconfig.json
   └─ prompt.txt
   ```

2. `promptfooconfig.json` must have:
   - `metadata.eval_tier` — one of `light`, `standard`, `high`, `x_high`
   - At least one test whose description starts with `[smoke]`
   - No `providers` block — the framework injects it

   Minimal example:

   ```json
   {
     "description": "Behaviour of the <feature> prompt.",
     "metadata": { "eval_tier": "standard" },
     "prompts": ["file://prompt.txt"],
     "tests": [
       {
         "description": "[smoke] <feature> returns non-empty output",
         "assert": [{ "type": "javascript", "value": "output.trim().length > 0" }]
       }
     ]
   }
   ```

3. Write the prompt in `prompt.txt`.

## Running evals

```bash
cd tests/evals

npm test                # contract tests — no API calls
npm run eval:smoke      # smoke test every package
npm run eval:regression # all tests in all packages

# Run a single package via the harness CLI:
ad-evals run packages/<feature>/promptfooconfig.json
```

Exit code `100` from a smoke or regression run means the harness ran but an
assertion failed. That is content feedback — the harness is working correctly.

## Tier selection

| Tier | When to use |
| --- | --- |
| `light` | Single-turn, structured-output prompts |
| `standard` | Most scenarios |
| `high` | Multi-step or research tasks |
| `x_high` | Full workflow or expensive graders |

## Rules

- Every package must have **exactly one** `[smoke]` test.
- Never declare `providers` in a package config.
- Config files must be named `promptfooconfig.json`, `promptfooconfig.yaml`,
  `promptfooconfig.yml`, `suite.json`, `suite.yaml`, or `suite.yml`.
  Other JSON/YAML files in a package directory are ignored.

## Diagnosing problems

```bash
npm run doctor   # print resolved repo, state, and cache paths
```

For full setup instructions see the
[setup guide](https://github.com/accelerate-data/promptfoo-eval-harness/blob/main/docs/setup.md).
