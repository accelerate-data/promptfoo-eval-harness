# Running Evals

## Quick Reference

```bash
cd tests/evals
npm test                     # harness contract tests (deterministic, no API calls)
npm run doctor               # print resolved paths
npm run eval:harness-smoke   # verify the harness can run at all
npm run eval:smoke           # smoke filter across every package
npm run eval:regression      # all tests in all packages
```

## Smoke Runs

The smoke run executes the single `[smoke]`-prefixed test from every package.
Use it as a fast sanity check that every package wires up correctly:

```bash
npm run eval:smoke
```

A green smoke run proves:

- Every package config is valid and has a provider.
- Every package has exactly one smoke test.
- Every smoke test executed without a harness error.

Assertion failures (exit code `100`) are content feedback, not framework
failure. A green smoke run with assertion failures means the harness is working
but the agent output did not meet the assertion.

## Targeted Package Runs

Every package should have a script in `package.json` for targeted execution:

```bash
npm run eval:my-feature
```

This is equivalent to:

```bash
node bin/ad-evals.js run packages/my-feature/promptfooconfig.json
```

Use targeted runs when you are iterating on a single package's prompt or
assertions.

## Regression Runs

The regression run executes all tests in all packages:

```bash
npm run eval:regression
```

Use this before model or runtime migrations. It is slow — run smoke first to
rule out harness issues.

## Running with Extra Promptfoo Flags

Pass raw Promptfoo flags through the `promptfoo` passthrough command:

```bash
node bin/ad-evals.js promptfoo -- eval --no-cache -c packages/my-feature/promptfooconfig.json --output result.json
```

## Diagnosing Path Issues

```bash
npm run doctor
```

This prints the resolved harness paths: repo root, eval root, shared Promptfoo
state dir, OpenCode state dir, cache, logs, media, and tmp. Check this output
first when investigating state or path resolution failures.

## CI Wiring

| Purpose | Exit behavior |
| --- | --- |
| Framework-port verification | Pass on status `100` (assertion failure is content, not error) |
| Full regression gate | Fail on any non-zero exit |

Status `100` means Promptfoo ran but at least one test assertion failed.
Non-`100` non-zero exits mean the harness itself encountered an error.

## Worktrees

The harness exports Promptfoo state from the git common dir at runtime. Each
worktree gets its own `.cache/`, `.tmp/`, `output/`, and `results/` directories
but shares the Promptfoo database and OpenCode state across the repo.

Worktree bootstrap scripts must not create `tests/evals/.promptfoo` symlinks.
Run `npm run doctor` inside each worktree to verify state resolution.
