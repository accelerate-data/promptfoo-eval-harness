# Phase 08 — Scenarios + CLI Directory Walk + Migration (F.25-F.27 + G.28-G.32)

> **Sub-issue:** VD-2174-7. **Status:** pending. **Blocked by:** phase 05, phase 06, phase 07.
> Time budget: ~1 week.

## Context Links

- Spec: [`spec.md`](spec.md) §5.1-5.3 (scenarios + parallelism), §5.4 (CLI `ad-evals run <dir>`), §6.6 (migration v0 → v1), §8.4 (nightly CI), §9.2 Steps F.25-F.27 + G.28-G.32.
- Predecessor phases: 05 (`opencode-cli-compatibility` already written), 06 (OpenHands SDK provider available), 07 (redactor + logger + workspace guard usable).

## Overview

- **Priority:** End-to-end usability + migration story. After this phase, `ad-evals run <dir>` is the canonical entry point and v0 configs are auto-migrated.
- **Current status:** Pending.
- **Brief:** Add scenario harness config + remaining two scenarios + nightly workflow (F.25-F.27); add `ad-evals run <dir>`, `migrate-from-v0` command, MIGRATION doc, init wiring, `doctor --install-providers` (G.28-G.32).

## Key Insights

- Scenarios live under `tests/harness-scenarios/packages/<name>/` per spec §5.1; the dir-walk entry point is `tests/harness-scenarios/packages` (spec §5.3 example npm script).
- Scenarios are the user-facing demo: minimal-smoke MUST work on a fresh laptop with `npx ad-evals run tests/harness-scenarios/packages/minimal-smoke` in under 90 s.
- `ad-evals run <dir>` walks subdirectories with `promptfooconfig.json` files; this is how parallel multi-scenario fan-out is exposed. Each scenario becomes its own Promptfoo child process.
- Because each scenario spawns a separate Promptfoo process (and therefore its own bridge / in-process semaphore), an OUTER `p-limit` must cap how many scenario subprocesses run concurrently — otherwise `AD_EVALS_MAX_CONCURRENCY` is silently violated (spec §4.2 demands a process-local limiter; with multi-process fan-out, the limiter must live in the dir-walk parent, not in each child bridge).
- Migration is a flag on `eval-harness-init` — `eval-harness-init --upgrade --migrate-from-v0` — that rewrites the consumer's `config/eval-tiers.toml` in place, prints a diff, and is additive only (spec §6.6). There is NO separate `ad-evals migrate-from-v0` subcommand and NO `<orig>.v1.json` shadow file.
- `doctor --install-providers` pre-warms the EXACT runtime command the bridge uses: `uv run --python 3.12 --with openhands-sdk==1.22.1 python -c "import openhands.sdk"` (spec §6.3). `uv tool install` populates a different cache and would not warm the runtime path.

## Requirements

### Functional

#### F — Scenarios + nightly

1. **F.25 — Scenario harness config:** Centralized `tests/harness-scenarios/packages/index.json` lists every scenario with metadata: `name`, `path` (relative to repo root, e.g. `tests/harness-scenarios/packages/minimal-smoke`), `provider_kinds`, `requires_live_key` (bool), `expected_runtime_seconds`.
2. **F.26 — Three scenarios (all under `tests/harness-scenarios/packages/`):**
   - `minimal-smoke` (NEW) — 1 turn, opencode_cli, deterministic mock binary. Smoke test.
   - `opencode-cli-compatibility` (already exists from phase 05) — included by reference.
   - `openhands-mock-multi-turn` (NEW) — 3 turns, openhands_sdk, mock SDK.
3. **F.27 — Nightly workflow:** `.github/workflows/nightly-scenarios.yml` runs all scenarios with `requires_live_key=false` on a cron schedule; uploads `bench/results/` artifacts.

#### G — CLI dir walk + migration + doctor

