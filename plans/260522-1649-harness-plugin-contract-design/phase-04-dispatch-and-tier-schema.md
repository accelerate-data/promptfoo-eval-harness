# Phase 04 — Dispatch + Tier Schema (B.8-B.11)

> **Sub-issue:** VD-2174-3. **Status:** complete. **Blocked by:** phase 03.
> Time budget: ~3 days.

## Context Links

- Spec: [`spec.md`](spec.md) §1.6 (config validation), §2.2 (single URL emission), §4.1-4.2 (parallelism + concurrency clamping), §6.1 (tier schema v0/v1), §6.2 (eval-map.json), §9.2 Steps B.8-B.11.
- Predecessor: phase 03 (`_node_bridge.js`, `concurrency.js`, `_python_adapter.py`).

## Overview

- **Priority:** Wires the dispatch layer end-to-end. Without this phase, the bridge from phase 03 cannot be reached by `bin/ad-evals.js`.
- **Current status:** Pending.
- **Brief:** Extend `scripts/framework/eval-tier-config.js` to accept both v0 (legacy OpenCode-only) and v1 (multi-provider tier) shapes; refactor `scripts/framework/resolve-promptfoo-config.js` to emit ONE `file://scripts/framework/_node_bridge.js` URL per `[[tiers.X.providers]]` entry per scenario (row cardinality follows tier config — `--compare` semantics deferred to Phase 2 per spec §4.1); add validation that fails fast on unknown `provider_kind` (v1.0.0 accepts only `opencode_cli` + `openhands_sdk`) or invalid `vars.turns` shape; wire case-level concurrency clamping at the bridge boundary.

## Key Insights

- v0 tier shape MUST keep working — production data-engineering repo relies on it (spec §6.1, §9.7 success criteria).
- Per spec §4.3, a v1 tier may list multiple `[[tiers.X.providers]]` entries; each entry produces one bridge URL. Row cardinality is determined by tier config, NOT by `--compare`-style multi-model fan-out. Per spec §4.1: "Provider/model fan-out (`--compare`) and per-provider concurrency caps are deferred to Phase 2." Phase 1 emits one bridge URL per `[[tiers.X.providers]]` entry and lets Promptfoo iterate the matrix; `--compare` semantics are NOT in scope.
- `concurrency.js` global semaphore caps case-level concurrency for a single Promptfoo run (spec §4.1). Multi-scenario fan-out across processes is capped by phase 08's OUTER `p-limit` in `dir-walk.js`.
- Validation is now load-bearing: `provider_kind` typos in YAML must surface BEFORE Promptfoo spawns providers (catch at config resolution time). v1.0.0 ships only `opencode_cli` + `openhands_sdk`; future kinds (`claude_agent_sdk`, `opencode_sdk`, `codex_sdk`) are reserved-but-rejected at validation time so bad config can never reach runtime dispatch.

## Requirements

### Functional

1. **Tier config v0 + v1 (B.8):** `scripts/framework/eval-tier-config.js` accepts both shapes and reports which it parsed; v0 implicitly maps to `provider_kind: opencode_cli` with the existing `agent` field.
2. **Single URL emitter (B.9):** `scripts/framework/resolve-promptfoo-config.js` emits exactly ONE provider URL — `file://scripts/framework/_node_bridge.js` — per `[[tiers.X.providers]]` entry per scenario. The nested `config:` block carries `provider_kind`, `model`, and any `provider_options`. Multiple providers per tier (v1 schema) produce multiple URLs; this is NOT `--compare` semantics (spec §4.1 defers `--compare` to Phase 2).
3. **Concurrency clamping (B.10):** The bridge's `concurrency.global` p-limit is sourced from `AD_EVALS_MAX_CONCURRENCY` (default 4); document this in `docs/concurrency.md`. Adapter clamps regardless of Promptfoo's own concurrency knob. This is the INNER (per-process) cap; the OUTER (cross-process) cap lives in phase 08's `dir-walk.js`.
4. **Validation (B.11):** New `scripts/framework/validate-package-config.js`:
   - v1.0.0 accepts `provider_kind` ∈ `{opencode_cli, openhands_sdk}` ONLY. Future kinds (`claude_agent_sdk`, `opencode_sdk`, `codex_sdk`) are reserved — validator returns an explicit error like `"provider_kind 'claude_agent_sdk' is reserved for Phase 2-4 and not registered in v1.0.0"`. The accepted set is derived from `_node_bridge.js KIND_REGISTRY`, so adding a kind in a future release auto-extends validation.
   - Asserts model name resolves through `model-resolver` (if SDK kind).
   - For tests with `vars.turns`, asserts it is a non-empty array of strings (no `undefined` fallback) — fail fast before the bridge has to.
   - Surface errors with file/line context.

