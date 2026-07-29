# VD-3912: Flatten provider_options into config top level Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `resolve-promptfoo-config.js`'s v1 tier-config resolution path put per-provider fields (`agent`, `opencode_config`, `project_dir`, `format`, `log_level`, etc.) directly on the Promptfoo provider `config` object instead of nesting them under `config.provider_options`, so `opencode-cli-provider.js` (and any other bridge-routed provider that reads its fields off the top-level config) receives what it expects.

**Architecture:** `_buildBridgeProviderEntry` in `scripts/framework/resolve-promptfoo-config.js` currently builds `config.provider_options` from the provider entry's remaining fields (everything except `provider_kind`/`model`/`label`/`agent_config`) and nests it under a `provider_options` key. Nothing in the codebase ever reads `config.provider_options` — every bridge-routed provider (`opencode-cli-provider.js`, `providers/opencode_sdk/provider.js`, the v0 path, the `openhands_agent_server` wrapper) reads its fields directly off the top-level config object. The fix removes the nesting and spreads those fields onto `config` directly, matching the `openhands_agent_server` branch two lines above it and the v0 `resolveProviderBlock` function.

**Tech Stack:** Node.js (`node:test` + `node:assert/strict`), no new dependencies.

## Global Constraints

- No change to individual eval packages' `promptfooconfig.json` files (issue non-goal).
- No change to the resolved config's semantics beyond emitting the field the provider already expects (issue non-goal) — this is a pure "where does the field live" fix, not new fields or renamed fields.
- Framework modules must not hardcode consumer-specific paths beyond `tests/evals/` (repo-wide rule from `AGENTS.md`) — not touched by this change, noted for completeness.
- Every acceptance criterion below must have a passing test that cites it by AC number in the test name or a comment directly above the assertion.

## Acceptance Criteria (from the Linear issue)

- **AC-1**: Running `run-evals-local.js run` against a previously-broken package (e.g. `skill-validating-against-baseline-contract`) succeeds without a manual config patch.
- **AC-2**: Running it against an untouched, unrelated package also succeeds (confirms this isn't package-specific).
- **AC-3**: The resolver's flattening behavior is covered by a test in the harness package.

## Known Issues (out of scope for this fix)

- **`agent_config` is silently dropped, not flattened, in both the pre-fix and post-fix code.** `_buildBridgeProviderEntry` destructures `agent_config` out of `providerEntry` (`resolve-promptfoo-config.js:397`) and never re-adds it to `config`. `eval-tier-config.js`'s `_normalizeV0ToV1` (lines 96-116) produces provider entries with `agent_config` (mapped from `runtime.opencode_config`) so a v0-shaped tier config, when normalized and routed through `resolveMultiProviderConfig` directly (not through `resolveConfigFile`'s file-based v0 branch), carries its OpenCode config path in a field name (`agent_config`) that `opencode-cli-provider.js` never reads (it requires `config.opencode_config`). This is a separate, pre-existing bug in the same function. It is **not fixed by this plan** — fixing it would mean deciding whether `_buildBridgeProviderEntry` should rename `agent_config` to `opencode_config` on the way out, which is a semantic/naming change beyond this issue's stated non-goals ("no change to the resolved config's semantics beyond emitting the field the provider already expects"). Flagged here so it isn't silently rediscovered as a mystery later — file a follow-up Linear issue if the v0-normalized-via-`resolveMultiProviderConfig` path is actually exercised in production (confirmed callers today: `scripts/framework/openhands-sdk-provider.js` and this file's own tests).

---

### Task 1: Regression test proving the bug (RED)

**Files:**
- Modify (test only): `scripts/framework/resolve-promptfoo-config.test.js`

