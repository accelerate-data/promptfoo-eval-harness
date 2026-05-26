# Eval Harness Setup

> **For coding agents:** This is your task specification. Read the whole
> document before executing. Follow every step in order. Run every
> verification command and confirm it passes before moving to the next step.
> Do not skip verification steps. If a verification command fails, stop and
> report the exact output — do not continue.

Step-by-step guide to add `@accelerate-data/promptfoo-eval-harness` to a
repo. Follow the steps in order. Each step includes a verification command.

> **Testing an unpublished branch?** This guide assumes the harness version
> you want is already on npm. If you are validating a feature branch
> (worktree) that has not been published yet, follow
> [`setup-unpublished.md`](setup-unpublished.md) instead. Steps 1–2 below
> are replaced by Steps 1–4 of that guide (pick install method, bootstrap
> from worktree, wire the runtime to the worktree, verify). After those
> finish, return here at Step 3 — write an eval package — and continue
> through the rest of this guide.

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

## Step 1.5 — Configure secrets

`eval-harness-init` does NOT set up auth. Step 2's `eval:harness-smoke`
hits a real model and needs API keys in `process.env` before it runs.
Bootstrap your `.env` now so the smoke (and every subsequent package)
has what it needs.

### Create `tests/evals/.env` and git-ignore it

```bash
touch tests/evals/.env
# eval-harness-init does NOT auto-ignore .env — add it now.
echo 'tests/evals/.env' >> .gitignore
git check-ignore tests/evals/.env   # expect: tests/evals/.env
```

### Add keys for the `provider_kind`s your tiers use

Open `tests/evals/config/eval-tiers.toml`, note which `provider_kind`
each tier uses, then populate `tests/evals/.env`. Compact lookup
(full reference: **Provider Key Matrix** in the Reference section):

| `provider_kind` | Required in `tests/evals/.env` |
| --- | --- |
| `opencode_cli` | Inherits the calling shell's env; OpenCode handles its own auth via `opencode.json` / `OPENCODE_CONFIG`. Add `OPENCODE_API_KEY` only if `opencode.json` references it directly. |
| `opencode_sdk` | Model-prefix routed: `openai/…` → `OPENAI_API_KEY`, `anthropic/…` → `ANTHROPIC_API_KEY`, `opencode-go/…` → `OPENCODE_API_KEY` |
| `codex_sdk` | `OPENAI_API_KEY=sk-…` (optional `OPENAI_BASE_URL=https://…` to route through a gateway) |
| `openhands_sdk` — gateway mode | `OPENHANDS_API_KEY=oh-…` + `OPENHANDS_BASE_URL=https://…` (optional `OPENHANDS_MODEL_OVERRIDE=anthropic/claude-…` — beats the tier `model` field) |
| `openhands_sdk` — legacy mode (no `OPENHANDS_BASE_URL`) | Model-prefix routed: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` |
| `openhands_agent_server` | Model-prefix routed by the wrapper's `buildLlmPayload()`: `openai/…` → `OPENAI_API_KEY`, `anthropic/…` → `ANTHROPIC_API_KEY`, `groq/…` → `GROQ_API_KEY`, `deepseek/…` → `DEEPSEEK_API_KEY`, `opencode-go/…` → `OPENCODE_API_KEY`. Optional: `OPENHANDS_MODEL_OVERRIDE` (per-run model swap). This `provider_kind` does NOT consume `OPENHANDS_API_KEY` and does NOT honor `OPENHANDS_BASE_URL` as a gateway switch (that is the `openhands_sdk` kind only). `OPENHANDS_SERVER_URL` is CLI-injected — do NOT set it for normal runs. |
| `claude_agent_sdk` | `ANTHROPIC_API_KEY=sk-ant-…` |

### Load the keys into the calling process

The framework has no built-in dotenv loader — keys must be in
`process.env` when `ad-evals` starts. Two supported patterns:

1. **Source the file in your shell** (works for every `provider_kind`):

   ```bash
   set -a; . tests/evals/.env; set +a
   ```

   Add the same one-liner to CI before invoking `npm run eval:*`.

2. **Opt into the `opencode-cli` plugin loader** (only when your
   `[runtime].provider_id` points at
   `framework://opencode-cli-plugin-provider.js`, NOT the base). Set
   `load_local_env = true` in the `[runtime]` block of
   `tests/evals/config/eval-tiers.toml`. The plugin then reads
   `<repo-root>/.env` first, then `tests/evals/.env` at call time —
   neither call overwrites pre-existing `process.env` keys.

