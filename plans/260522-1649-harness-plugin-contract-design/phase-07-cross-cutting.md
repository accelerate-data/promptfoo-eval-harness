# Phase 07 — Cross-Cutting: Secrets / Logger / Workspace Guard (E.22-E.24)

> **Sub-issue:** VD-2174-6. **Status:** complete. **Blocked by:** phase 03.
> Time budget: ~3 days.

## Context Links

- Spec: [`spec.md`](spec.md) §1.5 (canonical metadata fields), §2.4 (failure mode payloads — error redaction), §7.1 (secret redaction patterns + env_allowlist), §7.2 (structured logger schema), §7.3 (workspace post-run assertion — one branch in `run-promptfoo-with-guard.js`, no new module), §9.2 Steps E.22-E.24.
- Predecessor: phase 03 (`_node_bridge.js` already uses a placeholder redactor).

## Overview

- **Priority:** Security + observability foundation. Harness cannot ship to production without secret redaction + the workspace post-run assertion.
- **Current status:** Pending.
- **Brief:** Build `secret_redactor` (both Python + JS) replacing the phase 03 placeholder; ship `structured_logger` emitting NDJSON to stderr; add ONE post-run-assertion branch inside `scripts/run-promptfoo-with-guard.js` that verifies `tests/evals/.tmp/workspaces/<run_id>/` is empty after a successful run. A standalone `scripts/framework/workspace-guard.js` module is explicitly deferred to Phase 1.x per spec §7.3 — do NOT create it here.

## Key Insights

- Redaction patterns are version-controlled (§7.1) so the same patterns apply to Node bridge logs AND Python adapter logs.
- Logger MUST be NDJSON to stderr — stdout is reserved for IPC.
- Workspace cleanup happens in the bridge (per-case, in `_node_bridge.js` after each `callApi`); the new assertion is a POST-run check in `scripts/run-promptfoo-with-guard.js` that fails the run if leftover entries remain. `AD_EVALS_KEEP_WORKSPACE=1` disables BOTH the bridge cleanup AND the post-run assertion (debugging escape hatch).
- Workspace root is `tests/evals/.tmp/workspaces/<run_id>/` (spec §7.3), NOT `./.eval-workspaces/`.

## Requirements

### Functional

1. **Secret redactor (E.22):**
   - `scripts/framework/secret_redactor.js` (Node) and `scripts/framework/providers/_secret_redactor.py` (Python).
   - Both import patterns from `config/redaction-patterns.json` so source-of-truth is shared.
   - Patterns cover: Anthropic / OpenAI / OpenHands API keys, AWS access keys, GitHub PATs, generic `Bearer <token>` headers, GCP service-account JSON snippets.
   - Replace match → `<redacted-{pattern-name}>`.
   - Used by `baseMetadata().error.message`, every logger emission, and SDK adapter stderr capture.
2. **Structured logger (E.23):**
   - `scripts/framework/structured_logger.js` + `scripts/framework/providers/_structured_logger.py`.
   - Emits one NDJSON record per call to stderr.
   - Schema: `{ts, level, msg, run_id, case_id, provider_kind, model, extra?}`.
   - All `console.log` / `print` in bridge + adapter migrate to this logger.
3. **Workspace post-run assertion (E.24):**
   - Add ONE new branch inside `scripts/run-promptfoo-with-guard.js` (do NOT create a new file).
   - On a successful Promptfoo exit, walks `tests/evals/.tmp/workspaces/<run_id>/`:
     - If the directory does not exist OR is empty → assertion passes.
     - If non-empty → fail the run with a clear error listing the leftover entries.
   - Honors `AD_EVALS_KEEP_WORKSPACE=1` (or `=true`) — skips BOTH the bridge's per-case cleanup AND this post-run assertion (debug escape hatch).
   - `run_id` comes from the same source the bridge writes into `baseMetadata` (env var `AD_EVALS_RUN_ID`, or generated upstream); the guard receives it via env so the path resolves identically to what the bridge used.
   - Layer 2 test extends `scripts/run-promptfoo-with-guard.test.js` (or adds it if absent) covering: (a) empty workspace → pass; (b) leftover entry → fail with workspace_dirty error; (c) `AD_EVALS_KEEP_WORKSPACE=1` → assertion skipped even with leftovers; (d) non-existent dir → pass (nothing was created).

### Non-functional

