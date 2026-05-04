# Shared Eval Harness Extraction Notes

## Framework-Owned

- `bin/ad-evals.js`
- `scripts/framework/**`
- model/tier schema and validation
- Promptfoo/OpenCode state export
- config materialization
- artifact guard
- package discovery
- framework contract tests

## Project-Owned

- `packages/**`
- `prompts/**`
- `fixtures/**`
- domain assertion files
- project-specific scenario inventory
- optional package-specific npm aliases
- `eval-map.json` package catalog and coding-agent navigation text

## Second Consumer Checklist

- Port `migration-utility` without changing its package YAML semantics.
- Confirm git-common-dir state export works across its worktrees.
- Confirm targeted `-o <json>` diagnostics still work.
- Port `engineering-skills` after removing package-local provider/model wiring.
- Keep framework extraction blocked until the same framework files run unchanged in Skill Builder and `migration-utility`.