4. **G.28 — `ad-evals run <dir>` (with outer concurrency cap):** `bin/ad-evals.js` accepts a directory argument; walks subdirectories of `<dir>` for any `promptfooconfig.json`; resolves + validates each; runs them as separate Promptfoo child processes. Because each child spawns its own bridge (and its own process-local `concurrency.global` semaphore), `scripts/framework/dir-walk.js` MUST wrap the per-scenario invocations in an OUTER `p-limit` sized by `AD_EVALS_MAX_CONCURRENCY` (default 4). Document the layering: `outer (dir-walk) caps Promptfoo children` × `inner (bridge) caps per-child case concurrency`; pick `outer × inner ≈ total subprocess pressure`.
5. **G.29 — Migration via init flag (NOT a separate subcommand):** Implement `eval-harness-init --upgrade --migrate-from-v0` per spec §6.6. The flag triggers an additive, in-place rewrite of the consumer's `config/eval-tiers.toml` (v0 → v1 with `provider_kind: opencode_cli` injected), prints a diff to stdout, and is idempotent (re-running on already-v1 config is a no-op + warn). There is NO `bin/ad-evals.js migrate-from-v0` subcommand and NO `<orig>.v1.json` shadow file.
6. **G.30 — MIGRATION doc:** `docs/migration-v0-to-v1.md` — step-by-step for consumer repos, anchored on `eval-harness-init --upgrade --migrate-from-v0`.
7. **G.31 — init wiring (new layout):** `bin/eval-harness-init.sh` scaffolds the new directory layout (`tests/harness-scenarios/packages/`, `config/sdk-pins.toml` symlink-or-copy, `tests/evals/.tmp/workspaces/` git-ignored).
8. **G.32 — `doctor --install-providers`:** Add `--install-providers` flag to `ad-evals doctor`. The flag pre-warms the EXACT runtime path the bridge will use — `uv run --python 3.12 --with openhands-sdk==1.22.1 python -c "import openhands.sdk"` (spec §6.3) — and any future SDK pin from `config/sdk-pins.toml`. Honors `AD_EVALS_OFFLINE=1` by skipping the network fetch and asserting an existing uv cache hit instead. Does NOT use `uv tool install`.

### Non-functional

- `minimal-smoke` runs in under 90 s on a fresh laptop with no live key.
- Nightly workflow runs in under 15 min total.
- Migration command is idempotent (re-running on already-v1 config is a no-op).

## Architecture

```text
bin/
├── ad-evals.js
│   ├── command: smoke
│   ├── command: regression
│   ├── command: run <dir-or-config>            # NEW dir-walk semantics (G.28)
│   ├── command: doctor [--install-providers]   # ENHANCED (G.32)
│   └── command: view, test, raw passthrough    # unchanged
├── eval-harness-init.sh                        # UPDATED — adds --upgrade --migrate-from-v0 flag (G.29 + G.31)
└── promptfoo.sh                                # unchanged

tests/harness-scenarios/packages/
├── index.json                                  # NEW registry (F.25)
├── minimal-smoke/                              # NEW (F.26)
│   ├── promptfooconfig.json
│   ├── prompts/
│   ├── tests/test.csv
│   └── README.md
├── opencode-cli-compatibility/                 # from phase 05
└── openhands-mock-multi-turn/                  # NEW (F.26)
    ├── promptfooconfig.json
    ├── prompts/
    ├── tests/test.csv
    └── README.md

scripts/framework/
└── dir-walk.js                                 # NEW — outer p-limit + scenario fan-out (G.28)

.github/workflows/
└── nightly-scenarios.yml                       # NEW (F.27)

docs/
└── migration-v0-to-v1.md                       # NEW (G.30)
```

## Related Code Files

- **Create:**
  - `tests/harness-scenarios/packages/index.json`
  - `tests/harness-scenarios/packages/minimal-smoke/*` (config + prompts + tests + README)
  - `tests/harness-scenarios/packages/openhands-mock-multi-turn/*` (config + prompts + tests + README)
  - `.github/workflows/nightly-scenarios.yml`
  - `docs/migration-v0-to-v1.md`
  - `scripts/framework/migrate-from-v0.js` (+ test) — invoked by `eval-harness-init` when `--migrate-from-v0` is set; NOT exposed as a CLI subcommand.
  - `scripts/framework/dir-walk.js` (+ test) — owns the OUTER `p-limit` for scenario fan-out.
