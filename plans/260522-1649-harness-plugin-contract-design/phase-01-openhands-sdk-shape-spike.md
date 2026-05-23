# Phase 01 — OpenHands SDK Shape Spike (gating)

> **Sub-issue:** VD-2174-1 (Spike A.0). **Status:** pending. **May run in parallel with phase 02.**
> Time budget: 1-2 days.

## Context Links

- Spec: [`spec.md`](spec.md) §9.2 Step A.0, §9.4, §1 (provider contract), §6.4 (sdk-pins.toml).
- PyPI: `openhands-sdk==1.22.1` (requires Python `>=3.12`).
- Output artifact (committed to this folder): `spike-openhands-sdk-shape.md`.

## Overview

- **Priority:** Gating — blocks phases 03-09. Abort or redesign provider module layout if shape diverges.
- **Current status:** Pending.
- **Brief:** Round-trip a single message through `openhands-sdk==1.22.1` locally to confirm the assumed `LLM + Agent + Conversation + Tool[]` API shape used throughout spec §2.6 / §6.3 / §6.4. If divergent, update the spec before any further provider code lands.

## Key Insights

- Spec assumes a 4-method contract (`init` / `turn` / `finalize` / `shutdown`) maps cleanly onto OpenHands SDK primitives. This must be verified before §1.2 dataclasses or §2.6 adapter pseudocode are taken as final.
- `extras = []` in `config/sdk-pins.toml` — if the spike discovers an extras group is required (e.g. `[tools]`), record it in the artifact AND fix every `uv run --with openhands-sdk==...` callsite in the spec (§2.6, §6.3, §6.3) so single-source-of-truth holds.
- The spike is throwaway code. Do NOT add it to runtime paths.

## Requirements

### Functional

1. Spawn a Python ≥3.12 process via `uv run --with openhands-sdk==1.22.1`.
2. Import the SDK, construct an `LLM`, an `Agent` (with at least one tool from the SDK's registry), and a `Conversation` (or whatever the SDK uses as the session container).
3. Send a single user message; capture the response text, tool-call events, and any error fields.
4. Map the captured shape onto the spec §1.2 dataclasses (`ProviderConfig` / `Session` / `TurnResult` / `FinalResult`). Note every divergence.

### Non-functional

- Runs against a real Anthropic key from local `.env` (never commit the key).
- Total spike runtime ≤ 60 s warm.
- Produces a markdown verdict + raw JSON event dump for review.

## Architecture

```text
spikes/openhands-sdk-shape/
├── probe.py               # uv script — calls openhands.sdk; prints JSON
├── README.md              # how to run locally
└── (output → ../plans/.../spike-openhands-sdk-shape.md)
```

`probe.py` is a single throwaway file invoked as:

```bash
uv run --python 3.12 --with openhands-sdk==1.22.1 python spikes/openhands-sdk-shape/probe.py \
  --message "Hello, list files in current dir" \
  > /tmp/openhands-probe.json
```

## Related Code Files

- **Create:** `spikes/openhands-sdk-shape/probe.py`, `spikes/openhands-sdk-shape/README.md`, `plans/260522-1649-harness-plugin-contract-design/spike-openhands-sdk-shape.md`.
- **Modify:** none. (Spec edits, if needed, happen as a follow-up commit.)
- **Delete:** none. (Spike code stays in the repo as historical reference; tag it as throwaway in README.)

## Implementation Steps

1. Confirm Python ≥3.12 + `uv` on PATH (`uv --version`, `python3 --version`).
2. Read OpenHands SDK 1.22.1 surface from PyPI (`uv run --python 3.12 --with openhands-sdk==1.22.1 python -c "import openhands.sdk; print(dir(openhands.sdk))"`).
3. Write `spikes/openhands-sdk-shape/probe.py`:
   - Builds `LLM`, `Agent`, `Tool`/`Tool[]`, `Conversation` from the SDK.
   - Sends one user message; collects the assistant reply and event stream.
   - Serializes the result as JSON: `{ session_class, turn_result_shape, tool_call_events, raw_events_truncated, errors }`.
4. Run the probe with a live Anthropic key from local `.env`. Confirm exit 0 and JSON output.
5. Compare the captured shape against spec §1.2 dataclasses + §2.6 pseudo-code. For each discrepancy, write a row in the verdict artifact:
   - `<spec section>` → `<assumed shape>` → `<actual shape>` → `<spec edit needed? Y/N>`.
6. Author `plans/260522-1649-harness-plugin-contract-design/spike-openhands-sdk-shape.md`:
   - Verdict at the top: **PASS** / **PASS WITH SPEC EDITS** / **FAIL — REDESIGN**.
   - Discrepancy table (step 5).
   - Raw JSON dump (truncated to 200 lines).
   - Recommended spec edits with section numbers.
7. If verdict is **PASS** or **PASS WITH SPEC EDITS**, commit (`feat(vd-2174-1): land OpenHands SDK shape spike + verdict`). Apply any required spec edits in a follow-up commit on the same branch.
8. If verdict is **FAIL — REDESIGN**, stop. Surface findings to the user; do NOT begin phase 03.

## Todo List

- [ ] Step 1: Confirm Python + uv preflight.
- [ ] Step 2: Capture SDK surface listing.
- [ ] Step 3: Implement `probe.py`.
- [ ] Step 4: Run probe with live key; capture JSON output.
- [ ] Step 5: Build discrepancy table.
- [ ] Step 6: Author `spike-openhands-sdk-shape.md` verdict.
- [ ] Step 7: Commit spike + verdict.
- [ ] Step 8: Spec edits (only if PASS WITH SPEC EDITS); else escalate.

## Success Criteria

- Verdict file committed at `plans/260522-1649-harness-plugin-contract-design/spike-openhands-sdk-shape.md`.
- Verdict is **PASS** or **PASS WITH SPEC EDITS**. A **PARTIAL** verdict (offline / mock-only) does NOT unblock phase 03+ — implementation phases require a live-key PASS first. **FAIL** halts the project.
- Discrepancy table is complete — every spec assumption from §1.2 + §2.6 has a row.
- If extras are needed, `config/sdk-pins.toml` plan-phase notes capture it for phase 03.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| SDK surface fundamentally different (no Conversation primitive, etc.) | M | H | Verdict = FAIL — REDESIGN; stop and rewrite §1 + §2.6 before phase 03. |
| `openhands-sdk==1.22.1` requires extras to expose tools | M | M | Record extras in verdict; phase 03 picks up the fix in sdk-pins. |
| Local Anthropic key missing or quota'd | L | M | Document fallback (mock) in spike README; verdict may be PARTIAL but PARTIAL does NOT unblock phase 03+. The author MUST acquire a working key or escalate to user before downstream phases can start. |

## Security Considerations

- `ANTHROPIC_API_KEY` read from local `.env` only; never committed.
- Probe redacts the key from any output it writes (use `***REDACTED***`).
- The JSON dump excludes raw HTTP request bodies; only the SDK-facing shape is captured.

## Next Steps

- On PASS: phase 03 unblocks (along with phase 02). Hand off discrepancy table to phase 03 owner.
- On PASS WITH SPEC EDITS: apply spec edits in a follow-up commit (do not amend the spike commit).
- On FAIL: halt; route to brainstorming for redesign before continuing.