**Interfaces:**
- Consumes: `resolveMultiProviderConfig` (already imported in this file), `_resetRunId` (already imported).
- Produces: nothing new exported — this task only adds test cases.

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('resolveMultiProviderConfig — v1 multi-provider', ...)` block in `scripts/framework/resolve-promptfoo-config.test.js` (place it right after the `'vars are at top-level tests[], NOT inside config'` test, around line 118):

```javascript
  test('AC-3: opencode_cli v1 entry exposes agent/opencode_config/project_dir at config TOP LEVEL, not nested under provider_options', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_cli',
              model: 'anthropic/claude-haiku-4-5',
              label: 'oc',
              agent: 'eval_light',
              opencode_config: 'opencode.json',
              project_dir: '../..',
              format: 'json',
              log_level: 'info',
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-flatten' });
    const entry = result.providers[0];

    // The exact bug from VD-3912: opencode-cli-provider.js reads these fields
    // off the top level of config, never off a nested provider_options bag.
    assert.strictEqual(entry.config.agent, 'eval_light');
    assert.strictEqual(entry.config.opencode_config, 'opencode.json');
    assert.strictEqual(entry.config.project_dir, '../..');
    assert.strictEqual(entry.config.format, 'json');
    assert.strictEqual(entry.config.log_level, 'info');
    assert.ok(!('provider_options' in entry.config), 'fields must not be nested under provider_options');
  });
```

- [ ] **Step 1b: Write failing tests for the other bridge-routed kinds (same bug, wider blast radius than opencode_cli)**

The same `_buildBridgeProviderEntry` branch handles `opencode_sdk`, `codex_sdk`, and `openhands_sdk` too. Each of those reads its per-kind fields off `cfg.extra` at the top level (`providers/opencode_sdk/provider.js:114` reads `cfg.extra.opencode_agent`; `providers/codex_sdk/provider.js:160-161` reads `cfg.extra.sandbox_mode`/`cfg.extra.reasoning_effort`; `providers/openhands_sdk/agent_factory.py` reads `cfg.extra.get("base_url")` for OpenHands gateway mode, documented in this repo's own `AGENTS.md` "OpenHands gateway mode" section). Under the current bug, `extra` is nested inside `provider_options.extra` instead, so all three of these are silently broken too — not just `opencode_cli`. Add these tests in the same `describe` block, right after the Step 1 test above:

```javascript
  test('AC-3: opencode_sdk v1 entry exposes extra.opencode_agent at config.extra top level', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_sdk',
              model: 'opencode-go/qwen3.5-plus',
              label: 'oc-sdk',
              extra: { opencode_agent: 'build' },
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-sdk-flatten' });
    const entry = result.providers[0];
    assert.deepStrictEqual(entry.config.extra, { opencode_agent: 'build' });
    assert.ok(!('provider_options' in entry.config), 'extra must not be nested under provider_options');
  });

  test('AC-3: codex_sdk v1 entry exposes extra.sandbox_mode/reasoning_effort at config.extra top level', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'codex_sdk',
              model: 'gpt-5-codex',
              label: 'codex',
              extra: { sandbox_mode: 'workspace-write', reasoning_effort: 'high' },
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-codex-flatten' });
    const entry = result.providers[0];
    assert.deepStrictEqual(entry.config.extra, { sandbox_mode: 'workspace-write', reasoning_effort: 'high' });
    assert.ok(!('provider_options' in entry.config), 'extra must not be nested under provider_options');
  });

  test('AC-3: openhands_sdk v1 entry exposes extra.base_url at config.extra top level (gateway mode)', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'openhands_sdk',
              model: 'gpt-4o',
              label: 'oh-gateway',
              extra: { base_url: 'https://gateway.internal/v1' },
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-oh-flatten' });
    const entry = result.providers[0];
    // This is the exact field OpenHands gateway mode reads (agent_factory.py
    // cfg.extra.get("base_url")) to decide whether to bypass legacy
    // prefix-routed API keys. Nested under provider_options, gateway mode
    // silently never activates.
    assert.deepStrictEqual(entry.config.extra, { base_url: 'https://gateway.internal/v1' });
    assert.ok(!('provider_options' in entry.config), 'extra must not be nested under provider_options');
  });
