# Phase 03 — Foundation + IPC (A.1-A.7)

> **Sub-issue:** VD-2174-2. **Status:** pending. **Blocked by:** phase 01 AND phase 02 (both verdicts PASS).
> Time budget: ~1 week.

## Context Links

- Spec: [`spec.md`](spec.md) §1 (contract types), §2 (subprocess + IPC), §2.5 (cold-spawn benchmark), §4.2 (concurrency clamping), §6.3 (Python packaging), §6.4 (`sdk-pins.toml`), §8.2 (Layer 1/2 tests), §9.2 Steps A.1-A.7, §A.1 (file inventory).
- Phase 01 verdict (must be PASS): `spike-openhands-sdk-shape.md`.
- Phase 02 verdict (must be PASS): `spike-promptfoo-file-shape.md`.

## Overview

- **Priority:** Foundation — every later phase imports from these modules.
- **Current status:** Pending.
- **Brief:** Establish the Python toolchain (`pyproject.toml` + `uv.lock`), pin SDK versions (`config/sdk-pins.toml` with `env_allowlist`), write the hand-maintained provider contract in **both** Python and TypeScript, build the Node bridge (`_node_bridge.js`) with semaphore + IPC, build the Python adapter (`_python_adapter.py`) NDJSON loop, ship Layer 1 + Layer 2 IPC contract tests, and prove cold-spawn cost (`bench/spawn-cost.js`) within the §2.5 budget.

## Key Insights

- The bridge is the **only** Promptfoo provider face (spec §2.2). All `provider_kind` values dispatch through it; `opencode_cli` is in-process, SDK kinds spawn subprocesses.
- IPC is NDJSON over stdio — one JSON object per line (spec §2.3).
- Every return path (success, validation error, subprocess crash) MUST go through `baseMetadata()` so canonical fields (§1.5) appear. The transcript invariant from §3.2.1 is `transcript.length === number of attempted turns`; failed turns carry an `error` field.
- `bench/spawn-cost.js` is required gating — phase 03 cannot sign off if Python cold spawn exceeds ~800 ms warm.
- `bench/parallel-throughput/` is optional (manual fan-out probe; lives in phase 03 only because the folder is required by §A.1 — no nightly CI usage).

## Requirements

### Functional

1. **Python toolchain (A.1):** `pyproject.toml`, `uv.lock`, CI step to install via `uv sync`. Python `>=3.12,<3.14`.
2. **SDK pins (A.2):** `config/sdk-pins.toml` with `openhands_sdk` block (`version`, `python`, `extras`, `env_allowlist`) and `opencode_cli` block (`min_version`, `env_allowlist`).
3. **Contract types (A.3):** `scripts/framework/providers/_contract.py` and `scripts/framework/providers/_contract.ts` mirror the spec §1.2 dataclasses; kept in sync via `docs/provider-contract.md` parity table.
4. **Python adapter (A.4):** `scripts/framework/providers/_python_adapter.py` runs an NDJSON loop (`init` / `turn` / `finalize` / `shutdown`) on stdin/stdout. Loads provider modules via `importlib` from `scripts/framework/providers/<kind>/provider.py`.
5. **Node bridge (A.5):** `scripts/framework/_node_bridge.js` implements `HarnessBridgeProvider` with `id()`, `label()`, `callApi(prompt, context, options)`. Dispatches via `KIND_REGISTRY` (in-process for `opencode_cli`; subprocess + NDJSON for SDK kinds). Wraps every call in the global `p-limit` semaphore from `concurrency.js`. Every return path uses `baseMetadata()` helper.
6. **Concurrency primitive (A.5 supporting):** `scripts/framework/concurrency.js` exports a global `p-limit` semaphore sized by `AD_EVALS_MAX_CONCURRENCY` (default 4).
7. **Layer 1 + 2 tests (A.6):**
   - `scripts/framework/providers/_python_adapter.test.py` — feeds NDJSON requests through the adapter using a `tests/_mock_provider` stub; asserts request/response invariants.
   - `scripts/framework/_node_bridge.test.js` — boots the bridge with a stub registry, walks happy path + every failure mode in §2.4.
   - `scripts/framework/providers/_contract.test.js` (TS-side parity check) — imports the TypeScript contract types and asserts the shape matches the Python dataclass field list.
8. **Cold-spawn benchmark (A.7):** `bench/spawn-cost.js` measures cold + warm Python spawn cost across 10 runs. Fails the build if cold spawn ≥ 800 ms warm or per-turn round-trip ≥ 200 ms warm.
9. **Parallel throughput harness (folder):** `bench/parallel-throughput/` with `config.json` + `driver.js` skeleton — invoked manually only, not in CI.