- **Modify:**
  - `bin/ad-evals.js` (commands: `run`, `doctor --install-providers`)
  - `bin/eval-harness-init.sh` (new `--upgrade` + `--migrate-from-v0` flags; layout scaffolding)
  - `scripts/framework/doctor.js` (or wherever doctor logic lives)
- **Delete:** none.

## Implementation Steps

### F.25 — Scenario index

1. Author `tests/harness-scenarios/packages/index.json` listing the three scenarios with metadata (`path` rooted at `tests/harness-scenarios/packages/<name>`).
2. Author `tests/harness-scenarios/README.md` documenting the contract (every scenario under `packages/<name>/` with `promptfooconfig.json` required, optional `README.md`).
3. Commit: `feat(vd-2174-7): scenario registry + harness-scenarios contract (F.25)`.

### F.26 — Minimal-smoke + openhands-mock-multi-turn scenarios

4. Author `tests/harness-scenarios/packages/minimal-smoke/`:
   - `promptfooconfig.json`: 1 tier (v1), 1 model alias, 1 case with `vars.prompt: "Say 'pong'."`.
   - `tests/test.csv` with the single case.
   - `prompts/single-turn.txt` containing `{{prompt}}`.
   - `README.md` documenting how to run it.
5. Author `tests/harness-scenarios/packages/openhands-mock-multi-turn/`:
   - `promptfooconfig.json`: 1 tier (v1, `provider_kind: openhands_sdk`), 1 model, 1 case with `vars.turns` of 3 strings.
   - Mock SDK via `PYTHONPATH=tests/_mock_openhands_sdk` injected by the scenario's `defaultTest.providerOverrides` or env var.
   - `tests/test.csv`, `prompts/`, `README.md`.
6. Run both scenarios locally:
   - `node bin/ad-evals.js run tests/harness-scenarios/packages/minimal-smoke` — exit 0.
   - `node bin/ad-evals.js run tests/harness-scenarios/packages/openhands-mock-multi-turn` — exit 0, transcript length 3 per case.
7. Commit: `feat(vd-2174-7): land minimal-smoke + openhands-mock-multi-turn scenarios (F.26)`.

### F.27 — Nightly workflow

8. Author `.github/workflows/nightly-scenarios.yml`:
   - Trigger: `schedule: cron 0 6 * * *` + manual `workflow_dispatch`.
   - Matrix: `[ubuntu-latest]` × Python `[3.12, 3.13]`.
   - Steps: checkout → uv setup → `npm ci` → run every scenario with `requires_live_key=false` → upload `bench/results/` and Promptfoo artifacts.
9. Validate YAML locally with `yamllint` or `actionlint`.
10. Commit: `ci(vd-2174-7): nightly scenarios workflow + artifact upload (F.27)`.

### G.28 — `ad-evals run <dir>` with OUTER p-limit

11. Author `scripts/framework/dir-walk.js`:
    - `walkScenarios(dir)` yields each subdirectory containing `promptfooconfig.json`.
    - `runScenarios(dir, { concurrency })` wraps the per-scenario Promptfoo spawns in `p-limit(concurrency)` where `concurrency = Number(process.env.AD_EVALS_MAX_CONCURRENCY ?? 4)`.
    - Spawn each child as a separate Node subprocess (one bridge per scenario).
    - Aggregate exit codes (non-zero if ANY child fails); emit a per-scenario PASS/FAIL summary on stdout.
    - Document in source comments: "outer p-limit caps Promptfoo children; inner bridge p-limit caps per-child cases. Total subprocess pressure ≈ outer × inner. Pick outer = ceil(N / max_per_run)."
    - Layer 1 test against a tmp directory fixture with 3 stub `promptfooconfig.json` files; assert no more than `AD_EVALS_MAX_CONCURRENCY` children run simultaneously.
12. Extend `bin/ad-evals.js run`:
    - If arg is a file → existing path (run that config).
    - If arg is a directory → delegate to `dir-walk.runScenarios`; aggregate exit codes; emit summary.
13. Layer 2 test via `tests/harness-scenarios/packages/` itself (run all 3 scenarios in parallel, assert outer cap honored).
14. Commit: `feat(vd-2174-7): ad-evals run <dir> with outer p-limit fan-out (G.28)`.

### G.29 — Migration via `eval-harness-init --migrate-from-v0` flag

