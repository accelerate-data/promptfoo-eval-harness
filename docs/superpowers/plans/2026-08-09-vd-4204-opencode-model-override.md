# VD-4204: OPENCODE_MODEL Env-Var Override for the Active OpenCode Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single local eval run swap the OpenCode model via `OPENCODE_MODEL=<model> npm run eval:smoke` (or similar), without editing `opencode.json` or any other git-tracked config, by adding a `--model` argv override to `scripts/framework/opencode-cli-provider.js` — the file the framework's `[runtime].provider_id = framework://opencode-cli-provider.js` actually dispatches to today.

**Architecture:** `opencode-cli-provider.js` already reads two env vars directly at call time (`OPENCODE_MOCK_MODE` for B4 mock-bypass, plus the `process.env` spread for B1 passthrough) — there is no separate config-resolution step in the loop for those toggles. This plan follows that same, already-established pattern (and mirrors `OPENHANDS_MODEL_OVERRIDE` in `openhands-agent-server-provider.js`) by reading `process.env.OPENCODE_MODEL` directly inside `callWithEmptyOutputRetries()` and pushing `--model <value>` onto the CLI argv when it's set to a non-empty (post-trim) string. See **Architecture Decisions** below for why this plan does **not** touch `scripts/framework/resolve-promptfoo-config.js`, despite the Linear issue's Goal text naming it, and why it deliberately unlocks a byte-identity-guarded file.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`), no new dependencies.

## Global Constraints

- TDD discipline throughout: RED test before implementation, one behavior at a time (per `CLAUDE.md` / `AGENTS.md` "Rules for New Code").
- Every new/changed test file lives alongside its existing suite (`scripts/framework/opencode-cli-provider.contract.test.js`) — do not create a new flat test file.
- `npm test` (`node --test scripts/*.test.js scripts/framework/*.test.js scripts/framework/providers/**/*.test.js scripts/framework/providers/**/*.test.mjs`) must pass after every task.
- Framework modules must not hardcode consumer-specific paths (AGENTS.md "Rules for New Code") — not implicated here since all changes are provider-internal.
- This repo's PR only needs to deliver **AC-1 through AC-4**. AC-5/AC-6 (consumer-repo doc fixes) are explicitly out of scope here per the issue's own "Known limitation" section — see Architecture Decisions.

---

## Architecture Decisions (read before implementing)

### 1. `opencode-cli-provider.js` is deliberately unlocked for this change

`docs/design.md` § "OpenCode CLI: Base + Sibling" documents this file as a **locked, byte-identical contract**: `scripts/framework/opencode-cli-plugin-provider.test.js` runs `git diff --exit-code <pinned-sha> HEAD -- scripts/framework/opencode-cli-provider.js` against a SHA stamped in `tests/_fixtures/phase-04-parent.sha`, and fails the build on ANY divergence — "even a `module.exports` re-export." VD-4204's Goal explicitly asks for the override on exactly this file (the one `[runtime].provider_id` resolves to).

**Decision, and where it was made:** presented to the issue owner (Jason) directly, as three options — (a) bump the pin and treat this as a deliberate, reviewed evolution of the base contract; (b) implement on the sibling only and leave the base untouched; (c) pause and get the conflict resolved in Linear/design doc first. The issue owner chose **(a)** in this conversation, in response to an explicit `AskUserQuestion` call, before this plan was written. That confirmation is procedural context for this plan, not something this plan can re-derive on its own from the repo — record it here so a later reader isn't left wondering where the authorization came from, and so the PR description can point back to it.

Given (a): edit the file, then advance the pin to the commit that introduces the change, and update the guard's documentation to record that this was intentional, not drift. Task 3 below does this as its own reviewable commit, separate from the behavior change itself — bypassing a deliberately-placed lock deserves its own auditable commit rather than being folded into the feature commit.

**Caveat surfaced by adversarial review (accepted, not fixed in-repo):** this plan does not touch the sibling `opencode-cli-plugin-provider.js`, which independently duplicates its own argv-building code and will silently no-op on `OPENCODE_MODEL` (no error, no warning). This repo's own `docs/setup.md` / `CLAUDE.md` steer any consumer using `load_local_env = true` toward that sibling specifically, so a consumer who reads Task 4's new `docs/setup.md` row, assumes it applies to whichever `opencode_cli`-family provider they're using, and is on the plugin variant will see no effect. Task 4's doc wording is written to call this out explicitly rather than leave it implicit. Closing the gap for the sibling itself is out of scope for VD-4204 (a future issue, if parity is wanted).

The sibling `opencode-cli-plugin-provider.js` is **not** touched — it is opt-in (`framework://opencode-cli-plugin-provider.js`) and out of scope for "the active provider" as VD-4204 defines it. Its own argv-building code is fully independent (duplicated, not inherited), so it does not need or get `OPENCODE_MODEL` support from this change. Flagged as a known gap if a future issue wants parity.