```

- [ ] **Step 1c: Write a failing test for the resolver-owned-key collision hazard**

Add this test right after the ones above, in the same `describe` block:

```javascript
  test('AC-3: a provider-declared field cannot clobber resolver-owned run_id/case_id/provider_label', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_cli',
              model: 'anthropic/claude-haiku-4-5',
              label: 'oc',
              agent: 'eval_light',
              opencode_config: 'opencode.json',
              project_dir: '../..',
              format: 'json',
              log_level: 'info',
              // Adversarial: a consumer TOML entry that happens to declare
              // these names should never be able to overwrite the resolver's
              // own run/case identity — nothing in parseTierConfig forbids
              // a provider entry from declaring them.
              run_id: 'attacker-controlled-run-id',
              case_id: 'attacker-controlled-case-id',
              provider_label: 'attacker-controlled-label',
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'real-run-id' });
    const entry = result.providers[0];
    assert.strictEqual(entry.config.run_id, 'real-run-id', 'resolver-owned run_id must win');
    assert.notStrictEqual(entry.config.case_id, 'attacker-controlled-case-id', 'resolver-owned case_id must win');
    assert.strictEqual(entry.config.provider_label, 'oc', 'resolver-owned provider_label (from `label`) must win');
  });
```

- [ ] **Step 2: Run tests to verify Step 1/1b fail and Step 1c already passes**

Run: `cd scripts/framework && node --test resolve-promptfoo-config.test.js`

Expected:
- Step 1's test **FAILS** — `entry.config.agent` is `undefined` today (the current code puts it at `entry.config.provider_options.agent` instead).
- Step 1b's three tests **FAIL** the same way for `entry.config.extra`.
- Step 1c's collision-guard test **PASSES already, today** — under the current (buggy) code, `run_id`/`case_id`/`provider_label` are set *before* the single `...(provider_options ? { provider_options } : {})` spread, so a colliding field name only ever lands inside the nested `provider_options` bag, never overwriting the resolver's own keys. This test is not proving today's code is broken — it's a **guardrail** that must keep passing once Task 2 flattens `rest` onto the top level, since a naive top-level spread (`...rest` last) would newly let a colliding field name win. Confirm it passes now so you have a true before/after comparison once Task 2 is done.

- [ ] **Step 3: Commit the failing tests**

```bash
git add scripts/framework/resolve-promptfoo-config.test.js
git commit -m "test(VD-3912): add failing regression tests for provider_options flattening (opencode_cli, opencode_sdk, codex_sdk, openhands_sdk gateway mode, key-collision guard)"
```

---

### Task 2: Fix `_buildBridgeProviderEntry` (GREEN)

**Files:**
- Modify: `scripts/framework/resolve-promptfoo-config.js:397-408`
- Modify: `scripts/framework/resolve-promptfoo-config.test.js` (adds the Step 4 integration test; Task 1's tests are otherwise unchanged in this task)

**Interfaces:**
- Consumes: `require('./opencode-cli-provider.js')` (the real, non-stubbed class) in the new Step 4 integration test.
- Produces: `_buildBridgeProviderEntry(tierName, providerEntry, providerIndex, scenarioIndex, runId)` — same signature, changed output shape (`config` now has provider fields, including `extra`, at top level; `config.provider_options` is no longer emitted; `...rest` is spread before resolver-owned keys so it cannot override them).

- [ ] **Step 1: Implement the minimal fix**

In `scripts/framework/resolve-promptfoo-config.js`, replace the body of `_buildBridgeProviderEntry`'s non-agent-server branch (currently around line 397-408):

```javascript
  const { provider_kind, model, label, agent_config, ...rest } = providerEntry;
  // Build provider_options from remaining fields (not provider_kind / model / label)
  const provider_options = Object.keys(rest).length > 0 ? rest : undefined;

  const config = {
    provider_kind,
    model: model || null,
    run_id: runId,
    case_id,
    ...(label ? { provider_label: label } : {}),
    ...(provider_options ? { provider_options } : {}),
  };
