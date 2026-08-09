# Eval Harness — Agent Instructions

This directory (`tests/evals/`) is the eval suite for this repo. It uses
`@accelerate-data/promptfoo-eval-harness` to run Promptfoo evaluations
against OpenCode / Codex / Claude / OpenHands agents.

> **For LLMs (Claude Code, opencode, codex CLI, …) onboarding a teammate
> or driving a setup pass:** read this file top-to-bottom before running
> anything. Sections are ordered: setup → write package → run → diagnose
> → gotchas. Quote the gotchas list back to the human if any of them
> hits.

## First-time setup (LLM-runnable)

Pre-flight (host-level, one-time):

- Node ≥ 20 on `PATH` — the SDK providers refuse to load on older versions.
- `uv --version` resolves if you plan to use `openhands_sdk` or
  `claude_agent_sdk` (they shell out to `uv run --with …` and bail
  early with a clear error if `uv` is missing).
- `opencode --version` resolves if you plan to use `opencode_cli`.
- Claude Code only: allow `Bash(npx *)` in
  `~/.claude/settings.json` → `permissions.allow` **before** invoking
  the bootstrap. Without it, the `npx` command is silently blocked.

Scaffold + smoke (from the consumer repo root):

```bash
# 1. Bootstrap tests/evals/ + sibling config files.
npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init

# 2. Resolved-path doctor — prints harness paths as JSON and checks
#    that `uvx` resolves + the openhands_agent_server pin is sane.
#    Exits 0 even if `uvx` is missing; read the stderr lines that start
#    with `✗` to decide whether to install `uv`.
cd tests/evals && npm run doctor

# 3. Smoke the framework-shipped fixture end-to-end.
npm run eval:harness-smoke
```

If `eval:harness-smoke` passes, the harness is wired correctly. Move on
to "Adding an eval package".

Secrets: provider keys must be in the calling shell's environment
**before** you invoke `npm run eval:*`. The harness inherits
`process.env` directly — there is no dotenv loader in the consumer
package. Common pattern: keep keys in `tests/evals/.env` and source it
in your shell rc / CI step (`set -a; . tests/evals/.env; set +a`) or
run via a wrapper like `env $(cat tests/evals/.env | xargs) npm run
eval:smoke`. `eval-harness-init` does **not** add `.env` to
`.gitignore` — add it yourself before committing:

```bash
echo "tests/evals/.env" >> .gitignore
git check-ignore tests/evals/.env  # should print the path
```

## Picking `provider_kind`

`config/eval-tiers.toml` binds each tier to one `provider_kind`. Pick
per tier; the full matrix lives upstream in `docs/design.md` →
"Provider matrix". Quick guide:

| `provider_kind` | Use when |
| --- | --- |
| `opencode_cli` | OpenCode CLI is on `PATH` and you want the lowest per-call overhead. |
| `opencode_sdk` | OpenCode agents via the typed `@opencode-ai/sdk`; isolated `127.0.0.1:0` server per case; exposes cost + tokens. |
| `codex_sdk` | OpenAI / Codex models via `@openai/codex-sdk`; you need explicit `sandbox_mode` / `model_reasoning_effort` knobs. |
| `openhands_sdk` | OpenHands agent loop. Gateway mode (model + `extra.base_url` + `OPENHANDS_API_KEY`) for any OpenAI-compatible endpoint; legacy mode prefix-routes by model. |
| `claude_agent_sdk` | Claude as the eval target; multi-turn + file-edit tools; permission gates on `Bash` / `WebSearch` / `WebFetch`. |

Auth cheatsheet — put these in `tests/evals/.env`:

- `opencode_cli` — inherits the calling shell's env; OpenCode's own
  config (`opencode.json`, `OPENCODE_CONFIG`). Optional: `OPENCODE_MODEL`
  (VD-4204) — per-run model swap without editing `opencode.json`; applies
  to this base provider only, **not** the `opencode-cli-plugin` sibling.
- `opencode_sdk` — routed by `model.providerID`: `openai/…` →
  `OPENAI_API_KEY`, `anthropic/…` → `ANTHROPIC_API_KEY`, `opencode-go/…`
  → `OPENCODE_API_KEY`.
- `codex_sdk` — `OPENAI_API_KEY` (optional `OPENAI_BASE_URL` to route
  through a gateway).
- `openhands_sdk` gateway mode — only `OPENHANDS_API_KEY` is consulted.
- `openhands_sdk` legacy mode — model-prefix routed (`openai/…` →
  `OPENAI_API_KEY`, `anthropic/…` → `ANTHROPIC_API_KEY`, `openrouter/…`
  → `OPENROUTER_API_KEY`).
- `claude_agent_sdk` — `ANTHROPIC_API_KEY`.

