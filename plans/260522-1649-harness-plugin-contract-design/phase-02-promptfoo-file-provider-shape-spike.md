# Phase 02 — Promptfoo `file://` Option-Shape Spike (gating)

> **Sub-issue:** VD-2174-1B (Spike A.0.B). **Status:** pending. **May run in parallel with phase 01.**
> Time budget: 0.5 day.

## Context Links

- Spec: [`spec.md`](spec.md) §2.2 (callout), §2.6 (bridge `callApi`), §9.2 Step A.0.B, §9.4.
- Promptfoo source to read: `node_modules/promptfoo/dist/src/providers-*.js` (`ScriptCompletionProvider`).
- Output artifact (committed to this folder): `spike-promptfoo-file-shape.md`.

## Overview

- **Priority:** Gating — single load-bearing assumption of the bridge design. Blocks phase 03 Step A.5 and every downstream phase.
- **Current status:** Pending.
- **Brief:** Verify that a Promptfoo `file://provider.js` URL receives a `config:` block (with nested objects/arrays) verbatim as `options.config.*` on the `callApi(prompt, context, options)` call. If Promptfoo flattens, string-coerces, or hides the nested shape, the §2.2 + §2.6 bridge must be redesigned (likely move config into `vars` or emit multiple provider URLs).

## Key Insights

- Spec §2.2 critical-assumption callout: **only** Promptfoo's option-shape forwarding makes the single-URL bridge viable.
- v3 codex review removed the v2 `exec:` spike; this one replaces it.
- This spike requires zero SDK access — it is a pure Promptfoo behavior probe.

## Requirements

### Functional

1. Author `spikes/promptfoo-file-shape/probe.js`: a `file://` provider that exports a class with `id()` + `callApi(prompt, context, options)`. The probe serializes all three arguments to JSON and writes to stdout/disk.
2. Author `spikes/promptfoo-file-shape/promptfooconfig.json`: provider URL `file://spikes/promptfoo-file-shape/probe.js`, with a `config:` block containing:
   - Top-level string + integer.
   - Nested object (≥2 levels deep).
   - Array of strings and array of objects.
3. Run `npx promptfoo eval -c spikes/promptfoo-file-shape/promptfooconfig.json --output /tmp/probe-result.json`.
4. Assert from the JSON output:
   - `options.config` is present and structurally identical to the YAML `config:` block.
   - Nested objects are NOT flattened or coerced to strings.
   - Arrays preserve order and element types.
   - `context.vars` is reachable and contains the configured `vars:` values.

### Non-functional

- No Anthropic / live model usage — provider returns a canned response.
- Spike artifact contains the raw `options.config` JSON for review.

## Architecture

```text
spikes/promptfoo-file-shape/
├── probe.js                 # file:// provider — serializes argv
├── promptfooconfig.json     # config: with nested objects, arrays
├── tests/test.csv           # one row of dummy vars
└── README.md                # how to run
```

Output committed at `plans/260522-1649-harness-plugin-contract-design/spike-promptfoo-file-shape.md`.

## Related Code Files

- **Create:** `spikes/promptfoo-file-shape/probe.js`, `spikes/promptfoo-file-shape/promptfooconfig.json`, `spikes/promptfoo-file-shape/tests/test.csv`, `spikes/promptfoo-file-shape/README.md`, `plans/260522-1649-harness-plugin-contract-design/spike-promptfoo-file-shape.md`.
- **Modify:** none.
- **Delete:** none. Spike code stays as historical reference.

## Implementation Steps

1. Confirm `promptfoo` is installed locally (`node -e "require('promptfoo')"`). If missing, `npm ci` first.
2. Author `probe.js` per the architecture diagram. Inside `callApi`, write `JSON.stringify({ prompt, context, options }, null, 2)` to both stdout (truncated to 4 KB) and `/tmp/probe-call-${Date.now()}.json` (full).
3. Author `promptfooconfig.json` with a `providers:` block referencing `file://spikes/promptfoo-file-shape/probe.js` and a `config:` block matching the requirements (nested object 2+ levels, mixed-type arrays).
4. Run `npx promptfoo eval -c spikes/promptfoo-file-shape/promptfooconfig.json --output /tmp/probe-result.json`. Confirm exit 0.
5. Read the `/tmp/probe-call-*.json` capture. Diff its `options.config` against the YAML `config:` block.
6. Author `spike-promptfoo-file-shape.md`:
   - Verdict at the top: **PASS** / **FAIL — REDESIGN**.
   - Excerpt showing `options.config` matches the YAML (or where it diverges).
   - Coverage table: nested object preserved? array order preserved? string coercion? `context.vars` present?
   - Recommendation: keep §2.2 single-URL bridge (PASS) or redesign with `vars` / multiple URLs (FAIL).
7. Commit (`feat(vd-2174-1b): land Promptfoo file-provider option-shape spike + verdict`).
8. On FAIL: stop. Open a brainstorming sub-task to redesign §2.2/§2.6 before phase 03 begins.

## Todo List

- [ ] Step 1: Verify promptfoo installed.
- [ ] Step 2: Write `probe.js` argv serializer.
- [ ] Step 3: Write `promptfooconfig.json` with nested `config:`.
- [ ] Step 4: Run `npx promptfoo eval`; capture probe output.
- [ ] Step 5: Diff `options.config` vs YAML.
- [ ] Step 6: Author verdict markdown.
- [ ] Step 7: Commit spike + verdict.
- [ ] Step 8: Stop on FAIL or unblock phase 03 on PASS.

## Success Criteria

- Verdict file committed at `plans/260522-1649-harness-plugin-contract-design/spike-promptfoo-file-shape.md`.
- Verdict is **PASS** — `options.config` contains nested objects, arrays preserve order/types, no string coercion, `context.vars` reachable.
- `npx promptfoo eval` exits 0 against the spike config.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Promptfoo flattens or coerces `config:` | L | H | FAIL verdict → redesign §2.2/§2.6 (move to `vars` or multiple URLs). Block phase 03. |
| Promptfoo version skew between this repo and consumer repos | L | M | Pin the same version checked in `package.json`; record version in verdict. |
| `file://` resolution differs by working directory | L | L | Run from repo root; document cwd in verdict. |

## Security Considerations

- No live API keys involved — pure Promptfoo behavior probe.
- Truncate captured JSON before commit to avoid accidental disk-of-secrets if anyone re-runs locally with env injected.

## Next Steps

- On PASS: unblocks phase 03 (paired with phase 01 PASS).
- On FAIL: redesign §2.2/§2.6 via brainstorming, then re-spike, before phase 03.