```

with:

```javascript
  const { provider_kind, model, label, agent_config, ...rest } = providerEntry;

  // Remaining fields (agent, opencode_config, project_dir, format, log_level,
  // extra, …) land at config TOP LEVEL, not nested under a provider_options
  // bag — every bridge-routed provider module (opencode-cli-provider.js,
  // opencode_sdk, codex_sdk, openhands_sdk's agent_factory.py) reads its
  // per-kind fields directly off the config object it is constructed/init'd
  // with, and none of them ever unwrap a `provider_options` key. Nesting here
  // silently dropped every consumer field the provider needed (VD-3912),
  // including OpenHands gateway mode's `extra.base_url`.
  //
  // `...rest` is spread FIRST and the resolver-owned keys (provider_kind,
  // model, run_id, case_id, provider_label) are set AFTER, so a provider
  // entry cannot accidentally declare a field with one of those names and
  // clobber the resolver's own run/case identity — the ordering is a
  // structural guarantee, not a documentation-only convention.
  //
  // Redaction (secret_redactor.js `redact()`) walks any object shape
  // recursively regardless of key names, so flattening vs. nesting has no
  // security/redaction implication — the old comment's "bridge security
  // model" reference was about the *subprocess env allowlist*
  // (_buildSpawnSpec's kindPins.env_allowlist), an unrelated mechanism.
  const config = {
    ...rest,
    provider_kind,
    model: model || null,
    run_id: runId,
    case_id,
    ...(label ? { provider_label: label } : {}),
  };
