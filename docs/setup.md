# Eval Harness Setup

> **For coding agents:** This is your task specification. Read the whole
> document before executing. Follow every step in order. Run every
> verification command and confirm it passes before moving to the next step.
> Do not skip verification steps. If a verification command fails, stop and
> report the exact output — do not continue.

Step-by-step guide to add `@accelerate-data/promptfoo-eval-harness` to a
repo. Follow the steps in order. Each step includes a verification command.

---

## Prerequisites

- Node.js 18 or later
- npm
- A git repository with a clean working tree
- OpenCode CLI available on `PATH` — confirm with `opencode --version`
- **Claude Code agents**: `Bash(npx *)` must be in your allow list. Add it to
  `~/.claude/settings.json` under `permissions.allow` before running Step 1,
  or the bootstrap command will be blocked.

---

## Step 1 — Bootstrap

Run from the repo root:

```bash
npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init
```

This creates `tests/evals/` containing:

- `package.json` — npm scripts for running evals
- `opencode.json` — agent definitions (model, steps, permissions)
- `config/eval-tiers.toml` — tier → agent mapping
- `packages/harness-smoke/` — a starter smoke package used to verify the install
- `.github/dependabot.yml` entry — automatic upgrade PRs on new releases

Dependencies are installed automatically. The command ends with `==> Done.`

---

## Step 2 — Verify the install

```bash
cd tests/evals
npm test                    # framework contract tests — no API calls
npm run doctor              # prints resolved repo, state, and cache paths
npm run eval:harness-smoke  # one live run using the starter package
```

All three must pass before continuing. If `eval:harness-smoke` fails, check
that OpenCode CLI is on `PATH` and your `opencode.json` agent definitions
are correct.

---

## Step 3 — Write an eval package

Create a directory under `tests/evals/packages/`:

```bash
mkdir tests/evals/packages/my-feature
```

Create `tests/evals/packages/my-feature/promptfooconfig.json`:

```json
{
  "description": "Behaviour of the my-feature prompt.",
  "metadata": {
    "eval_tier": "standard"
  },
  "prompts": ["file://prompt.txt"],
  "tests": [
    {
      "description": "[smoke] my-feature returns non-empty output",
      "assert": [
        { "type": "javascript", "value": "output.trim().length > 0" }
      ]
    },
    {
      "description": "my-feature handles edge case X",
      "vars": { "input": "edge case value" },
      "assert": [
        { "type": "javascript", "value": "output.includes('expected token')" }
      ]
    }
  ]
}
```

Create `tests/evals/packages/my-feature/prompt.txt` with your prompt text.

**Rules — do not skip these:**

- `metadata.eval_tier` is required. Valid values: `light`, `standard`, `high`, `x_high`.
- Every package must have exactly one test whose description starts with `[smoke]`.
- Do not declare a `providers` block. The framework injects it from `eval-tiers.toml`.

---

## Step 4 — Run the package

```bash
cd tests/evals
ad-evals run packages/my-feature/promptfooconfig.json
```

Then run the full smoke sweep to confirm every package in the repo executes:

```bash
npm run eval:smoke
```

Exit code `100` means the harness ran but an assertion failed. That is content
feedback, not a harness error. Fix the assertion or the prompt — do not
treat it as a broken install.

---

## Step 5 — Wire CI

Add to your CI pipeline:

```bash
cd tests/evals && npm test           # contract tests — fail on any error
cd tests/evals && npm run eval:smoke # smoke sweep — treat exit 100 as pass
```

For quality gates (blocking merges on assertion failures), use:

```bash
cd tests/evals && npm run eval:regression
```

---

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `npm test` | Framework contract tests. Deterministic, no API calls. |
| `npm run doctor` | Print resolved repo, state, and cache paths. |
| `npm run eval:harness-smoke` | Run the built-in starter package. Confirms OpenCode is wired. |
| `npm run eval:smoke` | Run the `[smoke]` test from every package. |
| `npm run eval:regression` | Run all tests in all packages. |
| `ad-evals run <config>` | Run one specific package config. |

### Tier selection

| Tier | When to use |
| --- | --- |
| `light` | Single-turn, structured-output prompts with no tool use |
| `standard` | Most scenarios |
| `high` | Multi-step research or generation tasks |
| `x_high` | Full workflow runs or expensive grader scenarios |

### Assertion types

| Type | Use |
| --- | --- |
| `javascript` | Inline JS expression evaluated against `output` |
| `contains` | Substring match |
| `regex` | Regex match |
| `llm-rubric` | Model-graded assertion with a rubric string |
| `is-json` | Validates that output parses as JSON |

### OpenHands SDK — gateway mode (v1.4.0)

For the `openhands_sdk` provider you only need two inputs: the model name and a `base_url`
pointing at any OpenAI-compatible endpoint (Accelerate gateway, a LiteLLM proxy, a vLLM
deployment, etc.). Auth is a single env var: `OPENHANDS_API_KEY`.

Drop the provider into your tier config (eval-tiers.toml, v1 schema):

