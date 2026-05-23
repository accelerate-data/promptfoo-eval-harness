<!-- markdownlint-disable-file MD041 -->
@AGENTS.md

Adapter file. `AGENTS.md` is canonical. Below: only Claude-specific guidance that diverges from cross-agent docs.

## Claude Code notes

- **Allow list.** Add `Bash(npx *)` to `~/.claude/settings.json` → `permissions.allow` before running the bootstrap (`npx --package @accelerate-data/promptfoo-eval-harness eval-harness-init`); without it, the bootstrap command is silently blocked.
- **Claude as eval target.** Use `provider_kind=claude_agent_sdk` in `config/eval-tiers.toml`. The Agent tool / subagents you spawn from a Claude Code session run on your session's model — they are NOT the eval target and will not exercise the harness's pinned SDK.
- **Running evals from a Claude Code session.** Invoke `npm run eval:smoke` / `npm run eval:regression` via Bash. Exit code 100 means "harness OK, assertion failed" — do not treat it as a tool error.
- **SDK providers + ESM.** `opencode_sdk` and `codex_sdk` load their packages via dynamic `import()` (ESM-only). If a harness run fails with `ERR_MODULE_NOT_FOUND` against `@opencode-ai/sdk` or `@openai/codex-sdk`, the package isn't installed in the consumer repo — `cd tests/evals && npm install` rather than re-running the failing eval.
- **Darwin lockfile drift.** `bin/ad-evals.js` runs `npm install` at startup; on macOS this prunes Linux-only `@swc/core-linux-*` optional deps and dirties `package-lock.json`. After a local harness run, restore it with `git restore package-lock.json` before committing.
