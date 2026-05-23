# VD-2174 — Harness Plugin Contract + Multi-SDK Provider (v1.0.0)

> **For agentic workers:** Implement task-by-task. Steps live in each `phase-XX-*.md`; tick checkboxes as you go.
> Default execution is via `superpowers:subagent-driven-development`. Phase 1 ships **OpenCode CLI preserved + OpenHands SDK added**. Do NOT raise a PR when implementation finishes (per user directive).

**Goal:** Refactor `@accelerate-data/promptfoo-eval-harness` from a single OpenCode CLI provider into a plugin contract that supports multiple in-process SDK providers, with multi-turn + parallelism, while preserving OpenCode CLI as the data-engineering production flow.

**Architecture:** One canonical Promptfoo provider URL (`file://scripts/framework/_node_bridge.js`) dispatches by `provider_kind` — `opencode_cli` runs in-process; SDK kinds spawn a Python/Node subprocess that speaks NDJSON over stdio (`init` / `turn` / `finalize` / `shutdown`). Concurrency layering: INNER bridge `p-limit` caps case-level concurrency per Promptfoo process (spec §4.2); OUTER `p-limit` in phase 08's `dir-walk.js` caps the number of Promptfoo subprocesses spawned by `ad-evals run <dir>` (spec §5.3). Multi-scenario fan-out ships in Phase 1; `--compare`-style multi-model fan-out is deferred to Phase 2 per spec §4.1. Hand-written contract types in both Python and TypeScript; no generator.

**Tech Stack:** Node ≥20 + Python ≥3.12 (`uv` managed), Promptfoo `file://` provider, NDJSON IPC, `p-limit`, `openhands-sdk==1.22.1` (Phase 1 only SDK).

**Spec:** [`spec.md`](spec.md) — v8, APPROVED by codex pass 8 on 2026-05-22. Source of truth; phase files reference it by section.

**Linear:** [VD-2174](https://linear.app/acceleratedata/issue/VD-2174) + 9 sub-issues per spec §9.3.

---

## Phases

| # | Phase | Sub-issue | Status | Deps |
| - | ----- | --------- | ------ | ---- |
| 01 | [OpenHands SDK shape spike (gating)](phase-01-openhands-sdk-shape-spike.md) | VD-2174-1 | pending | — |
| 02 | [Promptfoo file-provider option-shape spike (gating)](phase-02-promptfoo-file-provider-shape-spike.md) | VD-2174-1B | pending | — (parallel with 01) |
| 03 | [Foundation + IPC (A.1-A.7)](phase-03-foundation-and-ipc.md) | VD-2174-2 | pending | 01 AND 02 |
| 04 | [Dispatch + tier schema (B)](phase-04-dispatch-and-tier-schema.md) | VD-2174-3 | pending | 03 |
| 05 | [Lock OpenCode CLI provider + dispatch (C)](phase-05-lock-opencode-cli-provider.md) | VD-2174-4 | pending | 04 |
| 06 | [OpenHands SDK provider (D)](phase-06-openhands-sdk-provider.md) | VD-2174-5 | pending | 03 |
| 07 | [Cross-cutting: secrets / logger / workspace post-run assertion (E)](phase-07-cross-cutting.md) | VD-2174-6 | pending | 03 |
| 08 | [Scenarios + CLI directory walk + migration (F + G)](phase-08-scenarios-cli-dir-migration.md) | VD-2174-7 | pending | 05, 06, 07 |
| 09 | [Distribution prep (H)](phase-09-distribution-prep.md) | VD-2174-8 | pending | 08 |

## Hard constraints (binding for every phase)

- Harness changes live in this repo only; the data-engineering consumer repo is **never** touched from these phases.
- Parallelism in Phase 1: case-level (inner semaphore, spec §4.2) + multi-scenario across processes (outer semaphore in `dir-walk.js`, spec §5.3). Multi-model `--compare` fan-out is deferred to Phase 2 (spec §4.1).
- Scenarios live inside this repo at `tests/harness-scenarios/packages/<name>/` (spec §5.1 + §5.3).
- Do NOT raise a PR when implementation finishes — leave the worktree clean for the user.
- Do NOT commit `.env` or secrets; never disable pre-commit hooks (`--no-verify`); never force-push.
- Conventional commits, no AI references in commit messages.

## Spec → phase index (cross-reference)

| Spec section | Owning phase |
| ------------ | ------------ |
| §1 Provider contract types | 03 (defines), 06 (implements OpenHands), 05 (implements OpenCode CLI) |
| §2 Subprocess adapter + IPC | 02 (verifies shape), 03 (builds it) |
| §2.5 Cold-spawn benchmark | 03 (Step A.7) |
| §3 Multi-turn (`vars.turns`) | 03 + 06 |
| §4 Parallelism + semaphore (INNER) | 03 (concurrency.js), 04 (tier schema) |
| §5 Scenarios + `ad-evals run <dir>` + OUTER semaphore | 08 (dir-walk.js + outer p-limit) |
| §6 Distribution + sdk-pins | 03 (pin file), 09 (publish workflow) |
| §7 Cross-cutting (secrets / logger / workspace post-run assertion) | 07 (standalone workspace-guard module deferred to Phase 1.x per §7.3) |
| §8 Testing pyramid | each phase owns its layer |
| §9.7 Phase-1 success criteria | 09 (release-readiness check) |