### Gotcha — leaked `OPENHANDS_BASE_URL`

If your shell already exports `OPENHANDS_BASE_URL` (sourced from a
parent project's `.env`, or set globally in your shell rc), the
`openhands_sdk` adapter silently enters gateway mode and may surface a
misleading `OpenAIException - Connection error`. Clear with an empty
prefix when running a scenario that should NOT use the gateway:

```bash
OPENHANDS_BASE_URL= npm run eval:smoke
```

See the **OpenHands SDK — gateway mode** and **Provider Key Matrix**
sections in the Reference for the full auth model.

---

## Step 2 — Verify the install

```bash
cd tests/evals
npm test                    # framework contract tests — no API calls
npm run doctor              # prints resolved repo, state, and cache paths
npm run eval:harness-smoke  # alias for: ad-evals run packages/harness-smoke/promptfooconfig.json
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
| `npm run eval:harness-smoke` | Alias for `ad-evals run packages/harness-smoke/promptfooconfig.json`. Runs the built-in starter package; confirms OpenCode is wired. |
| `npm run eval:smoke` | Alias for `ad-evals smoke`. Runs the `[smoke]` test from every package. |
| `npm run eval:regression` | Alias for `ad-evals regression`. Runs all tests in all packages. |
| `ad-evals run <config>` | Run one specific package config directly. |

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

### Plugin Glue Provider Runtime Fields (v1.5.0)

The harness ships three plugin-glue wrappers (`framework://codex-sdk-provider.js`,
`framework://claude-agent-sdk-provider.js`, `framework://opencode-cli-plugin-provider.js`)
that read additional optional fields from the `[runtime]` block of
`config/eval-tiers.toml`. All 15 are optional — omitting a field falls
back to the wrapper's default. Consumer YAML never sets these directly;
they always flow through the tier config and the validated allowlist.

| Field | Type | Default | Consumed by | Description |
| --- | --- | --- | --- | --- |
| `bootstrap_prompt` | string | `""` (no prefix) | codex-sdk, claude-agent-sdk-node, opencode-cli-plugin | Prompt prefix injected before each turn (e.g. plugin-runtime instructions). |
| `agent_id` | string | `null` | all three wrappers | Plugin agent identifier surfaced in `.eval-run/provider.json` and labels. |
| `agent_entrypoint_file` | string | `null` | all three wrappers | Relative path to the agent definition file; emitted in run metadata. |
| `auto_reply_text` | string | Multi-line approval/safety prompt (see `claude-agent-sdk-provider.js → DEFAULT_AUTO_REPLY_TEXT`) | claude-agent-sdk-node | Reply auto-sent when the Claude SDK emits an `AskUserQuestion` tool call. Most consumers override this to something short like `"continue"`. |
| `max_auto_replies` | integer ≥ 0 | `5` | claude-agent-sdk-node | Cap on consecutive auto-replies before the wrapper bails. |
| `idle_turn_stop` | integer ≥ 0 | `2` | claude-agent-sdk-node | Empty-output turns tolerated before the wrapper stops streaming input. |
| `plugin_subdirs` | string[] (non-empty) | `[]` | claude-agent-sdk-node | Plugin discovery roots resolved relative to the eval root. |
| `model` | non-empty string | `null` | codex-sdk, claude-agent-sdk-node | Per-tier model override forwarded to the SDK constructor. |
| `empty_output_retries` | integer ≥ 0 | `0` | claude-agent-sdk-node, opencode-cli-plugin | Extra retry attempts when the agent emits an empty turn output. |
| `opencode_runner_command` | string | `opencode` (or `$OPENCODE_RUNNER_COMMAND`) | opencode-cli-plugin | Override for the OpenCode CLI binary, e.g. `npx opencode`. |
| `opencode_plugin_link_path` | string | `null` | opencode-cli-plugin | Workspace-relative plugin symlink path; presence is reported in metadata as `plugin_runtime_loaded`. |
| `capture_on_failure` | boolean | `false` | opencode-cli-plugin | When true, switches to `runOpenCodeCaptureAll` so stdout/stderr are surfaced on failure. |
| `write_run_metadata` | boolean | `false` | opencode-cli-plugin | When true, writes `<workspace>/.eval-run/provider.json` with transport + plugin context. |
| `load_local_env` | boolean | `false` | opencode-cli-plugin | When true, loads the repo-root `.env` (`EVAL_ROOT/../../.env`) first, then `EVAL_ROOT/.env`; neither call overwrites pre-existing `process.env` keys. |
| `opencode_parser_module` | string (require-path) | `null` (identity parser) | opencode-cli-plugin | Path (relative to `EVAL_ROOT`) of a parser module exporting either a default function or `{ parseOpenCodeJsonStream }`. |