Canonical reference (always check first if anything here looks wrong):
[Provider Key Matrix](https://github.com/accelerate-data/promptfoo-eval-harness/blob/main/docs/setup.md#provider-key-matrix).

## Adding an eval package

1. Create a directory under `packages/`:

   ```text
   tests/evals/packages/<feature-name>/
   ├─ promptfooconfig.json
   └─ prompt.txt
   ```

2. `promptfooconfig.json` must have:
   - `metadata.eval_tier` — one of `light`, `standard`, `high`, `x_high`
   - At least one test whose description starts with `[smoke]` (and
     **exactly one** such test — zero or two+ fails contract).
   - No `providers` block — the framework injects it from
     `config/eval-tiers.toml`.

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

npm test                # contract tests — no API calls, no spending
npm run eval:smoke      # smoke test every package
npm run eval:regression # all tests in all packages

# Run a single package via the harness CLI:
ad-evals run packages/<feature>/promptfooconfig.json

# Inspect the latest run in the Promptfoo viewer:
ad-evals view
```

Exit code `100` from a smoke or regression run means **the harness ran
fine and an assertion failed**. That is content feedback, not a tool
error — do not retry blindly.

## Diagnosing failures

Order of operations when something fails:

1. `npm run doctor` — prints resolved harness paths as JSON and runs
   two static checks (`uvx` available, `openhands_agent_server` pin
   sane). It exits 0 even when `uvx` is missing, so read stderr for
   lines starting with `✗`. Use the printed paths to verify the harness
   resolved your repo layout correctly.
2. `npm run eval:harness-smoke` — narrows "is the harness alive" vs
   "is my package broken".
3. If smoke fails too: scan the **Gotchas** list below before suspecting
   your package or the model.
4. Re-run the failing package with an explicit JSON output:
   `ad-evals run packages/<name>/promptfooconfig.json --output /tmp/results.json`.
   The Promptfoo table view truncates long provider errors; the JSON
   has the full provider payload. The defense-in-depth redactor strips
   known secret patterns (`sk-…`, `sk-ant-…`, `oh-…`, `AKIA…`,
   `gh[pousr]_…`, `Bearer …`, GCP private-key JSON) from normalized
   error messages — provider transcripts and metadata may still echo
   anything the model emitted, so skim before pasting into a ticket.
5. Open the latest run: `ad-evals view`. The viewer surfaces raw
   provider output, assertion verdicts, and token / cost figures.

## Gotchas

- **`OPENHANDS_BASE_URL` leaking from your shell.** If your shell or a
  sourced `.env` exports `OPENHANDS_BASE_URL`, the `openhands_sdk`
  adapter routes through that gateway and may surface misleading
  `OpenAIException - Connection error` failures (because gateway mode
  expects `OPENHANDS_API_KEY`, not `OPENAI_API_KEY`). Clear with
  `OPENHANDS_BASE_URL= npm run eval:smoke` for runs that should **not**
  use the gateway.

- **`openhands_sdk` + small models call tool functions.** On
  `openai/gpt-4o-mini` (and similar low-cost models), the OpenHands SDK
  defaults to calling `finish` / `think` tools and your turn output
  ends up empty. Mitigation: include `"plain text only, no tools"` in
  **every turn's** prompt for classification-style or single-shot tests.

- **Darwin lockfile drift.** `ad-evals` runs `npm install` at startup;
  on macOS this prunes Linux-only `@swc/core-linux-*` optional deps and
  dirties `package-lock.json`. Restore with
  `git restore package-lock.json` before committing.

- **`providers` block in a package config.** The framework injects
  providers from `config/eval-tiers.toml`; declaring `providers` inside
  a package's `promptfooconfig.json` is a hard error in the contract
  suite.

- **`[smoke]` test count.** Each package must have **exactly one** test
  whose description starts with `[smoke]`. Zero or two+ fails contract.

- **ESM module not found.** `opencode_sdk` and `codex_sdk` load their
  packages via dynamic `import()` (ESM-only). `ERR_MODULE_NOT_FOUND`
  against `@opencode-ai/sdk` or `@openai/codex-sdk` means the package
  isn't installed in this consumer repo — run `npm install` in
  `tests/evals/` rather than re-running the failing eval.

- **`uv` not on PATH.** `openhands_sdk` and `claude_agent_sdk` spawn
  `uv run --with …`; if `uv` is missing, the providers fail at `init()`
  with a clear "uv not found" error. Install
  [uv](https://docs.astral.sh/uv/getting-started/installation/) or
  switch the tier to an SDK that doesn't need it.

## Tier selection

| Tier | When to use |
| --- | --- |
| `light` | Single-turn, structured-output prompts. |
| `standard` | Most scenarios. |
| `high` | Multi-step or research tasks. |
| `x_high` | Full workflow or expensive graders. |

## Rules

- Every package must have **exactly one** `[smoke]`-prefixed test.
- `metadata.eval_tier` is required (`light` / `standard` / `high` /
  `x_high`).
- Never declare `providers` in a package config.
- Config files must be named `promptfooconfig.json`,
  `promptfooconfig.yaml`, `promptfooconfig.yml`, `suite.json`,
  `suite.yaml`, or `suite.yml`. Other JSON / YAML files in a package
  directory are ignored.
- Secrets must be present in the calling shell's `process.env` before
  invocation (the harness has no dotenv loader). Keep them in
  `tests/evals/.env`, add that path to `.gitignore` yourself (the
  bootstrap does not), and source it before running. Never commit keys;
  never echo their values back to chat output.

For full setup, design rationale, and the canonical Provider Key Matrix:
[setup guide](https://github.com/accelerate-data/promptfoo-eval-harness/blob/main/docs/setup.md).
