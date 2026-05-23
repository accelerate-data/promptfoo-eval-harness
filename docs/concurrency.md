# Concurrency Model

The eval harness uses two independent concurrency knobs. They serve different
purposes and operate at different layers of the stack.

## INNER gate — `AD_EVALS_MAX_CONCURRENCY` (default: 4)

Controls how many `callApi` invocations can run concurrently inside the Node
bridge (`scripts/framework/_node_bridge.js`). This is a process-local
semaphore implemented with `p-limit`.

- **Default:** `4` (matches Promptfoo's own `--max-concurrency` default per
  spec §4.1).
- **Scope:** Every `callApi`, regardless of `provider_kind` — both
  `opencode_cli` (in-process) and `openhands_sdk` (subprocess) go through
  this gate.
- **Why bridge-side clamping coexists with Promptfoo's concurrency knob:**
  Promptfoo's `--max-concurrency` is an upper bound that controls how many
  cases Promptfoo *schedules*. The bridge's inner gate is a lower bound
  (additional restriction) that limits how many actually *execute* at once
  inside the bridge process. Setting `AD_EVALS_MAX_CONCURRENCY` smaller than
  Promptfoo's `--max-concurrency` is safe and useful for rate-limiting SDK
  subprocess spawns. Setting it larger than Promptfoo's value has no effect
  (Promptfoo will not schedule more than its own cap).
- **Set via:** `AD_EVALS_MAX_CONCURRENCY=<positive integer>` in the
  environment.

## OUTER gate — `AD_EVALS_OUTER_CONCURRENCY` (default: `os.cpus().length`)

Controls subprocess spawn parallelism for multi-process operations such as
the phase 08 cross-repo `dir-walk` that fans out to multiple `ad-evals`
processes.

- **Default:** `os.cpus().length` (one concurrent subprocess per CPU).
- **Scope:** Phase 08 `dir-walk.js` uses this gate to cap how many child
  `ad-evals` processes run in parallel across repos/packages. It is also
  available in the bridge for explicit subprocess-fan-out use cases in future
  phases.
- **Set via:** `AD_EVALS_OUTER_CONCURRENCY=<positive integer>` in the
  environment.

## Summary

| Knob | Env var | Default | Controls |
| ---- | ------- | ------- | -------- |
| INNER | `AD_EVALS_MAX_CONCURRENCY` | `4` | Concurrent `callApi` invocations inside the bridge |
| OUTER | `AD_EVALS_OUTER_CONCURRENCY` | `os.cpus().length` | Concurrent subprocess spawns in dir-walk / multi-process fan-out |

## Spec reference

See spec §4.1–4.3 (`plans/260522-1649-harness-plugin-contract-design/spec.md`)
for the canonical semantics. Phase 1 ships only the INNER gate wired to the
bridge. Phase 08 wires the OUTER gate to `dir-walk.js`. Per-provider caps
(`openhands_sdk = 2 max`, etc.) are deferred to Phase 4 (spec §4.2).