15. Author `scripts/framework/migrate-from-v0.js`:
    - Reads the consumer's existing `config/eval-tiers.toml` (or equivalent v0 path).
    - Produces v1 with `provider_kind: opencode_cli` injected and `model`/`agent` fields normalized.
    - In-place rewrite: writes to the SAME path (per spec §6.6 — additive, no shadow file).
    - Idempotent: if already v1, no-op + warn.
    - Computes a unified diff between the v0 input and v1 output for the CLI to print.
    - Returns a JSON report `{changed: bool, diff: string, warnings: string[]}` for downstream printing.
16. Author `scripts/framework/migrate-from-v0.test.js` with v0 fixture + asserted v1 output + idempotence assertion.
17. Wire `bin/eval-harness-init.sh` to invoke `migrate-from-v0.js` ONLY when both `--upgrade` and `--migrate-from-v0` flags are present:
    - Call via `node "$FRAMEWORK_ROOT/scripts/framework/migrate-from-v0.js" "$CONSUMER_TIERS_TOML"`.
    - Print the unified diff before applying changes.
    - DO NOT add a `migrate-from-v0` subcommand to `bin/ad-evals.js`.
18. Commit: `feat(vd-2174-7): eval-harness-init --upgrade --migrate-from-v0 in-place rewrite (G.29)`.

### G.30 — MIGRATION doc

19. Author `docs/migration-v0-to-v1.md`:
    - Preconditions (Node, Python ≥3.12, uv).
    - Steps anchored on `eval-harness-init --upgrade --migrate-from-v0`: install latest harness in consumer repo → run `npx eval-harness-init --upgrade --migrate-from-v0` → review printed diff → verify with `ad-evals run tests/harness-scenarios/packages/minimal-smoke` → commit.
    - Common gotchas (model alias, tool registry overrides, env_allowlist, idempotent re-runs).
20. Commit: `docs(vd-2174-7): migration guide v0 → v1 (G.30)`.

### G.31 — init wiring (new layout)