```

- [ ] **Step 1b: Run the Task 1 collision-guard test to confirm the reordering holds**

Run: `cd scripts/framework && node --test resolve-promptfoo-config.test.js -t "cannot clobber resolver-owned"`

Expected: PASS — the Step 1c test from Task 1 (which already passed against the old code by accident, via nesting) now passes against the new code by structural guarantee, via ordering.

- [ ] **Step 2: Run the Task 1 tests to verify they pass**

Run: `cd scripts/framework && node --test resolve-promptfoo-config.test.js`

Expected: PASS — all assertions in every AC-3 test added in Task 1 (Step 1, 1b, 1c) now pass.

- [ ] **Step 3: Run the full `_node_bridge` test suite to check for regressions**

Run: `cd scripts/framework && node --test _node_bridge.test.js _node_bridge.opencode_sdk.test.js _node_bridge.codex_sdk.test.js _node_bridge.openhands_sdk.test.js _node_bridge.inproc-roundtrip.test.js _node_bridge.label.test.js`

Expected: PASS — these tests stub the provider modules directly and construct their own `config` objects by hand (they never call through `resolve-promptfoo-config.js`), so they are unaffected by this change. Confirm no failures.

- [ ] **Step 4: Add an integration test that exercises the real dispatch chain (resolver → real, non-stubbed `OpenCodeCliProvider`)**

Task 1's tests only check the resolver's output shape in isolation, and `_node_bridge.test.js` stubs `OpenCodeCliProvider` entirely — nothing in the existing suite proves resolver output actually satisfies the real provider's validation. Close that gap directly: add this test to `scripts/framework/resolve-promptfoo-config.test.js`, in a new `describe` block at the end of the file:

```javascript
describe('VD-3912 integration — resolver output feeds a REAL (non-stubbed) OpenCodeCliProvider', () => {
  beforeEach(() => {
    _resetRunId();
    delete process.env.OPENCODE_MOCK_MODE; // guard: mock mode bypasses the
    // exact missingField validation this bug lives in (opencode-cli-provider.js
    // turn()/callApi() check OPENCODE_MOCK_MODE before validating config), so
    // a test run under mock mode would "pass" whether or not the fix is
    // present — a false positive. Explicitly unset it here.
  });

  test('AC-1/AC-2: resolver output satisfies the real provider\'s missingField check without a manual patch', async () => {
    const OpenCodeCliProvider = require('./opencode-cli-provider.js');
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_cli',
              model: 'anthropic/claude-haiku-4-5',
              label: 'oc',
              agent: 'eval_light',
              opencode_config: 'opencode.json',
              project_dir: '../..',
              format: 'json',
              log_level: 'info',
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'integration-001' });
    const { config } = result.providers[0];

    // Real provider, real config — only the runner is faked, so this never
    // spawns the actual opencode binary. This is the same construction
    // _node_bridge.js's opencode_cli dispatch performs in production.
    const fakeRunner = async () => 'stub output';
    const provider = new OpenCodeCliProvider({ config, runner: fakeRunner });
    const response = await provider.callApi('hello', { vars: {} });

    assert.ok(!response.error, `expected no error, got: ${response.error}`);
    assert.strictEqual(response.output, 'stub output');
  });
});
```

- [ ] **Step 5: Run the new integration test and the full resolver test file**

Run: `cd scripts/framework && node --test resolve-promptfoo-config.test.js`

Expected: PASS — including the new integration test from Step 4. If it fails with `OpenCode CLI provider requires agent, opencode_config, project_dir, format, and log_level`, the fix in Step 1 is incomplete — do not proceed until this passes.

- [ ] **Step 6: Run the full framework test suite**

Run: `npm test` (from repo root)

Expected: PASS — full contract-test suite green.

- [ ] **Step 7: Commit**

```bash
git add scripts/framework/resolve-promptfoo-config.js scripts/framework/resolve-promptfoo-config.test.js
git commit -m "fix(VD-3912): flatten v1 provider fields onto config top level instead of provider_options"
```

---

### Task 3: End-to-end verification against a real package (AC-1, AC-2)

**Files:**
- None modified — this task runs existing packages, no new files.

**Interfaces:**
- Consumes: `bin/ad-evals.js` CLI (`eval:smoke` / direct `run` invocation), already-existing packages under `tests/evals/packages/` in whichever consumer repo reproduced the bug, or Task 2 Step 4's integration test as the substitute proof when no consumer repo is available.

**Gate:** AC-1 and AC-2 require *evidence* the fix works end-to-end, not just reasoning about the code path. This task is satisfied by either Step 2+3 (a real consumer-repo run) **or** Task 2 Step 4 (the integration test through the real, non-stubbed `OpenCodeCliProvider`) — never by "documented as a gap" alone. Do not close out this task, and do not report AC-1/AC-2 as met in the Linear implementation update, unless one of those two forms of evidence actually ran and passed.

- [ ] **Step 1: Confirm which repro environment is available**

This bug was discovered and is fixed inside `promptfoo-eval-harness` itself (the framework repo), not a consumer repo. A `npm link` or local `file:` install would be needed to test a *consumer* repo's `tests/evals/` against this uncommitted fix. Check whether a consumer repo with `tests/evals/packages/skill-validating-against-baseline-contract/` is available in this environment (ask the user for its path if unstated) — if so, proceed to Step 2. If not, Task 2 Step 4's integration test already IS your AC-1/AC-2 evidence (it feeds real resolver output into the real, non-stubbed provider and asserts no `missingField` error) — confirm it passed, then skip to Step 4 to record that as the evidence used.

- [ ] **Step 2: If a consumer repo with `tests/evals/` is available in this environment, run the previously-broken package**

If the user has a consumer repo checked out locally with `tests/evals/packages/skill-validating-against-baseline-contract/promptfooconfig.json` (the package named in the issue) and a v1 `config/eval-tiers.toml` pointing at `opencode_cli`, ask the user for that repo's path, then run:

**Before running:** confirm `OPENCODE_MOCK_MODE` is unset in the shell (`echo $OPENCODE_MOCK_MODE` should print nothing). `opencode-cli-provider.js`'s mock-mode bypass runs *before* the `missingField` validation this bug lives in, so a run under mock mode "succeeds" whether or not the fix is present — it would prove nothing. If it's set, `unset OPENCODE_MOCK_MODE` before continuing.

```bash
cd <consumer-repo>/tests/evals
node scripts/run-evals-local.js run packages/skill-validating-against-baseline-contract/promptfooconfig.json
```

Expected: succeeds without the `OpenCode CLI provider requires agent, opencode_config, project_dir, format, and log_level` error, and without any manual config patch.

- [ ] **Step 3: Run it against an untouched, unrelated package in the same consumer repo**

Same `OPENCODE_MOCK_MODE` guard as Step 2 applies here.

```bash
cd <consumer-repo>/tests/evals
node scripts/run-evals-local.js run packages/<any-other-opencode_cli-package>/promptfooconfig.json
```

Expected: succeeds the same way, confirming the fix is harness-wide and not package-specific.

- [ ] **Step 4: Record which evidence satisfied AC-1/AC-2**

In the final Linear implementation update, state explicitly which of the two acceptable evidence forms was used:
- **Real consumer-repo run** (Steps 2+3 passed, with `OPENCODE_MOCK_MODE` confirmed unset), or
- **Task 2 Step 4's integration test** (the real, non-stubbed `OpenCodeCliProvider` fed by real resolver output, confirmed passing).

If neither ran and passed, AC-1/AC-2 are **not** met — do not report this task as complete, and do not hand off to `raising-linear-pr` until one of them does. "Manual reasoning about the code path" alone is not sufficient evidence for either AC.

---

## Self-Review Notes

- **Spec coverage:** AC-1/AC-2 (real run succeeds) → Task 3, gated on either a real consumer-repo run or Task 2 Step 4's integration test — never satisfied by a documented gap alone. AC-3 (resolver flattening covered by a test) → Task 1, now covering all four bridge-routed kinds (`opencode_cli`, `opencode_sdk`, `codex_sdk`, `openhands_sdk`) plus a resolver-owned-key collision guard, not just `opencode_cli`. Non-goals (no change to package configs, no semantic change beyond field placement) → respected by Task 2's minimal diff; the `agent_config` v0-migration gap is explicitly called out as a separate, out-of-scope known issue rather than silently left undiscovered.
- **No placeholders:** All code blocks are complete and copy-pasteable; Task 3's fallback path now points at concrete substitute evidence (Task 2 Step 4) instead of "document as a gap."
- **Type/signature consistency:** `_buildBridgeProviderEntry`'s signature is unchanged; only its returned `config` object's shape changes (a `rest` object literal that TypeScript-less JS spreads freely, so no signature mismatch risk). The reordering (`...rest` first, resolver-owned keys last) does not change the signature either — it changes precedence within the same object literal.

## Adversarial Review Amendments (post-plan-review, applied 2026-07-29)

This plan was adversarially reviewed by two independent Claude subagents (Skeptic + Architect lenses, standing in for the skill's normal opposite-model Codex reviewers, which were unavailable due to a local Codex CLI auth failure — see conversation record). Verdict: REJECT on the original draft, due to high-severity gaps in verification scope and the AC-1/AC-2 evidence gate. The following changes were applied in response, and are the reason Tasks 1–3 above look different from a first-draft version of this plan:

1. Task 1 Steps 1b/1c added — regression tests for `opencode_sdk`/`codex_sdk`/`openhands_sdk`'s `extra` field (the same bug also silently broke OpenHands gateway mode) and a resolver-owned-key collision guard.
2. Task 2 Step 1's fix reorders the spread (`...rest` first, resolver-owned keys last) instead of naively spreading `rest` last, closing the collision hazard Finding 4 raised.
3. Task 2 Step 4 adds a real (non-stubbed) `OpenCodeCliProvider` integration test, with an explicit `OPENCODE_MOCK_MODE` guard, closing the "unit test never proves the real dispatch chain works" gap.
4. Task 3 rewritten so AC-1/AC-2 require actual evidence (a real consumer run OR Task 2 Step 4's integration test) rather than accepting "documented as a known gap" as sufficient; Steps 2/3 add the same `OPENCODE_MOCK_MODE` guard to prevent a false-positive manual verification.
5. A "Known Issues" section was added documenting the separate, out-of-scope `agent_config` v0-migration drop bug, so it's flagged rather than silently rediscovered later.
6. Minor hygiene: removed the dead "is NOT the right command" instruction from the old Task 3 Step 1, and de-duplicated the old Task 2 Steps 2/3 (both ran the identical command).