Adding a new optional field requires extending `OPTIONAL_RUNTIME_FIELDS`
in `scripts/framework/eval-tier-config.js` first; the
`runtime-fields-allowlist.test.js` guard rejects any wrapper that reads
a field outside the allowlist.

### Scenarios

The harness ships reference scenarios under
`tests/harness-scenarios/packages/`; consumers add their own under
`tests/evals/packages/`. Both run through the same CLI.

#### Harness-shipped scenarios

These cover the framework contract and ship inside the npm package. Run
them to verify a fresh install or debug a provider regression without
touching live keys. All run nightly on `main`.

| Scenario | `provider_kind` | Requires live key | Purpose |
| --- | --- | --- | --- |
| `minimal-smoke` | `opencode_cli` | No (`OPENCODE_MOCK_MODE=1`) | Single-turn smoke that exercises the bridge end-to-end. |
| `opencode-cli-compatibility` | `opencode_cli` | No | Layer-4 regression. Locks the five §7.4 OpenCode CLI provider behaviors across releases (3 cases). |
| `openhands-mock-multi-turn` | `openhands_sdk` | No (mock SDK via `PYTHONPATH` shim) | 3-turn conversation through the Python IPC bridge. |
| `claude-mock-multi-turn` | `claude_agent_sdk` | No (mock SDK) | Multi-turn through the Python `claude_agent_sdk` kind with deterministic mock responses. |
| `codex-sdk-mock-multi-turn` | `codex_sdk` | No (mock SDK) | Multi-turn through the in-proc `codex_sdk` kind. |
| `opencode-sdk-mock-multi-turn` | `opencode_sdk` | No (mock SDK) | Multi-turn through the in-proc `opencode_sdk` kind (ephemeral server). |

Run one locally (mock-mode example):

```bash
PYTHONPATH="$PWD/tests/_mock_openhands_sdk" \
  npx ad-evals run tests/harness-scenarios/packages/openhands-mock-multi-turn
```

#### Authoring a consumer package

Each consumer package is one directory under `tests/evals/packages/<name>/`:

- `promptfooconfig.json` (or `.yaml`) — the eval definition
- `prompt.txt` or `prompts/*.txt` — prompt template(s)
- Optional `setup.sh` — runs once per test inside the isolated workspace
- Optional `fixtures/` referenced via `vars.fixture_path`
- Optional `README.md` — explains intent and prerequisites