21. Update `bin/eval-harness-init.sh`:
    - Scaffold consumer repo with:
      - `tests/harness-scenarios/packages/` skeleton (with a placeholder `index.json` referencing zero scenarios + a comment that consumer scenarios are optional; framework-shipped scenarios live in this repo).
      - `tests/evals/.tmp/workspaces/` directory plus a `.gitignore` entry adding `tests/evals/.tmp/` to the consumer's repo `.gitignore`.
      - `config/sdk-pins.toml` reference (symlink-or-copy from framework template).
    - Add `--upgrade` flag (re-run scaffolding against an existing init'd repo without overwriting consumer files).
    - Add `--migrate-from-v0` flag (calls `migrate-from-v0.js`; requires `--upgrade`).
22. Run `bash -n bin/eval-harness-init.sh` (syntax check).
23. Run the script against a tmp consumer repo; verify scaffold layout includes `tests/harness-scenarios/packages/`, `tests/evals/.tmp/workspaces/` (gitignored), and `config/sdk-pins.toml`.
24. Commit: `feat(vd-2174-7): eval-harness-init scaffolds new layout + --upgrade flag (G.31)`.

### G.32 — `doctor --install-providers` (uv run --with pre-warm)

25. Locate the existing `doctor` implementation (likely `scripts/framework/doctor.js`).
26. Add `--install-providers` flag:
    - Reads pinned SDK versions from `config/sdk-pins.toml`.
    - For OpenHands SDK: pre-warm the EXACT runtime command the bridge will use — `uv run --python 3.12 --with openhands-sdk==<pin> python -c "import openhands.sdk"` — per spec §6.3. DO NOT use `uv tool install`.
    - Honor `AD_EVALS_OFFLINE=1`: skip the network fetch, instead assert the uv cache already contains the pinned wheel (lookup via `uv cache dir` + glob); fail with a clear error if missing.
    - Reports success/failure per SDK with the exact pinned version string.
    - Idempotent (subsequent runs hit the uv cache and return in < 1 s).
27. Author Layer 2 test that mocks `uv` on PATH and asserts the exact `uv run --python 3.12 --with openhands-sdk==<pin> python -c "import openhands.sdk"` command is issued; also asserts `AD_EVALS_OFFLINE=1` skips the network call and probes the cache.
28. Commit: `feat(vd-2174-7): doctor --install-providers uv-run pre-warm + offline mode (G.32)`.

## Todo List

- [ ] F.25: `tests/harness-scenarios/packages/index.json` + harness-scenarios README.
- [ ] F.26: minimal-smoke + openhands-mock-multi-turn (config + prompts + tests + README) under `tests/harness-scenarios/packages/`.
- [ ] F.27: nightly-scenarios.yml + actionlint.
- [ ] G.28: `scripts/framework/dir-walk.js` with OUTER `p-limit(AD_EVALS_MAX_CONCURRENCY)` + `ad-evals run <dir>` + parallel run summary.
- [ ] G.29: `scripts/framework/migrate-from-v0.js` invoked from `eval-harness-init --upgrade --migrate-from-v0` (in-place; no shadow file; no `ad-evals migrate-from-v0` subcommand).
- [ ] G.30: `docs/migration-v0-to-v1.md` anchored on the init flag.
- [ ] G.31: `eval-harness-init.sh` scaffolds `tests/harness-scenarios/packages/`, `tests/evals/.tmp/workspaces/` (git-ignored), and `config/sdk-pins.toml`.
- [ ] G.32: `doctor --install-providers` uses `uv run --python 3.12 --with openhands-sdk==<pin> python -c "import openhands.sdk"` (NOT `uv tool install`) + `AD_EVALS_OFFLINE` cache assertion.
- [ ] `npm test`, `pytest`, scenario runs, `bash -n bin/eval-harness-init.sh` all green.

## Success Criteria

- `node bin/ad-evals.js run tests/harness-scenarios/packages/minimal-smoke` exits 0 on a clean clone in < 90 s.
- `node bin/ad-evals.js run tests/harness-scenarios/packages` runs all 3 scenarios in parallel, capped at `AD_EVALS_MAX_CONCURRENCY` Promptfoo children, and aggregates results.
- `eval-harness-init --upgrade --migrate-from-v0` converts the legacy fixture from phase 04 into a working v1 `config/eval-tiers.toml` in place, prints a diff, and is idempotent on a second run.
- Nightly workflow passes on `main` for two consecutive nights.
- `ad-evals doctor --install-providers` succeeds on a fresh laptop with `uv` available and runs in < 1 s after first warm-up.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Nightly flakes due to uv cache cold start | M | M | Cache `~/.local/share/uv/` via `actions/cache@v4` keyed on `config/sdk-pins.toml` hash; `doctor --install-providers` warms the runtime path before scenarios. |
| Migration corrupts a non-trivial v0 config | M | H | Idempotent + diff printed before write + unit tests against multiple v0 fixtures; abort if v0 schema unrecognized. |
| Outer p-limit set too high → laptop OOM from N×inner subprocesses | M | M | Document the layering in source comments (`outer × inner ≈ total subprocess pressure`); default outer = 4; fail-fast log when outer > 8. |
| dir-walk concurrency overruns semaphore on huge dirs | L | M | OUTER `p-limit(AD_EVALS_MAX_CONCURRENCY)` in `dir-walk.js`; INNER bridge `p-limit` per child remains process-local per spec §4.2. |
| `doctor --install-providers` invokes uv with stale pin | L | M | Re-read `sdk-pins.toml` each invocation; print pinned version + uv cache path in output. |
| `AD_EVALS_OFFLINE=1` set in CI by mistake and cache missing | L | M | Doctor fails loudly with the missing-pin error + suggests dropping the env var. |

## Security Considerations

- Scenarios never contain live API keys. `requires_live_key=true` scenarios (not present in Phase 1) live behind a manual workflow trigger only.
- `migrate-from-v0` operates on TOML configs only — never executes them — so no secret-handling risk; idempotent + in-place per spec §6.6.
- `doctor --install-providers` invokes `uv run --with` against the pinned version in `sdk-pins.toml`; never accepts a user-supplied package name; `AD_EVALS_OFFLINE=1` only asserts an existing cache entry (no network).

## Next Steps

- Unblocks phase 09 (distribution prep) — the README matrix needs scenario list, the publish workflow needs nightly green.