### Non-functional

- All new Python passes `ruff check` + `ruff format`.
- 70 % Python coverage minimum (spec §8.5).
- Markdown lint MD013 at 120-char.
- No live API key needed for Layer 1/2 — mock SDK only.

## Architecture

```text
scripts/framework/
├── _node_bridge.js                    # ONE provider URL — dispatches via KIND_REGISTRY
├── _node_bridge.test.js               # L1 — happy path + §2.4 failure modes
├── concurrency.js                     # p-limit semaphore singleton
├── concurrency.test.js                # L1
└── providers/
    ├── _contract.py                   # §1.2 dataclasses
    ├── _contract.ts                   # mirror for Node/TS SDKs
    ├── _python_adapter.py             # NDJSON loop, importlib dispatch
    ├── _python_adapter.test.py        # L1 — mock provider stub
    └── _contract.test.js              # parity check
config/
└── sdk-pins.toml                      # version + env_allowlist per kind
docs/
└── provider-contract.md               # parity table — manual sync
pyproject.toml
uv.lock
bench/
├── spawn-cost.js                      # A.7 — gating; fails build if over budget
└── parallel-throughput/
    ├── config.json
    └── driver.js
```

Dispatch flow:

```text
Promptfoo case
  → file://scripts/framework/_node_bridge.js (single URL)
    → HarnessBridgeProvider.callApi(prompt, context, options)
       → semaphore(() => _dispatch(prompt, context, cfg))
         ├── opencode_cli  → require('./opencode-cli-provider.js').callApi(...)
         └── SDK kinds     → spawn(uv ... _python_adapter.py <kind>)
                              ↳ NDJSON: init → turn[] → finalize → shutdown
```

## Related Code Files

- **Create:**
  - `pyproject.toml`, `uv.lock`
  - `config/sdk-pins.toml`
  - `scripts/framework/providers/_contract.py`
  - `scripts/framework/providers/_contract.ts`
  - `scripts/framework/providers/_python_adapter.py`
  - `scripts/framework/providers/_python_adapter.test.py`
  - `scripts/framework/providers/_contract.test.js`
  - `scripts/framework/_node_bridge.js`
  - `scripts/framework/_node_bridge.test.js`
  - `scripts/framework/concurrency.js`
  - `scripts/framework/concurrency.test.js`
  - `docs/provider-contract.md`
  - `bench/spawn-cost.js`
  - `bench/parallel-throughput/config.json`
  - `bench/parallel-throughput/driver.js`
- **Modify:**
  - `package.json` — add `p-limit` runtime dep; add `eval:bench:spawn-cost` script.
  - `.github/workflows/test.yml` (or whichever runs `npm test`) — add `uv sync` step + Python 3.12/3.13 matrix per spec §8.6.
- **Delete:** none.

## Implementation Steps

> Each step ends with a TDD-style commit. Conventional commits, no AI references. Reference `spec.md` section numbers in commit bodies.

### A.1 — Python toolchain (`pyproject.toml` + `uv.lock`)

1. Create `pyproject.toml` declaring `requires-python = ">=3.12,<3.14"`, `[project.optional-dependencies] dev = ["pytest", "ruff", "pytest-cov"]`.
2. Run `uv lock --python 3.12` → commits `uv.lock`.
3. Wire CI: in `.github/workflows/*.yml`, add an `actions/setup-python@v5` step (matrix `['3.12', '3.13']` per §8.6) and `uv sync --frozen` ahead of test runs.
4. Commit: `chore(vd-2174-2): add uv-managed Python toolchain (A.1)`.

### A.2 — SDK pins (`config/sdk-pins.toml`)

5. Author `config/sdk-pins.toml` with the schema from spec §6.4 (both `openhands_sdk` and `opencode_cli` sections). `extras = []` unless phase 01 verdict says otherwise.
6. Write `scripts/framework/sdk-pins.js` reader (existing harness pattern — TOML → JS object) + Layer 1 test asserting required keys.
7. Commit: `feat(vd-2174-2): pin openhands-sdk 1.22.1 + opencode_cli min version (A.2)`.

### A.3 — Provider contract types (Python + TypeScript)