### Non-functional

- Backwards compatibility with v0 confirmed by integration test against legacy OpenCode fixture.
- Validation errors are actionable (point to YAML path).
- No new runtime deps.

## Architecture

```text
bin/ad-evals.js
  → resolve-promptfoo-config.js (B.9)
     ├── eval-tier-config.js (B.8)  ──┐  parse v0 OR v1; normalize → v1 internally
     ├── package-config loader        │
     └── validate-package-config.js (B.11)  ──┐  fail fast on bad provider_kind / turns shape
                                              │
                                              ▼
                            emits Promptfoo config JSON
                            providers: [{ id: 'file://scripts/framework/_node_bridge.js',
                                         label: '<tier>/<model>',
                                         config: { provider_kind, model, provider_options, run_id, case_id } }]
                            (one per (tier × model × scenario))

                            concurrency.js global p-limit clamps bridge.callApi invocations
```

## Related Code Files

- **Modify:**
  - `scripts/framework/eval-tier-config.js`
  - `scripts/framework/resolve-promptfoo-config.js`
  - `scripts/framework/concurrency.js` (env knob refinement)
  - `bin/ad-evals.js` (invoke validator before resolving)
  - `docs/concurrency.md` (NEW or update)
- **Create:**
  - `scripts/framework/validate-package-config.js`
  - `scripts/framework/validate-package-config.test.js`
  - `scripts/framework/eval-tier-config.test.js`
  - `scripts/framework/resolve-promptfoo-config.test.js` (extend existing if present)
  - `tests/fixtures/v0-legacy-tier.json`, `tests/fixtures/v1-multi-provider-tier.json`
- **Delete:** none.

## Implementation Steps

### B.8 — Tier config v0 + v1 dual-form parsing

1. Read existing `scripts/framework/eval-tier-config.js` to understand v0 shape.
2. Author `tests/fixtures/v0-legacy-tier.json` and `tests/fixtures/v1-multi-provider-tier.json` exactly per spec §6.1.
3. Author `scripts/framework/eval-tier-config.test.js`:
   - `parseTierConfig(v0Fixture)` → returns normalized v1 shape with `provider_kind: opencode_cli` injected.
   - `parseTierConfig(v1Fixture)` → returns the same shape verbatim.
   - `parseTierConfig(invalidShape)` → throws with line/path context.
4. Extend `eval-tier-config.js` to handle both forms; internal representation is always v1.
5. Run tests — green.
6. Commit: `feat(vd-2174-3): support v0 + v1 tier config shapes (B.8)`.

### B.9 — Single URL emitter

7. Read existing `scripts/framework/resolve-promptfoo-config.js`.
8. Author or extend `scripts/framework/resolve-promptfoo-config.test.js`:
   - Given a v1 tier listing 2 `[[tiers.X.providers]]` entries × 3 scenarios, expect exactly `2 × 3 = 6` provider entries (row cardinality = providers × scenarios per spec §4.3).
   - Every entry's `id` equals `file://scripts/framework/_node_bridge.js` (or framework://-scheme equivalent already in use).
   - Every entry carries `config.provider_kind`, `config.model`, `config.run_id`, `config.case_id`.
   - Per-scenario `vars` reaches Promptfoo as the standard `vars:` block (NOT inside `config:`).
   - Add an assertion that nothing in the emitted config references `--compare`; per spec §4.1 that semantic belongs to Phase 2.