- Redactor patterns are conservative: false positives preferred to leaked keys.
- Logger overhead < 1 ms per record.
- Workspace post-run assertion runs once per Promptfoo invocation (cheap directory stat) — no perf concern.

## Architecture

```text
scripts/framework/
├── secret_redactor.js              # Node-side redaction
├── secret_redactor.test.js
├── structured_logger.js
└── structured_logger.test.js

scripts/framework/providers/
├── _secret_redactor.py             # Python-side — same patterns
├── _secret_redactor.test.py
├── _structured_logger.py
└── _structured_logger.test.py

scripts/
├── run-promptfoo-with-guard.js     # MODIFIED — adds workspace post-run assertion branch
└── run-promptfoo-with-guard.test.js # extended/created for the new branch

config/
└── redaction-patterns.json         # SOURCE OF TRUTH — both languages load this
```

Note: NO new `workspace-guard.js` module. Spec §7.3 explicitly defers that module to Phase 1.x.

## Related Code Files

- **Create:**
  - `config/redaction-patterns.json`
  - `scripts/framework/secret_redactor.js` (+ test)
  - `scripts/framework/providers/_secret_redactor.py` (+ test)
  - `scripts/framework/structured_logger.js` (+ test)
  - `scripts/framework/providers/_structured_logger.py` (+ test)
  - `scripts/run-promptfoo-with-guard.test.js` (if not present; otherwise extend in place)
- **Modify:**
  - `scripts/framework/_node_bridge.js` — replace placeholder redactor; route logs through structured logger; ensure per-case workspace cleanup writes/empties under `tests/evals/.tmp/workspaces/<run_id>/` (honor `AD_EVALS_KEEP_WORKSPACE=1`).
  - `scripts/framework/providers/_python_adapter.py` — wire redactor + logger.
  - `scripts/framework/providers/openhands_sdk/provider.py` — surface `workspace_dir = tests/evals/.tmp/workspaces/<run_id>/<case_id>/` to the SDK so tool calls write inside the run's scratch tree.
  - `scripts/run-promptfoo-with-guard.js` — add the post-run assertion branch per E.24.
- **Delete:** `<redacted-pending-phase-07>` placeholder in `_node_bridge.js`.

## Implementation Steps

### E.22 — Secret redactor (Python + Node parity)

1. Author `config/redaction-patterns.json` per spec §7.1 (Anthropic, OpenAI, OpenHands, AWS, GitHub, Bearer, GCP). Each entry: `{name, regex, replacement}`.
2. Author `scripts/framework/secret_redactor.js`:
   - Loads patterns once at module init.
   - Exports `redact(str)` returning the redacted string.
3. Author `scripts/framework/secret_redactor.test.js` with one case per pattern + a multi-pattern combined case + a false-positive guard.
4. Author `scripts/framework/providers/_secret_redactor.py` with identical behavior and `_secret_redactor.test.py`.
5. Add a parity test `scripts/framework/secret_redactor.parity.test.js`:
   - Reads `config/redaction-patterns.json`.
   - For each pattern, asserts the same input string redacts identically through both implementations (spawns Python adapter subprocess to round-trip).
6. Replace the phase 03 placeholder in `_node_bridge.js` with real `redact()` calls on every error-message return path.
7. Commit: `feat(vd-2174-6): land Node + Python secret redactor with shared patterns (E.22)`.

### E.23 — Structured logger

8. Author `scripts/framework/structured_logger.js`:
   - `log({level, msg, ...extra})` writes one NDJSON line to `process.stderr`.
   - Reads `run_id`, `case_id`, `provider_kind`, `model` from a `context` set by the bridge at `init`.
   - Every payload is run through the redactor.
9. Author `scripts/framework/structured_logger.test.js` (capture stderr; assert NDJSON shape; assert redaction applied).
10. Mirror in Python: `_structured_logger.py` + `_structured_logger.test.py`.
11. Migrate bridge + adapter `console.log` / `print` calls to the logger.
12. Commit: `feat(vd-2174-6): NDJSON structured logger with run/case metadata (E.23)`.

### E.24 — Workspace post-run assertion (single branch in run-promptfoo-with-guard.js)