```toml
[[tiers.standard.providers]]
provider_kind = "openhands_sdk"
model = "gpt-4o"

[tiers.standard.providers.extra]
base_url = "https://gateway.internal/v1"
```

Then export the key once:

```bash
export OPENHANDS_API_KEY=sk-...
```

Gateway mode skips the LiteLLM prefix-routing alias table entirely — the model name
passes through verbatim, and only `OPENHANDS_API_KEY` is consulted. The legacy mode
(omit `base_url`) still works for repos that resolve via `_MODEL_MAP` and the
`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` prefix routing.

### Using `openhands_agent_server`

`openhands_agent_server` is a wrapper-style provider that delegates execution to a long-lived `openhands-agent-server` daemon. The CLI owns the daemon's lifecycle — you never start, stop, or pin a port by hand.

1. In `config/eval-tiers.toml`, choose `openhands_agent_server` for the tiers that should use it:

   ```toml
   [tiers.light]
   providers = [
     { provider_kind = "openhands_agent_server", model = "openai/gpt-4o-mini", agent = "eval_light", openhands_config = "openhands.json" },
   ]
   ```

2. Add `openhands.json` next to `eval-tiers.toml` (use `templates/openhands.json` as a starting point). The `adapter` block is required and must include `agent_id`, `agent_entrypoint_file`, `agent_semantics`, and `eval_mode_preamble`. The `agent` map per tier carries `model`, `temperature`, `steps`, and `permission`. Do NOT set `openhands_server_url` — the CLI injects it.
3. Confirm `uvx` is on `PATH`:

   ```bash
   ad-evals doctor
   ```

4. Run a smoke:

   ```bash
   ad-evals smoke
   ```

   You will see `[ad-evals] agent-server ready on http://127.0.0.1:<port> (<ms>ms)` in the log, then a normal Promptfoo eval table. When the run finishes the daemon is stopped (SIGTERM → 5 s → SIGKILL on the process group); no orphan processes.

Model precedence (highest wins): `OPENHANDS_MODEL_OVERRIDE` env > the `model` field on the provider in `eval-tiers.toml` > `agent.<tier>.model` in `openhands.json`.

For manual debugging without the CLI driver, start an `openhands-agent-server` instance on `127.0.0.1:<your-port>` by hand, then `export OPENHANDS_SERVER_URL=http://127.0.0.1:<your-port>` before invoking `promptfoo` directly. Non-empty values win over `openhands.json`; an empty string falls back to the JSON. The daemon binds `127.0.0.1` only — do NOT point this env var at a remote URL.

### Common failures

| Symptom | Fix |
| --- | --- |
| `metadata.eval_tier` missing | Add `"metadata": { "eval_tier": "standard" }` to your config |
| Package not discovered | Rename config to `promptfooconfig.json/.yaml/.yml` or `suite.json/.yaml/.yml` |
| No `[smoke]` test | Add a test whose description starts with `[smoke]` |
| `providers` block conflict | Remove `providers` from your package config — the framework injects it |
| CI: `git rev-parse` fails | Set `AD_EVALS_ROOT` to the absolute path of `tests/evals/` |

---

## Benchmarks

Two performance gates ship with the harness. Both run as part of CI (`npm run bench`)
and can be run locally at any time.

### `npm run bench:spawn-cost`

Spawns the Python adapter (mock provider, no SDK import) 20 times in series and
measures cold-spawn latency (start to `init_ack`). Computes p50/p95/p99.

Budget: `config/bench-budget.toml` → `[spawn_cost] p95_ms` (default 300 ms for the
mock adapter). Phase 06 will tighten this budget for the real OpenHands SDK provider
once cold-import cost is measured on a representative machine.

Exit 1 if p95 exceeds budget. Prints a summary line to stdout:

```text
spawn_cost: n=20 p50=26 p95=28 p99=57 budget=300 verdict=PASS
```

### `npm run bench:throughput`

Runs `bench/parallel-throughput/config.json → iterations` full mock-adapter calls at
each value of `outer_concurrency_values` using a `p-limit` gate. Computes speedup
relative to `concurrency=1`.

Soft gate: speedup at `outer_concurrency=2` must be ≥
`config/bench-budget.toml → [throughput] min_speedup_at_2` (default 1.4×). A value
below 1.4× signals the OUTER concurrency limiter is broken or spawns are serializing.

Exit 1 if speedup is below threshold.

### Bench gate override

Set `BENCH_OVERRIDE_REASON=<free-text reason>` to bypass both gates and exit 0,
regardless of measurement:

```bash
BENCH_OVERRIDE_REASON='diagnosing slow machine' npm run bench
```

**CI never sets `BENCH_OVERRIDE_REASON`** — a failing budget MUST fail the build.
Use the override only when diagnosing locally on a resource-constrained machine or
when chasing a real infrastructure issue. PRs touching latency-sensitive paths
(the adapter spawn path, IPC framing, or the concurrency primitive) must NOT use
this escape valve.