Stateful evals (anything that writes files, runs `git`, exercises a sandbox)
lean on the `beforeEach` extension hook documented below in
[Workspace Isolation & Git Operations](#workspace-isolation--git-operations).
Read-only contract evals (no fixture, no setup) skip the hook and run as
plain Promptfoo tests.

### Provider Key Matrix

Each `provider_kind` registered in `KIND_REGISTRY`
(`scripts/framework/_node_bridge.js`) reads its own env vars. The
harness never embeds keys; consumers export them in the shell before
running or opt into a runner-managed `.env` (see the
`opencode-cli-plugin` wrapper's `load_local_env` field below).

| `provider_kind` | Auth source | Optional env | Notes |
| --- | --- | --- | --- |
| `opencode_cli` | Inherits the calling shell's environment — auth is delegated to OpenCode's own config (`opencode.json`, `OPENCODE_CONFIG`, or the OpenCode provider table). | `OPENCODE_CONFIG`, `XDG_STATE_HOME` (the base provider sets these per run; spread `process.env` otherwise). | Base provider does **not** read `.env`. Consumers who want `.env` auto-load layer it via the `opencode-cli-plugin` wrapper with `load_local_env = true`. The OpenCode binary must be on `PATH` (override via the plugin wrapper's `opencode_runner_command`). |
| `claude_agent_sdk` | `ANTHROPIC_API_KEY` | — | Python kind via `uv run --with claude-agent-sdk==…`. Async lifecycle; stateful `ClaudeSDKClient` for multi-turn. |
| `codex_sdk` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` (override the OpenAI endpoint, e.g. for a gateway) | Bridge passes `apiKey: process.env.OPENAI_API_KEY` straight into `new Codex(...)` and reserves a per-session HOME (`mkdtemp`) so any `~/.codex/auth.json` on the host is **not** consulted. First turn of each session lazily `mkdtemp`s a per-case workspace, runs `git init`, then calls `Codex.startThread`; subsequent turns in the same session reuse that thread + workspace until `close()`. |
| `openhands_sdk` | `OPENHANDS_API_KEY` *or* prefix-routed `_API_KEY` | `OPENHANDS_BASE_URL`, `OPENHANDS_MODEL_OVERRIDE`, `cfg.extra.base_url` | Gateway mode triggers when **either** `OPENHANDS_BASE_URL` env or `cfg.extra.base_url` is set (env wins on collision); in that mode only `OPENHANDS_API_KEY` is consulted. Legacy mode (neither set) routes by model prefix — `openai/…` → `OPENAI_API_KEY`, `anthropic/…` → `ANTHROPIC_API_KEY`, `openrouter/…` → `OPENROUTER_API_KEY`. |
| `opencode_sdk` | Depends on the chosen model — the harness boots a local `@opencode-ai/sdk` server that inherits `process.env` and routes `body.model = {providerID, modelID}` to OpenCode's provider table. `openai/…` ⇒ `OPENAI_API_KEY`, `anthropic/…` ⇒ `ANTHROPIC_API_KEY`, `opencode-go/…` ⇒ `OPENCODE_API_KEY`, etc. | — | TypeScript SDK; boots an ephemeral `127.0.0.1:0` OpenCode server per run. Agents limited to `{build, plan, general}`. |

Plugin glue providers wrap one of the kinds above and add a few extra
hooks. They are not separate `provider_kind` values — they are
referenced from tier scenarios via the `framework://` URL scheme and
delegate to the underlying transport.

| Wrapper (`framework://`) | Wraps | Adds |
| --- | --- | --- |
| `opencode-cli-plugin-provider.js` | `opencode_cli` | Opt-in `load_local_env` (reads the repo-root `.env` at `EVAL_ROOT/../../.env` first, then `EVAL_ROOT/.env`; neither overwrites `process.env`); `opencode_runner_command`; plugin symlink discovery via `opencode_plugin_link_path`. |
| `claude-agent-sdk-provider.js` | Node-side `claude_agent_sdk_node` transport (in-proc — **not** a bridge kind) | Streaming input + auto-reply gate. Consumes `ANTHROPIC_API_KEY` from the process environment; probes `CLAUDE_CODE_EXECUTABLE`, `~/.local/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude` for the CLI binary. |
| `codex-sdk-provider.js` | `codex_sdk` (via bridge) | `bootstrap_prompt` injection; workspace precedence from the prompt body. |

#### Secret hygiene

- Defense-in-depth redactor — Node `scripts/framework/secret_redactor.js`
  and its Python parity twin
  `scripts/framework/providers/_secret_redactor.py` — applies the regex
  patterns in `config/redaction-patterns.json` to the **normalized
  error messages** the bridge emits (`scripts/framework/_node_bridge.js`
  → `normalizeErr()`). Pattern set: Anthropic keys (`sk-ant-…`), OpenAI
  keys (`sk-…`), OpenHands keys (`oh-…`), AWS access key IDs (`AKIA…`)
  and high-entropy AWS secret access keys, GitHub PATs (`gh[pousr]_…`),
  `Bearer …` tokens, and GCP service-account `private_key` JSON
  snippets. Format-driven, not env-var-driven — values that don't match
  these shapes pass through.
- **Scope limit:** the redactor covers error messages only. Provider
  transcripts, tool I/O, and other metadata fields written to Promptfoo
  JSON/viewer output are **not** redacted. Audit the
  `tests/evals/.tmp/results.json` or viewer output before pasting into
  a ticket / public chat.
- `tests/evals/.env` is **not** git-ignored by `eval-harness-init`;
  the bootstrap only adds `tests/evals/.tmp/` to the repo `.gitignore`
  and `.cache/`, `.tmp/`, `output/`, `results/`, `node_modules/` to
  `tests/evals/.gitignore`. Add `.env` (and any other secret files) to
  `.gitignore` yourself and verify with `git check-ignore` before
  committing.
- **Gotcha:** if your shell already has `OPENHANDS_BASE_URL` exported
  (e.g. you sourced a consumer `.env` that pointed at an OpenHands
  gateway), the `openhands_sdk` adapter will route through that gateway
  and may surface misleading `OpenAIException - Connection error`
  failures. Clear with `OPENHANDS_BASE_URL=` (empty) prefix when running
  `openhands_sdk` scenarios that should not use the gateway.

#### Switching providers across runs

Consumers commonly run the same package set against multiple providers.
Pattern from the data-engineering team: keep `config/eval-tiers.toml`
pointed at the primary provider (opencode-cli for daily work) and add
sibling configs (`eval-tiers-sdk.toml`, `eval-tiers-codex.toml`,
`eval-tiers-openhands.toml`) plus thin bash wrappers that backup → swap
→ run → restore on exit:

```bash
#!/usr/bin/env bash
set -euo pipefail
EVAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="$EVAL_ROOT/.tmp/eval-tiers.$$.bak"
mkdir -p "$EVAL_ROOT/.tmp"
cp "$EVAL_ROOT/config/eval-tiers.toml" "$BACKUP"
trap '[ -f "$BACKUP" ] && cp "$BACKUP" "$EVAL_ROOT/config/eval-tiers.toml" && rm -f "$BACKUP"' EXIT
cp "$EVAL_ROOT/config/eval-tiers-sdk.toml" "$EVAL_ROOT/config/eval-tiers.toml"
cd "$EVAL_ROOT" && ad-evals run packages/
```

The swap happens outside the promptfoo-guard window so the
artifact-cleanup guard never sees a mid-suite state change.

### Parallelism

Two layers of concurrency, both controlled from the framework.

**Outer concurrency** — across packages. `ad-evals run <dir>` walks the
directory and runs each `promptfooconfig.*` as a separate Promptfoo
invocation. A `p-limit` gate caps how many run in parallel.

```bash
# Default — outer concurrency = os.cpus().length on the host
ad-evals run packages/

# Force sequential (one config at a time)
AD_EVALS_OUTER_CONCURRENCY=1 ad-evals run packages/

# Cap at a specific value
AD_EVALS_OUTER_CONCURRENCY=4 ad-evals run packages/
```

The benchmark `npm run bench:throughput` enforces ≥ 1.4× speedup at
concurrency=2 on every PR — a regression below that threshold signals
the outer limiter is broken or spawns are serializing.

**Inner concurrency** — across test cases inside one package. Promptfoo's
`--max-concurrency` controls how many `tests[]` entries inside a single
`promptfooconfig` run in parallel. `ad-evals run` forwards extra args to
Promptfoo verbatim — pass the flag directly after the config path
(no `--` separator needed):

```bash
ad-evals run packages/my-feature/promptfooconfig.json --max-concurrency 8
```

#### When to use which

| Pattern | Lever |
| --- | --- |
| Many packages, few tests per package | Outer (`AD_EVALS_OUTER_CONCURRENCY`) |
| One package, many `tests[]` entries | Inner (`--max-concurrency`) |
| Mixed | Combine — outer × inner = total parallel calls; budget against your provider rate limit. |

#### Provider rate-limit considerations

- `openhands_sdk` / `claude_agent_sdk` spawn one Python subprocess per
  call. Outer concurrency above ~8 risks subprocess-spawn contention.
- `opencode_cli` spawns one CLI process per call. Same caution.
- `codex_sdk` / `claude_agent_sdk_node` / `opencode_sdk` are in-process
  Node clients — concurrency is bounded by the SDK's connection pool
  and the provider's rate limit, not spawn cost.

### Multi-turn Conversational Evals

The harness exposes one canonical multi-turn shape that works across
`openhands_sdk`, `claude_agent_sdk`, `codex_sdk`, and `opencode_sdk`. Set
`vars.turns` to a JSON-encoded array of prompts, then check
`output.split('\n---\n')` per turn.

Prompt template (`prompts/multi-turn.txt`):

```text
{{turns}}
```

Test config:

```json
{
  "prompts": ["file://prompts/multi-turn.txt"],
  "tests": [
    {
      "description": "[multi-turn] memory recall — 2 turns",
      "vars": {
        "turns": "[\"Please remember 42.\", \"What number was it?\"]"
      },
      "assert": [
        {
          "type": "javascript",
          "value": "(() => { const parts = output.split('\\n---\\n'); return parts.length === 2; })()"
        },
        {
          "type": "javascript",
          "value": "output.split('\\n---\\n')[1].includes('42')"
        }
      ]
    }
  ]
}
```

The bridge decodes `turns`, drives the provider once per entry, and
joins responses with `\n---\n`. Each turn shares the provider's
conversation state (Python kinds reuse the same `LocalConversation`;
Node kinds reuse the same SDK client instance).

#### Auto-reply mode (claude-agent-sdk wrapper only)

When the Claude SDK emits an `AskUserQuestion` mid-turn, the
`framework://claude-agent-sdk-provider.js` wrapper auto-responds with
`auto_reply_text`. The default is a multi-line approval/safety prompt
defined in `claude-agent-sdk-provider.js` (`DEFAULT_AUTO_REPLY_TEXT`)
that tells the agent to stop and summarize once the original request is
complete; most consumers override it to something terse like
`"continue"` once they understand the trade-off. Cap consecutive replies
with `max_auto_replies` (default `5`) and bail on `idle_turn_stop`
consecutive empty turns (default `2`). All three live in the `[runtime]`
block of `eval-tiers.toml`.

#### Pattern selection

| Pattern | Use when |
| --- | --- |
| `vars.turns` (JSON array) | You author the conversation up front. Deterministic, replayable. |
| `auto_reply_text` (claude-agent-sdk wrapper) | The agent asks clarifying questions and you want it driven to completion without scripting each reply. |
| Promptfoo native multi-step prompts | You need different prompt templates per turn or per-turn variable interpolation. |

### LLM Judge & Custom Assertions

The harness inherits Promptfoo's assertion types — no new types are
added. The patterns worth knowing are how consumers compose them.

#### LLM-rubric (model-graded)

```json
{
  "assert": [
    {
      "type": "llm-rubric",
      "value": "The response correctly identifies the medallion architecture layers (bronze → silver → gold).",
      "provider": "openai:gpt-4o-mini"
    }
  ]
}
```

`provider` here is the *grader* — a separate Promptfoo provider from the
one under evaluation. Set it explicitly when your default Promptfoo
provider config does not include a grader. Common pattern: use the
cheapest capable model (e.g. `openai:gpt-4o-mini`) to grade output from
a more expensive one.

#### JavaScript inline (deterministic checks)

```json
{
  "assert": [
    { "type": "javascript", "value": "output.trim().length > 0" },
    { "type": "javascript", "value": "JSON.parse(output).status === 'ok'" }
  ]
}
```

#### File-backed assertions (stateful, workspace-aware)

For evals that inspect side effects (files written, tables created, git
history), reference an external module:

```json
{
  "assert": [
    { "type": "javascript", "value": "file://../../assertions/check-skill-trajectory.js" }
  ]
}
```

The module exports a `(output, context) => { pass, score, reason }`
function and receives `context.vars.workspace` (set by the `beforeEach`
hook — see next section). Use this pattern for any check that needs to
read or hash files the agent created.

#### Composition tips

- Order assertions cheapest first — a length check before an LLM rubric
  saves money on obvious failures.
- File-backed assertions can return `{ pass: false, score: 0.3, reason }`
  for partial credit.
- Promptfoo aggregates `assert` results per test; the test passes only
  if every assertion passes (unless `threshold` is set in the config).

### Workspace Isolation & Git Operations

Plugins that perform git operations (`git init`, `git commit`, schema
migrations, sandboxed DuckDB writes) must run inside a workspace the
harness owns end-to-end. Two layers handle this.

#### Layer 1 — per-call workspace (built-in)

Each plugin-glue provider resolves its workspace path differently. The
precedence rules are wrapper-specific:

- **`framework://claude-agent-sdk-provider.js`** —
  `ctx.vars.workspace` (Promptfoo per-row override) →
  prompt regex `/(?:Workspace:|operating in workspace)\s*(\S+)/i` →
  `cfg.project_dir` (joined to `EVAL_ROOT` if relative) → `EVAL_ROOT`
  itself (final fallback). No `mkdtemp`.
- **`framework://codex-sdk-provider.js`** — prompt regex →
  `cfg.project_dir` (joined to `EVAL_ROOT` if relative) → falls through
  to the `codex_sdk` bridge, which `mkdtemp`s a per-case workspace
  before calling `Codex.startThread`. The wrapper does **not** read
  `ctx.vars.workspace`.
- **`framework://opencode-cli-plugin-provider.js`** — prompt regex →
  `cfg.project_dir` (joined to `EVAL_ROOT` if relative) → `mkdtemp`
  fallback under `tests/evals/.workspaces/provider-runs/opencode-*`.
  The wrapper does **not** read `ctx.vars.workspace`. Note that the
  fallback prefix (`.workspaces/`) is **outside** the harness
  artifact-guard allowlist (`.cache/`, `.tmp/`, `output/`, `results/`),
  so consumers running with the guard enabled should set
  `cfg.project_dir` (or rely on the `Workspace:` prompt marker) instead
  of the mkdtemp fallback.

The resolved path is written to `<workspace>/.eval-run/provider.json`
along with transport and plugin metadata when `write_run_metadata = true`.
The `opencode-cli-plugin` wrapper defaults this **off** — opt in via the
`[runtime]` block of `eval-tiers.toml`.

#### Layer 2 — fixture-copy + plugin link (consumer hook)

For stateful evals (the data-engineering plugin's git-ops scenarios are
the canonical example), consumers add a `beforeEach` extension hook
that:

1. Reads `test.vars.fixture_path` (relative to `tests/evals/`).
2. Copies the fixture to
   `tests/evals/.tmp/workspaces/<timestamp>-<slug>/`. The
   `tests/evals/.tmp/` prefix is on the harness artifact-guard allowlist
   (`scripts/framework/run-promptfoo-with-guard.js`), so the post-run
   cleanup guard never flags it.
   **Excludes** `.venv`, `venv`, `target`, `dbt_packages`, `.git`,
   `node_modules`, `__pycache__`, `*.duckdb-wal`, `secrets.toml` — heavy
   or per-machine artifacts that must not be replicated.
3. Symlinks the plugin into
   `<workspace>/.opencode/plugins/<plugin-name>` so OpenCode discovers
   it without resolving real paths.
4. Runs `test.vars.setup_script` with `WORKSPACE=<run-dir>` (creates
   venv, bridges secrets, runs `dbt deps`, etc.).
5. Records a high-resolution `.run-started-at` timestamp **after** setup
   completes, so assertions can distinguish files the agent wrote from
   fixture files (via `find -newer .run-started-at` or `mtime` checks).
6. Sets `test.vars.workspace` (absolute) and `test.vars.workspace_rel`
   so prompts and assertions can reference the isolated path.

Wire it in `promptfooconfig.json`:

```json
{
  "extensions": ["file://../../hooks.mjs:extensionHook"],
  "tests": [
    {
      "vars": {
        "fixture_path": "fixtures/duckdb-greenfield",
        "setup_script": "packages/skill-scaffolding-duckdb-workspace-contract/setup.sh"
      }
    }
  ]
}
```

The prompt template uses `{{workspace}}` to point the agent at the
isolated path; the agent can `git init`, write files, run `dbt` — all
confined to that directory.

#### Why this is safe for git operations

- The fixture filter excludes `.git`, so each run starts without a git
  directory. The agent runs `git init` on a clean tree.
- The workspace lives under `tests/evals/.tmp/workspaces/<...>/`,
  outside any package source tree, so the agent cannot accidentally
  mutate the eval suite or the parent repo. The `.tmp/` prefix is on
  the harness artifact-guard allowlist.
- The plugin is symlinked, not copied — installing it into the workspace
  cannot drift from the source of truth.
- `.run-started-at` lets assertions filter `git log` / `find -newer` to
  only the agent's commits.

#### Workspace lifecycle

The framework does **not** delete
`tests/evals/.tmp/workspaces/<...>` automatically — the previous N runs
stay on disk for post-mortem. Add a GC step
(`find tests/evals/.tmp/workspaces -maxdepth 1 -mtime +7 -exec rm -rf {} +`)
to your CI cleanup if disk footprint matters.

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