13. Read `scripts/run-promptfoo-with-guard.js` end-to-end. Identify the success exit path.
14. Add ONE branch at the end of the success path:
    - Resolve `WORKSPACE_ROOT = path.join('tests/evals/.tmp/workspaces', process.env.AD_EVALS_RUN_ID)`.
    - If `process.env.AD_EVALS_KEEP_WORKSPACE` is truthy → skip the assertion (early return).
    - Else: `fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })` (catch ENOENT → pass; empty dir → pass).
    - On leftover entries → log them and exit non-zero with `WORKSPACE_DIRTY: <count> leftover entries under tests/evals/.tmp/workspaces/<run_id>/`.
15. Update `_node_bridge.js` per-case cleanup logic (cohabits with phase 03's existing scratch-dir handling):
    - Each `callApi` writes case scratch under `tests/evals/.tmp/workspaces/<run_id>/<case_id>/`.
    - On case finish (success OR failure), bridge removes `<case_id>/`, unless `AD_EVALS_KEEP_WORKSPACE` is truthy.
    - The post-run assertion in step 14 is the safety net that catches missed cleanup.
16. Author or extend `scripts/run-promptfoo-with-guard.test.js`:
    - Case A — empty workspace dir → guard exits 0.
    - Case B — leftover file → guard exits non-zero with `WORKSPACE_DIRTY` message.
    - Case C — `AD_EVALS_KEEP_WORKSPACE=1` with leftovers → guard exits 0 (assertion skipped).
    - Case D — non-existent workspace dir → guard exits 0 (no work was done).
17. Commit: `feat(vd-2174-6): post-run workspace assertion in run-promptfoo-with-guard (E.24)`.

## Todo List

- [x] E.22: Redactor + parity test + bridge wired through real redactor.
- [x] Bridge label shape bug fixed (post-phase-05 finding); provider-shim.js deleted.
- [x] E.23: Structured logger + migration of `console.log` / `print` callsites.
- [x] E.24: Post-run assertion branch in `run-promptfoo-with-guard.js` + Layer 2 test cases A-D.
- [x] `npm test` (257 pass), `pytest` (107 pass), `ruff check` clean, `npm run lint:md` clean, bench PASS.

## Success Criteria

- All E.22-E.24 commits land on the feature branch.
- Every Promptfoo error message routed through the bridge is redacted (assert via `_node_bridge.test.js` failure-mode cases).
- NDJSON logs in stderr include `run_id` / `case_id` / `provider_kind` / `model` for every record.
- `scripts/run-promptfoo-with-guard.js` fails any run that leaves entries under `tests/evals/.tmp/workspaces/<run_id>/`; `AD_EVALS_KEEP_WORKSPACE=1` cleanly bypasses both cleanup and assertion.
- NO new `workspace-guard.js` module is created (spec §7.3 — deferred to Phase 1.x).
- Layer 3 mock-SDK tests from phase 06 still green (regression check).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Redaction pattern over-redacts (false positive eats real diagnostic info) | M | M | Tests assert known-good error messages are not over-redacted; conservative patterns; clearly tag redacted segments by name. |
| Logger overhead degrades cold spawn budget | L | M | Single `JSON.stringify` per record + direct `fs.writeSync` on Node; phase 03 benchmark re-run after wiring. |
| Post-run assertion misfires on legitimately empty runs (e.g. early Promptfoo abort) | L | L | Assertion only runs on the success exit branch; abort paths bypass it naturally. |
| `AD_EVALS_KEEP_WORKSPACE=1` accidentally left on in CI | M | L | Doc'd in `docs/concurrency.md` companion + flagged in `release-readiness.md` checklist; CI workflow explicitly does NOT export the var. |

## Security Considerations

- Redactor is the **only** line of defense between SDK errors and Promptfoo's HTML/JSON report — must be defense-in-depth (also redact at logger level, at error-message level, at adapter-stderr capture).
- Workspace scoping in Phase 1 relies on the SDK respecting the `workspace_dir` we pass into `init`; the post-run assertion catches leaks (leftover files) but does NOT block tool calls in-flight. A full filesystem sandbox (the deferred `workspace-guard.js`) is tracked for Phase 1.x.
- `env_allowlist` from spec §7.1 remains the primary boundary against credential leakage into OpenHands `BashTool`.
- `config/redaction-patterns.json` itself never contains real keys; only pattern definitions.

## Next Steps

- Unblocks phase 08 (scenarios + CLI dir walk + migration) — scenarios require real redactor in place for safe sample output.
- Phase 09 (distribution prep) requires logger schema doc'd in README.
