# Phase 05 — Lock OpenCode CLI Provider + Dispatch (C.13-C.15)

> **Sub-issue:** VD-2174-4. **Status:** complete. **Blocked by:** phase 04.
> Time budget: ~2 days.

## Context Links

- Spec: [`spec.md`](spec.md) §1.5 (canonical metadata fields), §2.6 (bridge `callApi` for in-proc kinds), §5.1 (`opencode-cli-compatibility` scenario), §8.3 Layer 2 contract test, §9.2 Steps C.13-C.15, §9.7 (Phase 1 success criteria — OpenCode CLI must remain green).
- Predecessor: phase 04 (dispatch + validator). Reads phase 03 (`_node_bridge.js`).
- Reference: existing `scripts/framework/opencode-cli-provider.js` (current in-tree implementation).

## Overview

- **Priority:** Production guard rail. Data-engineering consumer's CI green status depends on no behavioral regression here.
- **Current status:** Pending.
- **Brief:** Lock the OpenCode CLI provider's behavior with a Layer 2 contract test, perform the minimal refactor to fit the §1 plugin contract (no new features), and add the `opencode-cli-compatibility` scenario to `tests/harness-scenarios/` so every harness build verifies the legacy flow.

## Key Insights

- OpenCode CLI runs **in-process** through the bridge (`KIND_REGISTRY.opencode_cli.mode = 'inproc'`). Subprocess + NDJSON does NOT apply here.
- The provider's existing logic must be preserved — this phase is "wrap, not rewrite". Any optimization opportunity is a separate ticket.
- Lock with a contract test BEFORE touching code (TDD discipline). Refactor only after the lock is green.

## Requirements

### Functional

1. **Contract lock test (C.13):** `scripts/framework/opencode-cli-provider.contract.test.js`:
   - Boots the provider in isolation with a canned package config.
   - Exercises the four lifecycle methods (`init`, `turn`, `finalize`, `shutdown`).
   - Asserts every return path emits `baseMetadata` per spec §1.5.
   - Asserts `vars.turns` semantics match spec §3 (`length > 1` rejected with validation error; transcript invariant length-equality holds; `[undefined]` rejected).
   - Includes regression cases for previously-found bugs (mine `git log scripts/framework/opencode-cli-provider.js` and add a case for each fix).
2. **Minimal refactor (C.14):** Adapt `scripts/framework/opencode-cli-provider.js` to expose the contract API:
   - Expose ONLY the four lifecycle methods (`init`, `turn`, `finalize`, `shutdown`) per spec §1.2.
   - Preserve the five behaviors enumerated in spec §7.4 (env passthrough, argv shape, exit-code mapping, mock-mode bypass, redaction-friendly logging).
   - DO NOT move metadata stamping, transcript shaping, semaphore acquisition, or `vars.turns` validation into the provider — these stay in the bridge per spec §1.5 + §2.6 + §7.4.
   - Keep CLI invocation (env, spawn, parsing) byte-for-byte unchanged.
   - Add no new options.
3. **Scenario (C.15):** `tests/harness-scenarios/packages/opencode-cli-compatibility/`:
   - `promptfooconfig.json` exercising 1 tier (v0 shape), 1 model, 3 SINGLE-TURN cases (`vars.turns.length === 1` each). `opencode_cli` rejects `vars.turns.length > 1` per spec §1 + §3.1 — multi-turn rejection is exercised in the contract test (C.13) and the validator (phase 04), NOT in this L4 scenario data.
   - `tests/test.csv` + `prompts/*.txt` (canned, deterministic).
   - Adds to `tests/harness-scenarios/packages/index.json` so `ad-evals run tests/harness-scenarios/packages/opencode-cli-compatibility` works.

### Non-functional

- Contract test runs under 5 s.
- Scenario runs in CI on every push (gates merges) per spec §8.4.
- No live OpenCode network calls — fixture-mode if available, else mock the CLI binary at PATH for tests.

## Architecture

```text
scripts/framework/
├── opencode-cli-provider.js                 # minimal-refactored — same behavior
└── opencode-cli-provider.contract.test.js   # NEW — locks the contract (TDD)

tests/harness-scenarios/packages/
├── index.json                                # registry of scenarios
└── opencode-cli-compatibility/
    ├── promptfooconfig.json
    ├── prompts/<turn>.txt
    ├── tests/test.csv
    └── README.md
```

Dispatch chain (already wired by phase 03 + 04):

```text
ad-evals run tests/harness-scenarios/packages/opencode-cli-compatibility
  → resolve-promptfoo-config (single URL bridge)
    → bridge.callApi → KIND_REGISTRY.opencode_cli.mode === 'inproc'
      → require('./opencode-cli-provider').callApi(prompt, context, options)
        → in-proc CLI spawn (unchanged)
```

## Related Code Files

- **Create:**
  - `scripts/framework/opencode-cli-provider.contract.test.js`
  - `tests/harness-scenarios/packages/opencode-cli-compatibility/promptfooconfig.json`
  - `tests/harness-scenarios/packages/opencode-cli-compatibility/prompts/01-turn.txt` (+ additional turn prompts)
  - `tests/harness-scenarios/packages/opencode-cli-compatibility/tests/test.csv`
  - `tests/harness-scenarios/packages/opencode-cli-compatibility/README.md`
