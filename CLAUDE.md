<!-- markdownlint-disable-file MD041 -->
@AGENTS.md

Adapter file. `AGENTS.md` is canonical. Below: only Claude-specific guidance that diverges from cross-agent docs.

## Claude Code notes

- **Two contexts.** If you (Claude) are working in a **consumer repo**
  where this harness is already installed under `tests/evals/`, your
  authoritative LLM-onboarding doc is `tests/evals/AGENTS.md` (scaffolded
  from `templates/AGENTS.md` in this repo). Read it top-to-bottom before
  running anything — it covers first-time setup, provider selection,
  package authoring, diagnosing, and the gotchas list. The notes below
  apply when you're working **inside this harness repo itself** (e.g.
  fixing a framework bug, bumping an SDK pin, updating contract tests).
- **Allow list.** Add `Bash(npx *)` to `~/.claude/settings.json` → `permissions.allow` before running the bootstrap (`npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init`); without it, the bootstrap command is silently blocked.
- **Claude as eval target.** Use `provider_kind=claude_agent_sdk` in `config/eval-tiers.toml`. The Agent tool / subagents you spawn from a Claude Code session run on your session's model — they are NOT the eval target and will not exercise the harness's pinned SDK.
- **Running evals from a Claude Code session.** Invoke `npm run eval:smoke` / `npm run eval:regression` via Bash. Exit code 100 means "harness OK, assertion failed" — do not treat it as a tool error.
- **SDK providers + ESM.** `opencode_sdk` and `codex_sdk` load their packages via dynamic `import()` (ESM-only). If a harness run fails with `ERR_MODULE_NOT_FOUND` against `@opencode-ai/sdk` or `@openai/codex-sdk`, the package isn't installed in the consumer repo — `cd tests/evals && npm install` rather than re-running the failing eval.
- **Consumer `.env` setup.** Keys must be in `process.env` before `ad-evals` starts — the framework has no dotenv loader. Walkthrough: `docs/setup.md` → "Step 1.5 — Configure secrets". TL;DR for a Claude Code session: create `tests/evals/.env`, append `tests/evals/.env` to `.gitignore` (the scaffolder does NOT auto-ignore it), populate the env vars matching each tier's `provider_kind` (full table in Step 1.5), then either `set -a; . tests/evals/.env; set +a` before invoking `ad-evals` from Bash, OR set `load_local_env = true` in the `[runtime]` block of `tests/evals/config/eval-tiers.toml` if and only if your `provider_id` points at `framework://opencode-cli-plugin-provider.js` (the plugin variant — not the base provider). Watch out for a leaked `OPENHANDS_BASE_URL` exported from a parent shell: `openhands_sdk` silently enters gateway mode and may surface a misleading `OpenAIException - Connection error`; clear with `OPENHANDS_BASE_URL= npm run eval:smoke`.
- **Darwin lockfile drift.** `bin/ad-evals.js` runs `npm install` at startup; on macOS this prunes Linux-only `@swc/core-linux-*` optional deps and dirties `package-lock.json`. After a local harness run, restore it with `git restore package-lock.json` before committing.
- **OpenHands gateway mode (v1.4.0).** When the user wants `openhands_sdk` against an OpenAI-compatible endpoint (Accelerate gateway, LiteLLM proxy, vLLM, …), use `model` + `extra.base_url` in `config/eval-tiers.toml` and `OPENHANDS_API_KEY` in the consumer `.env` — do NOT plumb `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` in this mode (they are ignored). See `AGENTS.md` → "OpenHands gateway mode" and `docs/setup.md` for the tier-config snippet.