8. Author `scripts/framework/providers/_contract.py` — the §1.2 dataclasses + `Protocol` definitions (`ProviderConfig`, `Session`, `ToolCallRecord`, `ProviderError`, `TurnResult`, `FinalResult`, `SDKProvider`).
9. Author `scripts/framework/providers/_contract.ts` — TS mirror (`interface ProviderConfig { ... }`, `interface SDKProvider { ... }`).
10. Author `docs/provider-contract.md` — parity table (Python dataclass field ↔ TS interface field, types side-by-side).
11. Author `scripts/framework/providers/_contract.test.js` — imports the TS contract via the JS build (or reads file source if no compile step) and asserts every field listed in `docs/provider-contract.md` exists in both files.
12. Commit: `feat(vd-2174-2): hand-write provider contract in Python + TypeScript (A.3)`.

### A.4 — Python adapter NDJSON loop

13. Author `scripts/framework/providers/_python_adapter.py`:
    - Reads `sys.argv[1]` for `provider_kind`.
    - `importlib.import_module(f"scripts.framework.providers.{kind}.provider").create()`.
    - Loops over `sys.stdin`; each line is a JSON object; dispatches `init` / `turn` / `finalize` / `shutdown` per §2.6 pseudo-code.
    - Emits `{"type": "<ok|err>", ...}` to stdout (single line per response).
    - `try/except` around the loop emits `{"type": "error", "error": <ProviderError>}` and `sys.exit(1)`.
    - `finally` shuts down the session idempotently.
14. Build `tests/_mock_provider/provider.py` — implements `SDKProvider` returning canned results (`turn` records call sequence, `finalize` returns sum, `shutdown` flags closure).
15. Author `scripts/framework/providers/_python_adapter.test.py`:
    - Spawns the adapter via `subprocess.Popen`.
    - Feeds NDJSON for `init` → `turn` ×3 → `finalize` → `shutdown`.
    - Asserts each response shape per §2.3.
    - Asserts behavior under §2.4 failure modes (malformed JSON, missing INIT, mid-turn exception).
16. Commit: `feat(vd-2174-2): land Python NDJSON adapter + mock-provider tests (A.4)`.

### A.5 — Node bridge + concurrency

17. Author `scripts/framework/concurrency.js`:
    - Exports `global` = `pLimit(parseInt(process.env.AD_EVALS_MAX_CONCURRENCY, 10) || 4)`.
    - Lazy-initialized so tests can override via env.
18. Author `scripts/framework/concurrency.test.js` — verifies the limit honors `AD_EVALS_MAX_CONCURRENCY=1` (serial), `=4` (default).
19. Author `scripts/framework/_node_bridge.js`:
    - Implements `HarnessBridgeProvider` per §2.6 pseudo-code.
    - `baseMetadata(cfg, extra)` helper wires `provider_kind`, `provider_label`, `model`, `sdk_version`, `adapter_version`, `run_id`, `case_id` per §1.5.
    - `KIND_REGISTRY` = `{ opencode_cli: { mode: 'inproc', module: './opencode-cli-provider.js' }, openhands_sdk: { mode: 'subprocess', spawn: [...uv args...] } }`.
    - For `opencode_cli`, run `vars.turns`/`prompt` precedence check per §2.6 (reject empty turns AND `[undefined]` fallback; reject `length > 1` with validation error; push transcript entries per attempted turn).
    - For SDK kinds, spawn the adapter with `uv run --python 3.12 --with openhands-sdk==1.22.1 python -m scripts.framework.providers._python_adapter <kind>`; pump NDJSON; track `attemptedIndex`/`attemptedInput`/`attemptedStart` per §2.6 so mid-turn exceptions still push a transcript entry.
    - Wrap the dispatch in `concurrency.global(() => ...)`.