- **Modify:**
  - `scripts/framework/opencode-cli-provider.js` (minimal API surface for contract)
  - `tests/harness-scenarios/packages/index.json` (register the scenario)
  - `scripts/framework/_node_bridge.js` (point `KIND_REGISTRY.opencode_cli.module` at the refactored provider — if path changed)
- **Delete:** none.

## Implementation Steps

### C.13 — Contract lock test (TDD: write before refactor)

1. Read `scripts/framework/opencode-cli-provider.js` end-to-end.
2. Mine `git log -p scripts/framework/opencode-cli-provider.js` for past bug fixes — add one regression case per fix to the contract test.
3. Author `scripts/framework/opencode-cli-provider.contract.test.js`:
   - Section 1: lifecycle (init → turn ×N → finalize → shutdown).
   - Section 2: §1.5 canonical metadata on every return path.
   - Section 3: §3 `vars.turns` invariants (empty / `[undefined]` / `length > 1` / transcript length-equality).
   - Section 4: regression cases from step 2.
4. Run the test against the CURRENT provider — expect FAIL on the new contract assertions, PASS on existing lifecycle behavior.
5. Commit: `test(vd-2174-4): lock OpenCode CLI provider behavior with contract test (C.13)`.

### C.14 — Minimal refactor

6. Refactor `scripts/framework/opencode-cli-provider.js`:
   - Export `init(cfg)`, `turn(session, input)`, `finalize(session)`, `shutdown(session)` per §1.2.
   - DO NOT add metadata stamping, transcript shaping, or `vars.turns` validation here — those belong to the bridge per spec §1.5 + §2.6 + §7.4. The provider's `turn(session, input)` returns the raw `{output, error?, raw?}` shape; the bridge wraps it with canonical metadata.
   - CLI spawn logic untouched. The five §7.4 behaviors (env passthrough, argv shape, exit-code mapping, mock-mode bypass, redaction-friendly logging) preserved.
7. Run contract test — green.
8. Run `npm test` end-to-end — green.
9. Commit: `refactor(vd-2174-4): adopt §1 plugin contract for OpenCode CLI provider (C.14)`.

### C.15 — `opencode-cli-compatibility` scenario

10. Author scenario files at `tests/harness-scenarios/packages/opencode-cli-compatibility/`:
    - `promptfooconfig.json` — v0 tier shape (legacy form), one model (e.g. `claude-sonnet-4-6`), 3 single-turn cases (one `vars.turns` entry per case). Multi-turn rejection is covered by the contract test in C.13 and the validator in phase 04 (B.11) — do NOT add multi-turn cases here; per spec §1 + §3.1, `opencode_cli` rejects `vars.turns.length > 1` so multi-turn data in this scenario would fail the run.
    - Prompt files + `test.csv` + `README.md` documenting expected output.
11. Register in `tests/harness-scenarios/packages/index.json` per spec §5.1.
12. Run `node bin/ad-evals.js run tests/harness-scenarios/packages/opencode-cli-compatibility --dry-run`:
    - Confirm matrix is `1 tier × 1 model × 3 scenarios = 3` provider invocations.
    - Confirm all entries point at `file://scripts/framework/_node_bridge.js`.
13. Run the scenario for real (no API key needed if `opencode` CLI is on PATH in mock mode); confirm exit 0.
14. Commit: `feat(vd-2174-4): add opencode-cli-compatibility scenario (C.15)`.

## Todo List

- [x] C.13: Contract lock test before any provider change.
- [x] C.14: Minimal refactor — provider implements §1 contract; CLI spawn unchanged.
- [x] C.15: Scenario authored + registered + dry-run + actual-run both green.
- [x] Final: `npm test` green (204/204). `npm run lint:md` fails on Phase 06's openhands_sdk/README.md only (not phase 05 files).

## Success Criteria

- Contract test in place and gates future provider changes.
- OpenCode CLI provider exports the §1 lifecycle methods; CLI behavior byte-for-byte preserved.
- `opencode-cli-compatibility` scenario runs and passes on a developer laptop AND in CI matrix.
- No new options or feature surface added to the OpenCode CLI provider.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Refactor accidentally changes CLI spawn args | M | H | Contract test snapshot includes argv array; reviewer diffs against snapshot. |
| Scenario depends on Anthropic key in CI | L | M | Use mock-mode binary at `tests/_mock_opencode/opencode` and set PATH in scenario harness. |
| `_node_bridge.js KIND_REGISTRY` path drifts from refactored module | L | M | Test asserts `require('./opencode-cli-provider').init` exists. |

## Security Considerations

- Mock CLI binary, if introduced, never receives a real Anthropic key — it discards `ANTHROPIC_API_KEY` and emits canned responses.
- Scenario prompts contain only public sample data.

## Next Steps

- Unblocks phase 08 (scenarios + CLI dir walk + migration) — the dir-walk feature ships with this scenario as one of its primary smoke targets.
- Phase 06 (OpenHands SDK) runs in parallel with this phase since both depend only on phase 03.