### 2. No change to `resolve-promptfoo-config.js`

VD-4204's Goal text says to touch "`resolve-promptfoo-config.js`'s `_buildBridgeProviderEntry`... upstream of it" and its Risks section warns the env-var read "must be scoped to the non-`openhands_agent_server` branch... to not leak `OPENCODE_MODEL` into `-oh` tiers' explicit `model` fields." That risk only exists under a design where a *shared* resolver function reads the env var for every provider kind. This plan does not use that design: reading `process.env.OPENCODE_MODEL` **inside `opencode-cli-provider.js` itself** means the code path is only ever reached for `opencode_cli`-kind runs — `-oh` tiers execute a completely different provider module (`openhands-sdk-provider.js` / `openhands-agent-server-provider.js`) that never imports or calls `opencode-cli-provider.js`. There is no shared code path to leak across, so the described risk doesn't apply, and the codebase already has direct precedent for this shape: `openhands-agent-server-provider.js`'s `_resolveTierConfig()` reads `OPENHANDS_MODEL_OVERRIDE` directly, in-provider, with the exact trim/empty-string-means-unset semantics this plan reuses for `OPENCODE_MODEL`.

Net effect: **all four in-repo ACs (AC-1–AC-4) are satisfied without touching the resolver**, with less code, less risk (no chance of the resolver's `model` field — already set from `providerEntry.model` in existing tier configs today, and today totally inert for `opencode_cli` since the provider never reads it — suddenly gaining CLI effect for pre-existing configs that never asked for it). This was flagged for adversarial review as a literal deviation from the issue's Goal text; the review's Architect and Skeptic lenses independently verified (by reading `_node_bridge.js`'s `KIND_REGISTRY` dispatch and `resolve-promptfoo-config.js` directly) that `-oh` tiers genuinely never execute any code in `opencode-cli-provider.js`, confirming there is no cross-kind leak this deviation could cause.

**Caveat surfaced by adversarial review (accepted, documented not fixed):** `OPENCODE_MODEL` is read from `process.env` inside `callWithEmptyOutputRetries()`, i.e. it is process-global for the duration of one `npm run eval:smoke`/`eval:regression` invocation, not scoped per tier or per provider entry. A single run with multiple `opencode_cli` provider entries in its tier config (the v1 multi-provider shape `resolveMultiProviderConfig` already supports) will apply the same override to every one of them indiscriminately. That matches VD-4204's stated "single local eval run" framing, but is a real limitation if a future run wants to A/B two different `opencode_cli` models in the same invocation — flag as a follow-up if that need arises; not a regression against any current behavior since no such scoping exists today either.

### 3. No new smoke-test package; AC-1–AC-4 verified at contract-test altitude only

The issue's "Test Notes" flags an open question: whether to add a smoke case in this repo that sets `OPENCODE_MODEL` against a `light`-tier package, to close the "nothing in this repo verifies AC-1–4" gap. **Decision: no.** Two independent reasons:

- `OPENCODE_MOCK_MODE=1` (the only mode a CI smoke test can use without a live OpenCode install + API key) short-circuits `turn()` **before** `callWithEmptyOutputRetries()` builds argv at all (see B4 in the file's header comment) — a mock-mode smoke case would never execute the new `--model` line, so it would prove nothing beyond what a contract test already proves.
- A real (non-mock) smoke case needs the `opencode` binary on `PATH` and a live model API key — non-deterministic in CI, and exactly the kind of test the existing suite already avoids (B1–B5 are verified via an injected recording runner that captures raw argv, never a real spawn). AC-1/AC-3/AC-4 are claims about **what argv is constructed**, which is precisely the altitude the existing contract-test harness already tests at.

This repo's own `examples/harness-smoke/` and `config/eval-tiers.toml` don't even use `opencode_cli` today (all tiers are `openhands_sdk`), so adding one would also mean standing up new example fixtures unrelated to what any AC requires. AC-1–AC-4 are fully covered by Task 1–3's contract tests below.

### 4. AC-2's CLI-precedence claim has a test boundary

AC-2 ("the run's model does not come from `opencode.json`'s per-agent model field... even if it differs") is, once `--model` is on the argv, a claim about **OpenCode CLI's own precedence rules** (explicit flag beats config file) — that binary's behavior is not something this repo's unit tests can or should assert. What this repo *can* and does assert: when `OPENCODE_MODEL` is set, `--model <value>` is present in the constructed argv (Task 1, AC-2 test) — i.e., the value this provider hands to OpenCode does not originate from reading `opencode.json`, full stop, since this provider never reads that file's model field in the first place (only `opencode_config` — the *path* — is read, never parsed). This is documented inline in the AC-2 test itself so a future reader isn't confused about why the assertion looks the same shape as AC-1's.

---

## File Structure

| File | Change |
| --- | --- |
| `scripts/framework/opencode-cli-provider.contract.test.js` | New `describe` block: "Section 5 — OPENCODE_MODEL override (VD-4204)" with 4 test blocks (AC-1/AC-2 combined, AC-3, AC-4, and one table-driven block covering 3 edge cases) — 6 `test()` invocations total |
| `scripts/framework/opencode-cli-provider.js` | New `--model` argv branch inside `callWithEmptyOutputRetries()`; header JSDoc gains a `B6` line |
| `tests/_fixtures/phase-04-parent.sha` | Pin advanced to the commit that introduces the `B6` change |
| `scripts/framework/opencode-cli-plugin-provider.test.js` | Comment above the byte-identity test updated to record the deliberate VD-4204 pin advance |
| `docs/design.md` | § "OpenCode CLI: Base + Sibling" updated with a short VD-4204 note |
| `docs/setup.md` | Provider env-var reference table gains an `OPENCODE_MODEL` row for `opencode_cli` |

---

## Task 1: RED — write the failing OPENCODE_MODEL tests

**Files:**
- Modify (test): `scripts/framework/opencode-cli-provider.contract.test.js`

**Interfaces:**
- Consumes: `loadProvider()`, `VALID_CONFIG`, `makeRecordingRunner()` — all already defined at the top of this test file (read above, unchanged).
- Produces: nothing new for later tasks to consume — this is the terminal test file for this plan.

- [ ] **Step 1: Add the new `describe` block at the end of the file, before the final closing of the module (i.e., append after Section 4)**

```javascript
// ---------------------------------------------------------------------------
// Section 5 — OPENCODE_MODEL override (VD-4204)
// ---------------------------------------------------------------------------

describe('Section 5 — OPENCODE_MODEL override (VD-4204)', () => {
  function withEnv(value, fn) {
    const prev = process.env.OPENCODE_MODEL;
    if (value === undefined) {
      delete process.env.OPENCODE_MODEL;
    } else {
      process.env.OPENCODE_MODEL = value;
    }
    return fn().finally(() => {
      if (prev === undefined) delete process.env.OPENCODE_MODEL;
      else process.env.OPENCODE_MODEL = prev;
    });
  }

  test('AC-1 & AC-2: OPENCODE_MODEL set — argv includes --model <value>, and it is the only source of that value', () => withEnv('anthropic/claude-opus-5', async () => {
    // AC-2 boundary note: this provider never opens or parses opencode_config's
    // file contents (verified: callWithEmptyOutputRetries only resolves its
    // *path* and forwards it via OPENCODE_CONFIG, B1) — there is no code path
    // here that could read a per-agent model out of that file, so "the model
    // does not come from opencode.json" is a structural fact about this
    // provider, not a distinct runtime behavior a second test could exercise.
    // A prior draft of this test set a differently-named opencode_config path
    // to "prove" AC-2 separately from AC-1; adversarial review correctly
    // flagged that as a duplicate assertion with no differential coverage
    // (any implementation passing AC-1 passes it too), so it's folded in here
    // instead of kept as a same-shape sibling test.
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('ok');
    const session = await init({ ...VALID_CONFIG, _runner: runner });
    await turn(session, 'prompt');
    const { args } = runner.calls[0];
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx !== -1, 'argv must include --model when OPENCODE_MODEL is set');
    assert.strictEqual(args[modelIdx + 1], 'anthropic/claude-opus-5', '--model value must equal OPENCODE_MODEL');
  }));

  test('AC-3: OPENCODE_MODEL unset — argv shape is byte-for-byte identical to today (no --model flag)', () => withEnv(undefined, async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('argv snapshot output');
    const session = await init({ ...VALID_CONFIG, agent: 'eval_standard', format: 'json', log_level: 'WARN', _runner: runner });
    await turn(session, 'the prompt text');
    const { args } = runner.calls[0];
    assert.deepStrictEqual(
      args.slice(0, 9),
      ['run', '--agent', 'eval_standard', '--dir', args[4], '--format', 'json', '--log-level', 'WARN'],
      'fixed prefix must be unchanged',
    );
    assert.ok(!args.includes('--model'), '--model must NOT appear when OPENCODE_MODEL is unset');
    assert.strictEqual(args[args.length - 1], 'the prompt text', 'last arg must still be the prompt');
  }));

  test('AC-4: override requires no config field at all — only the env var', () => withEnv('opencode-go/qwen3.5-plus', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('ok');
    // VALID_CONFIG has no model-shaped field whatsoever — proves the
    // override path needs nothing added to opencode.json or the tier TOML.
    const session = await init({ ...VALID_CONFIG, _runner: runner });
    await turn(session, 'prompt');
    const { args } = runner.calls[0];
    assert.ok(args.includes('--model'), '--model must appear from the env var alone');
    assert.strictEqual(args[args.indexOf('--model') + 1], 'opencode-go/qwen3.5-plus');
  }));

  // Edge cases collapsed into one table-driven test (adversarial review flagged
  // 3 separate near-identical tests here as over-testing relative to this
  // codebase's own precedent for the analogous OPENHANDS_MODEL_OVERRIDE
  // feature, which covers empty/blank/trim in far fewer cases).
  for (const [envValue, expectModel] of [
    ['', null],                                    // empty string → treated as unset (matches OPENHANDS_MODEL_OVERRIDE semantic)
    ['   ', null],                                  // whitespace-only → treated as unset
    ['  anthropic/claude-sonnet-5  ', 'anthropic/claude-sonnet-5'], // value is trimmed before use
  ]) {
    test(`OPENCODE_MODEL=${JSON.stringify(envValue)} → ${expectModel === null ? 'no --model flag' : `--model ${expectModel}`}`, () => withEnv(envValue, async () => {
      const { init, turn } = loadProvider();
      const runner = makeRecordingRunner('ok');
      const session = await init({ ...VALID_CONFIG, _runner: runner });
      await turn(session, 'prompt');
      const { args } = runner.calls[0];
      if (expectModel === null) {
        assert.ok(!args.includes('--model'), `OPENCODE_MODEL=${JSON.stringify(envValue)} must not produce a --model flag`);
      } else {
        assert.strictEqual(args[args.indexOf('--model') + 1], expectModel, 'value must be trimmed before use');
      }
    }));
  }
});
```

- [ ] **Step 2: Run the new tests and confirm the behavior-asserting ones fail for the right reason**

Run: `node --test scripts/framework/opencode-cli-provider.contract.test.js`
Expected (verified empirically during adversarial review — do not expect all new tests to be red): the **AC-1/AC-2 combined test**, the **AC-4 test**, and the **trim edge case** (`'  anthropic/claude-sonnet-5  '` → expects `--model` present) FAIL, because the current provider never emits `--model` at all. The **AC-3 test** and the **empty-string / whitespace-only edge cases** PASS immediately — they assert "no `--model` flag," which is already true of the unmodified provider; these are legitimate regression-guard tests that start green, not broken RED-phase tests. All pre-existing tests in the file still PASS.

- [ ] **Step 3: Commit the RED tests**

```bash
git add scripts/framework/opencode-cli-provider.contract.test.js
git commit -m "test(VD-4204): add failing tests for OPENCODE_MODEL override (AC-1..AC-4)"
```

---

## Task 2: GREEN — implement the `--model` argv override

**Files:**
- Modify: `scripts/framework/opencode-cli-provider.js:10-19` (header JSDoc), `:162-203` (`callWithEmptyOutputRetries`)

**Interfaces:**
- Consumes: nothing new — `process.env.OPENCODE_MODEL`, read directly (same pattern as the existing `OPENCODE_MOCK_MODE` read at line 58).
- Produces: `--model <value>` is appended to the `args` array built in `callWithEmptyOutputRetries()`, positioned after the fixed `--log-level <value>` pair and before the conditional `--print-logs` push — Task 1's tests rely on this exact position only insofar as they use `args.indexOf('--model')`, not a fixed index, so exact placement is free as long as it lands before the prompt is appended.

- [ ] **Step 1: Update the header JSDoc (lines 10-16) to document the new preserved behavior, including updating "five" to "six" in the header line itself**

Adversarial review caught that a naive edit here would add a `B6` entry under a header that still literally says "five" — fix the count word, not just the list.

Change:
```javascript
 * §7.4 five preserved behaviors — keyed to line numbers below:
 *   B1: env passthrough     — callWithEmptyOutputRetries() env block (~L97)
 *   B2: argv shape          — args array assembly (~L79)
 *   B3: exit-code mapping   — runOpenCode() close handler (~L158)
 *   B4: mock-mode bypass    — turn() OPENCODE_MOCK_MODE check (~L48)
 *   B5: redaction-friendly  — error messages never echo env values (~L165)
```
to:
```javascript
 * §7.4 six preserved behaviors — keyed to line numbers below:
 *   B1: env passthrough     — callWithEmptyOutputRetries() env block (~L97)
 *   B2: argv shape          — args array assembly (~L79)
 *   B3: exit-code mapping   — runOpenCode() close handler (~L158)
 *   B4: mock-mode bypass    — turn() OPENCODE_MOCK_MODE check (~L48)
 *   B5: redaction-friendly  — error messages never echo env values (~L165)
 *   B6: model override      — OPENCODE_MODEL env var → --model <value> in
 *                             callWithEmptyOutputRetries() argv (~L180, VD-4204)
```

- [ ] **Step 2: Add the override inside `callWithEmptyOutputRetries()`, between the fixed `args` array and the `print_logs` check**

Find:
```javascript
  // B2: argv shape — must be preserved byte-for-byte (§7.4)
  const args = [
    'run',
    '--agent',
    config.agent,
    '--dir',
    projectDir,
    '--format',
    config.format,
    '--log-level',
    config.log_level,
  ];
  if (config.print_logs) {
    args.push('--print-logs');
  }
```

Replace with:
```javascript
  // B2: argv shape — must be preserved byte-for-byte (§7.4)
  const args = [
    'run',
    '--agent',
    config.agent,
    '--dir',
    projectDir,
    '--format',
    config.format,
    '--log-level',
    config.log_level,
  ];
  // B6: model override (VD-4204) — OPENCODE_MODEL, trimmed, wins over
  // opencode.json's per-agent model for this invocation. Empty/whitespace-only
  // is treated as unset, matching OPENHANDS_MODEL_OVERRIDE's semantic in
  // openhands-agent-server-provider.js. This provider never reads/parses
  // opencode.json itself (only forwards its path via OPENCODE_CONFIG, B1),
  // so this is the only place a model value can come from besides OpenCode's
  // own default resolution.
  const modelOverride = process.env.OPENCODE_MODEL;
  if (typeof modelOverride === 'string' && modelOverride.trim() !== '') {
    args.push('--model', modelOverride.trim());
  }
  if (config.print_logs) {
    args.push('--print-logs');
  }
```

- [ ] **Step 3: Run the full contract-test file and confirm all tests pass**

Run: `node --test scripts/framework/opencode-cli-provider.contract.test.js`
Expected: PASS — all Section 1-4 tests unchanged, all 7 new Section 5 tests PASS.

- [ ] **Step 4: Run the full test suite to check for regressions elsewhere**

Run: `npm test`
Expected (verified empirically during adversarial review): ALL suites PASS at this point, **including** the byte-identity test — it diffs committed history (`git diff --exit-code <sha> HEAD -- <path>`), so an uncommitted working-tree edit is invisible to it. It does not go red until *after* Step 5's commit lands. Confirm no test fails here; if the byte-identity test is already failing at this step, something is wrong with the sequencing (it should only fail once the change is committed, per Step 5).

- [ ] **Step 5: Commit the implementation**

```bash
git add scripts/framework/opencode-cli-provider.js
git commit -m "feat(VD-4204): add OPENCODE_MODEL env-var override to opencode-cli-provider.js"
```

- [ ] **Step 6: Confirm the byte-identity guard is now red, as expected, before moving to Task 3**

Run: `node --test scripts/framework/opencode-cli-plugin-provider.test.js`
Expected: the "base file ... is byte-identical from phase-04 parent SHA" test now FAILS — this is the intentional signal Task 3 exists to resolve, and it only appears post-commit.

---

## Task 3: Deliberately advance the phase-04 byte-identity pin, and document `OPENCODE_MODEL`

Adversarial review's Minimalist lens noted the original Task 3 (pin advance) and Task 4 (docs/setup.md) were both small and tightly coupled to Task 2 — Task 3's own content is only computable once Task 2 is committed, and Task 4 had no dependents of its own. Merged here into one task, two commits (pin-advance stays its own commit for audit-trail clarity per Architecture Decision #1; the doc update is a second, independent commit within this same task since it doesn't touch guarded files).

**Files:**
- Modify: `tests/_fixtures/phase-04-parent.sha`
- Modify: `scripts/framework/opencode-cli-plugin-provider.test.js` (comment only, no logic change)
- Modify: `docs/design.md` (§ "OpenCode CLI: Base + Sibling")
- Modify: `docs/setup.md` (env-var reference — see Steps 7-9)

**Interfaces:**
- Consumes: the commit SHA created at the end of Task 2, Step 5.
- Produces: a green byte-identity test again, with the guard now anchored to this change instead of pre-VD-4204 history.

- [ ] **Step 1: Capture the SHA of the commit that changed the base file**

Run: `git rev-parse HEAD`
Record the output — call it `<NEW_SHA>` for the next step. (This is the commit from Task 2 Step 5, since Task 1's commit only touched the test file, not `opencode-cli-provider.js` itself — verify with `git show --stat HEAD` that `scripts/framework/opencode-cli-provider.js` is the changed path.)

- [ ] **Step 2: Update the pin file**

Overwrite `tests/_fixtures/phase-04-parent.sha` with `<NEW_SHA>` followed by a single trailing newline (match the existing file's format — verify with `cat -A tests/_fixtures/phase-04-parent.sha` before and after).

- [ ] **Step 3: Update the guard test's comment to record the deliberate advance**

In `scripts/framework/opencode-cli-plugin-provider.test.js`, immediately above the `test('base file scripts/framework/opencode-cli-provider.js is byte-identical from phase-04 parent SHA', ...)` block, add:

```javascript
// NOTE (VD-4204): this pin was deliberately advanced to the commit that added
// the OPENCODE_MODEL env-var override (--model argv flag) to the base file.
// That was a reviewed, intentional evolution of the §7.4 contract — not
// drift — per docs/design.md § "OpenCode CLI: Base + Sibling". Any diff
// against THIS pin going forward is still an unreviewed-change signal.
```

- [ ] **Step 4: Update `docs/design.md`**

In § "OpenCode CLI: Base + Sibling", after the existing paragraph ending "...no longer matches `HEAD` for that file.", add:

```markdown
**VD-4204 update:** the pin was deliberately advanced once, to add an
`OPENCODE_MODEL` env-var override (`--model <value>` on the CLI argv,
mirroring `OPENHANDS_MODEL_OVERRIDE` in `openhands-agent-server-provider.js`).
This was a reviewed, intentional evolution of the base contract, not an
accidental edit slipping past the guard — the guard's job is to make *future*
edits impossible by accident, not to freeze the base forever. The sibling
`opencode-cli-plugin-provider.js` was NOT updated to match; it has its own,
independently-duplicated argv-building code and does not currently support
`OPENCODE_MODEL`.
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: ALL suites PASS, including the byte-identity test (now green against the new pin).

- [ ] **Step 6: Commit the pin advance**

```bash
git add tests/_fixtures/phase-04-parent.sha scripts/framework/opencode-cli-plugin-provider.test.js docs/design.md
git commit -m "chore(VD-4204): advance phase-04 byte-identity pin for the OPENCODE_MODEL change"
```

- [ ] **Step 7: Document `OPENCODE_MODEL` in this repo's own provider reference — auth table (docs/setup.md, ~line 79)**

This is **not** AC-5/AC-6 — those name `tests/evals/docs/providers/opencode.md`, a file that exists only in a consumer repo (confirmed: no `docs/providers/` directory and no `scripts/opencode-provider.js` exist anywhere in this repo, including `templates/`). AC-5/AC-6 are fixed in the consumer repo's own PR, once it bumps its dependency to the version that ships this change, per the issue's "Known limitation" section. This step keeps this repo's own `docs/setup.md` — which already documents `OPENHANDS_MODEL_OVERRIDE` for `openhands_agent_server` two rows below — consistent for the sibling case. Adversarial review confirmed by running `grep -n "opencode_cli" docs/setup.md` that there are in fact two separate tables needing this row, not one — both are done explicitly below rather than left as a "check and maybe add" judgment call.

Find (docs/setup.md, ~line 79):
```markdown
| `opencode_cli` | Inherits the calling shell's env; OpenCode handles its own auth via `opencode.json` / `OPENCODE_CONFIG`. Add `OPENCODE_API_KEY` only if `opencode.json` references it directly. |
```

Replace with:
```markdown
| `opencode_cli` | Inherits the calling shell's env; OpenCode handles its own auth via `opencode.json` / `OPENCODE_CONFIG`. Add `OPENCODE_API_KEY` only if `opencode.json` references it directly. Optional: `OPENCODE_MODEL` (VD-4204) — per-run model swap without editing `opencode.json`; applies to this base provider only, **not** the `opencode-cli-plugin` sibling (see next row). |
```

- [ ] **Step 8: Document `OPENCODE_MODEL` in the detailed env-var reference table (docs/setup.md, ~line 403)**

Find:
```markdown
| `opencode_cli` | Inherits the calling shell's environment — auth is delegated to OpenCode's own config (`opencode.json`, `OPENCODE_CONFIG`, or the OpenCode provider table). | `OPENCODE_CONFIG`, `XDG_STATE_HOME` (the base provider sets these per run; spread `process.env` otherwise). | Base provider does **not** read `.env`. Consumers who want `.env` auto-load layer it via the `opencode-cli-plugin` wrapper with `load_local_env = true`. The OpenCode binary must be on `PATH` (override via the plugin wrapper's `opencode_runner_command`). |
```

Replace with:
```markdown
| `opencode_cli` | Inherits the calling shell's environment — auth is delegated to OpenCode's own config (`opencode.json`, `OPENCODE_CONFIG`, or the OpenCode provider table). | `OPENCODE_CONFIG`, `XDG_STATE_HOME` (the base provider sets these per run; spread `process.env` otherwise). Optional: `OPENCODE_MODEL` (VD-4204) — per-run model swap via `--model <value>`, without editing `opencode.json`; empty/whitespace-only is treated as unset. | Base provider does **not** read `.env`. Consumers who want `.env` auto-load layer it via the `opencode-cli-plugin` wrapper with `load_local_env = true`. The OpenCode binary must be on `PATH` (override via the plugin wrapper's `opencode_runner_command`). **`OPENCODE_MODEL` is NOT read by the `opencode-cli-plugin` sibling** — it has its own, independently-duplicated argv-building code and silently ignores this env var today. |
```

- [ ] **Step 9: Run markdown lint, then commit**

Run: `npm run lint:md`
Expected: PASS (no new lint errors introduced by either table edit).

```bash
git add docs/setup.md
git commit -m "docs(VD-4204): document OPENCODE_MODEL for the opencode_cli provider"
```

---

## Task 4: Final AC verification pass

**Files:** none (verification only)

- [ ] **Step 1: Re-read the Linear issue's AC-1 through AC-6 and check each against this repo's changes**

- AC-1 (model used when set) → Task 1's combined `AC-1 & AC-2` test + Task 2 implementation. ✅ in-repo.
- AC-2 (not from opencode.json) → same combined test (adversarial review found a separately-named AC-2 test added no differential coverage over AC-1, so they're merged) + Architecture Decision #4 boundary note explaining the structural reason a separate test can't add signal here. ✅ in-repo, with documented test-boundary caveat.
- AC-3 (unset → today's behavior) → Task 1's `AC-3` test. ✅ in-repo.
- AC-4 (no shared-file edit needed) → Task 1's `AC-4` test. ✅ in-repo.
- AC-5 / AC-6 (consumer-repo doc naming/content) → confirmed out of scope for this repo (no such doc exists here); left for the consumer repo's own PR per the issue's "Known limitation" section. Record this explicitly in the PR description raised for this work.

- [ ] **Step 2: Run the full suite one last time**

Run: `npm test`
Expected: PASS, zero regressions, byte-identity guard green against the advanced pin.

- [ ] **Step 3: Review `git log` for this branch and confirm the 4 commits tell a clean story**

Run: `git log --oneline -5`
Expected: 4 commits in this order — test(VD-4204) RED → feat(VD-4204) GREEN → chore(VD-4204) pin advance → docs(VD-4204) setup.md. No fixup/squash needed before review.

---

## Self-Review Notes

- **Spec coverage:** all 6 ACs from the Linear issue are addressed above — 4 in-repo, 2 explicitly deferred with a stated reason tied to the issue's own text.
- **Placeholder scan:** no TBD/TODO; every step has literal code or literal commands.
- **Type consistency:** `config.model` (resolver-set field, untouched by this plan) is never conflated with the new `process.env.OPENCODE_MODEL` read — they are two different things and this plan only ever reads the latter, directly, inside the provider.

## Adversarial Review Pass (2026-08-09)

Reviewed by 3 Claude subagents (Architect, Skeptic, Minimalist lenses), each independently cross-checking plan claims against the live repo via Read/Grep/Bash rather than trusting the plan's prose. Verdict: CONTESTED, resolved as follows.

**Accepted and applied to this plan:**
- Task 1/Task 2's "expected" test-run outcomes were factually wrong (verified by a reviewer actually running the tests) — corrected: only 3 of the 6 `test()` invocations are RED pre-implementation (AC-3 and the empty/whitespace edge cases are legitimate green regression guards, not broken RED-phase tests); the byte-identity guard stays green through Task 2 Step 4 (it diffs commits, not the working tree) and only goes red after the Step 5 commit — added an explicit Step 6 to confirm that.
- 7 tests for a 4-line change was over-testing relative to this codebase's own precedent (`OPENHANDS_MODEL_OVERRIDE` got 4 tests total) — trimmed to 4 test blocks / 6 invocations: AC-1/AC-2 merged into one test (the separate AC-2 test added no differential coverage — same assertion shape as AC-1), and the 3 edge cases (empty/whitespace/trim) collapsed into one table-driven test block.
- The pin-advance "confirmed with the issue owner" claim had no record of where that confirmation happened — added an explicit note that it was an `AskUserQuestion` decision made earlier in this same conversation, not a repo artifact this plan could point to independently.
- `OPENCODE_MODEL` being process-global (not per-provider-entry) and the sibling plugin's silent no-op gap were both real, previously-undocumented limitations — added as explicit caveats in Architecture Decisions #1 and #2, and the sibling gap is now called out directly in the `docs/setup.md` wording itself (Task 3 Step 8) so it isn't just a plan-internal note.
- The "five preserved behaviors" header text would have gone stale after adding a sixth — fixed to say "six."
- Task 4 (docs/setup.md, originally separate)'s "check for a second table" step was an open-ended judgment call left to whoever executes the plan — resolved now: both tables in `docs/setup.md` need the row, confirmed by grep, both edited explicitly (Task 3 Steps 7-8). Task 4 was folded into Task 3 as a second commit, since it had no independent dependents and its own content was tightly coupled to Task 3 already existing.

**Rejected (with rationale):**
- The suggestion to abandon the base-file edit and implement only on the sibling instead: rejected — the issue owner already made this call explicitly (Architecture Decision #1), and VD-4204's ACs are written against "the active provider," which the sibling is not.
- The observation that `config.model` is a confusing dead-parallel-field once `OPENCODE_MODEL` exists: accepted as a real architectural observation but rejected as an in-plan fix — reconciling it means either wiring `config.model` into the CLI provider generally (a much bigger, riskier, unscoped change affecting every existing `opencode_cli` tier config) or renaming/deprecating it (a `resolve-promptfoo-config.js` change this plan deliberately avoids per Architecture Decision #2). Left as a follow-up observation, not a task.
- Minor tautology in the AC-3 test's `args.slice(0, 9)` comparison (index 4 compares a value to itself): rejected as an action item — it's the pre-existing convention already used by the file's original B2 test, not a defect this plan introduces.