20. Author `scripts/framework/_node_bridge.test.js` — exercise:
    - `opencode_cli` happy path (require'd stub provider).
    - `opencode_cli` `vars.turns: []` → validation error, transcript empty.
    - `opencode_cli` `vars.turns: [undefined]` → validation error, transcript empty.
    - `opencode_cli` `length > 1` → validation error, one transcript entry per attempted turn.
    - SDK kind happy path (mock adapter at `tests/_mock_provider`).
    - SDK kind §2.4 failure modes (malformed JSON, INIT_ERR, turn timeout, stderr overflow, SHUTDOWN hang, mid-turn exception).
    - `baseMetadata` present on every return path.
21. Commit: `feat(vd-2174-2): implement Node bridge with KIND_REGISTRY dispatch + IPC (A.5)`.

### A.6 — Layer 1 / Layer 2 finishing tests

22. Author `scripts/framework/providers/_python_adapter.workspace.test.py` — not required this phase; deferred to phase 07. Skip here.
23. Run `npm test` and `pytest` end-to-end — both green.
24. Update `docs/provider-contract.md` cross-link section so the parity table notes which test file enforces each row.
25. Commit: `test(vd-2174-2): wire L1/L2 test suites for bridge + adapter (A.6)`.

### A.7 — Cold-spawn benchmark (gating)

26. Author `bench/spawn-cost.js`:
    - Spawns the Python adapter 10 times with no SDK import; records p50/p95 cold-spawn ms.
    - Spawns the adapter 10 times **with** `--with openhands-sdk==1.22.1`; records p50/p95 warmed cost.
    - Runs a single-turn round-trip 10×; records p50/p95 turn round-trip ms.
    - Writes JSON summary to `bench/results/spawn-cost-<timestamp>.json`.
    - Exits 1 if warm cold-spawn p95 ≥ 800 ms OR turn round-trip p95 ≥ 200 ms (per §2.5) UNLESS `BENCH_OVERRIDE_REASON` is set in the environment — in that case, write the override reason into the JSON summary, log a warning to stderr, and exit 0. The override exists so a developer on a slow machine can ship a commit while still recording the breach; CI never sets this env var.
27. Author `bench/parallel-throughput/{config.json, driver.js}` — skeleton only; documented as manual.
28. Add npm script: `"eval:bench:spawn-cost": "node bench/spawn-cost.js"`.
29. Run locally; commit numbers in `bench/results/spawn-cost-<commit-sha>.json`.
30. Document `BENCH_OVERRIDE_REASON` in `docs/setup.md` (under a "Bench gate override" subsection) — explain that it bypasses the gate, requires a free-text reason, and that PRs touching latency-sensitive paths must NOT use it.
31. Commit: `feat(vd-2174-2): land cold-spawn benchmark with documented override (A.7)`.

## Todo List

- [ ] A.1: pyproject.toml + uv.lock + CI Python matrix.
- [ ] A.2: config/sdk-pins.toml + reader + tests.
- [ ] A.3: _contract.py + _contract.ts + provider-contract.md.
- [ ] A.4: _python_adapter.py NDJSON loop + mock-provider tests.
- [ ] A.5: _node_bridge.js KIND_REGISTRY + concurrency.js + happy + §2.4 failure tests.
- [ ] A.6: L1/L2 suites green end-to-end.
- [ ] A.7: bench/spawn-cost.js gating check passes; bench/parallel-throughput/ skeleton.
- [ ] Confirm `npm test`, `npm run lint:md`, `pytest`, `ruff check`, `ruff format` all green.

## Success Criteria

- All A.1-A.7 commits land on `feature/vd-2174-multi-sdk-plugin-contract`.
- `npm test` passes (existing harness contract tests + new bridge + adapter tests).
- `pytest scripts/framework/providers/` passes with ≥ 70 % coverage on adapter + contract modules.
- `node bench/spawn-cost.js` exits 0 with warm p95 < 800 ms cold spawn AND < 200 ms turn round-trip; `BENCH_OVERRIDE_REASON` documented in `docs/setup.md` as an escape valve (CI never sets it).
- `docs/provider-contract.md` parity table covers every spec §1.2 field.
- No new direct dependencies beyond `p-limit` (Node) and the dev tooling already in pyproject.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Cold spawn exceeds 800 ms warm | M | M | A.7 gating triggers; pre-warm pool option deferred per §2.5; if persistent, halt and brainstorm. |
| Python/TS contract drift | M | M | `docs/provider-contract.md` parity table + `_contract.test.js` enforce sync. |
| `p-limit` semaphore not honored by all return paths | L | H | Tests A.6 cover every §2.6 branch; lint rule (manual) — every `await` in `_node_bridge.js` is inside `semaphore(...)`. |
| §2.4 failure modes leak file paths or secrets in error messages | M | M | Reuse §7.1 redactor (built in phase 07); for phase 03, raw error message goes through a placeholder redactor that returns `<redacted-pending-phase-07>` for unknown patterns. |
| uv cache cold on developer laptop | H | L | Document `ad-evals doctor --install-providers` (built in phase 08); README note covers this until then. |

## Security Considerations

- Adapter env passthrough is **deny-by-default**; only keys in `env_allowlist` for the matching `provider_kind` are forwarded to the subprocess (see §7.1).
- `ProviderError.message` is sanitized before crossing the IPC boundary (placeholder redactor in this phase; full broadened patterns land in phase 07).
- Subprocess stderr is captured to a buffer, truncated to 64 KB, and tail-only included in `sdk_error` returns (per §2.4).
- `bench/spawn-cost.js` runs WITHOUT live keys — never exposes secrets.

## Next Steps

- Unblocks phase 04 (dispatch + tier schema) and phase 06 (OpenHands SDK provider) and phase 07 (cross-cutting).
- Phase 05 (OpenCode CLI lock) waits on phase 04.