9. Refactor `resolve-promptfoo-config.js` to emit the single URL form. Keep run_id stable across the matrix.
10. Run tests — green.
11. Commit: `feat(vd-2174-3): emit single bridge URL per tier×model×scenario (B.9)`.

### B.10 — Concurrency clamping wiring

12. Refine `concurrency.js`:
    - `AD_EVALS_MAX_CONCURRENCY` parsed at module load.
    - Default 4 when unset; reject non-positive integer with a useful error.
    - Expose `concurrency.global` and `concurrency.spawn(label)` (returns a labeled limiter for diagnostics).
13. Author `docs/concurrency.md` describing the knob, default, and why bridge-side clamping coexists with Promptfoo concurrency.
14. Author Layer 2 test `scripts/framework/concurrency.parallel.test.js`:
    - Fakes 8 simultaneous `callApi` invocations with `AD_EVALS_MAX_CONCURRENCY=2`.
    - Asserts only 2 are ever in-flight (counter increments + decrements with `Promise.all` race).
15. Commit: `feat(vd-2174-3): clamp bridge concurrency via global p-limit (B.10)`.

### B.11 — Package config validator

16. Author `scripts/framework/validate-package-config.js`:
    - `validate(packageConfig, {kindRegistry})` returns either `{ok: true}` or `{ok: false, errors: [...]}`.
    - Each error has `path`, `expected`, `received`, `message`.
    - Rules per spec §1.6 + §4.3:
      - `provider_kind` ∈ keys(kindRegistry). In v1.0.0 `kindRegistry = {opencode_cli, openhands_sdk}`; any other value (including the reserved-but-unshipped `claude_agent_sdk` / `opencode_sdk` / `codex_sdk`) is rejected with the message `"provider_kind '<name>' is reserved for a future Phase and not registered in v<harness-version>"`.
      - SDK kinds require `model` and the model is parseable via `model-resolver`.
      - `vars.turns` (if present) is non-empty array of non-empty strings.
17. Author `scripts/framework/validate-package-config.test.js` covering each rule (pass + fail cases); include explicit negative cases for each of the three reserved future kinds.
18. Wire into `bin/ad-evals.js`: after `resolve-promptfoo-config`, before invoking Promptfoo, run the validator. Exit non-zero with the error table on failure.
19. Run `npm test` end-to-end.
20. Commit: `feat(vd-2174-3): validate package config + fail fast on bad shapes (B.11)`.

## Todo List

- [x] B.8: Tier config v0 + v1 dual parse + tests + fixtures.
- [x] B.9: Single-URL emitter + matrix test + extant test refactor.
- [x] B.10: Concurrency clamping + `docs/concurrency.md` + parallel test.
- [x] B.11: Package config validator + wiring into `bin/ad-evals.js` + tests.
- [x] Confirm v0 legacy fixture still produces a working OpenCode-only Promptfoo config.

## Success Criteria

- All B.8-B.11 commits land on the feature branch.
- `npm test` green; new test files cover both happy and failure paths.
- Legacy v0 fixture path produces a Promptfoo config compatible with current OpenCode flow.
- v1 fixture produces N×M×S provider entries (where N=tiers, M=models per tier, S=scenarios), every entry pointing at the single bridge URL.
- Validator catches the four invariants from spec §1.6 with line/path context.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| v0 → v1 normalization regresses existing consumer flow | M | H | Legacy fixture-driven Layer 2 test; manual rerun against data-engineering consumer's `eval-map.json` in phase 05. |
| Validator over-rejects | L | M | Keep error rules small + spec-anchored; only add new rule with a spec citation. |
| Promptfoo concurrency knob fights with our semaphore | M | M | Doc'd in `docs/concurrency.md`: our limiter is strictly lower-bound; Promptfoo can be larger without breakage. |

## Security Considerations

- Validator never logs secret-shaped strings (defer to phase 07 redactor).
- v0/v1 fixtures contain dummy data only — never paste real model API keys.

## Next Steps

- Unblocks phase 05 (OpenCode CLI lock + dispatch).
- Phase 06 (OpenHands SDK provider) consumes the registry from `KIND_REGISTRY` and the validator.
