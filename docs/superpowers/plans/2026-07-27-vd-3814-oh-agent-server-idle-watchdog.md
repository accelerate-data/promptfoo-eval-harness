# VD-3814: Idle/stall watchdog for openhands-agent-server-provider.js Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `scripts/framework/openhands-agent-server-provider.js` an idle/stall watchdog equivalent to the legacy `openhands-provider.js`'s `STREAM_IDLE_TIMEOUT_MS` mechanism — if the WebSocket event stream goes silent for a configurable duration, conclude the turn with whatever partial output has been collected instead of hanging until the outer promptfoo timeout fires with nothing to inspect.

**Architecture:** Replace the `for await (const event of events)` loop in `_runOnce()` with a manual async-iterator loop that races each `iterator.next()` call against a resettable idle timer (`Promise.race`). On idle timeout: log to stderr, push an `idle_timeout` marker into the trajectory (already written to `.eval-run/trajectory.json` in the existing `finally` block), and fall through to the existing "return whatever text was collected" path — the same code path a clean `finished`/`paused` terminal event takes today. No new dependency, no change to the REST/WS contract, no change to any other provider.

**Tech Stack:** Node.js (CJS), `node:test`, `ws` (already a dependency). No new packages.

> **Adversarial review note (2026-07-27):** this plan was reviewed by three Claude-backed reviewers (Skeptic, Architect, Minimalist), each independently verifying claims against the actual worktree rather than reviewing the prose alone. One real defect was found and folded into Task 2 Step 3: the manual iterator loop must call `iterator.return?.()` on exit (fire-and-forget, not awaited) to preserve the generator-cleanup guarantee `for await...of` gives for free — awaiting it would reintroduce the exact hang this watchdog exists to prevent, since the idle-timeout path always has one outstanding `iterator.next()` call in flight. Two lower-severity findings were folded in as comments/notes rather than code changes: `idleTimeoutMs: 0` is silently treated as "unset," not "disable" (nothing today needs disable semantics, so this is now a one-line code comment, not a behavior change); and the cross-repo env-var-reuse risk is now called out explicitly below instead of only asserted as a benefit. The two duplicate-setup tests in Task 2 were merged into one (matching this test file's own precedent of bundling related assertions in a single test), and the plan's second rationale comment inside `_runOnce` was trimmed to a pointer instead of repeating the constant's doc comment. One reviewer's claim that this PR's cross-repo `Fixes VD-3814` framing "matches how VD-3792/VD-3793 already reference this same ownership split" could not be verified in this repo's git history and was removed — the underlying convention (this repo's own `CONTRIBUTING.md` `Fixes VD-XXX` rule) still holds and is cited directly instead. Three suspected defects (an unhandled-rejection risk from the abandoned `iterator.next()` promise, incorrect `Symbol.asyncIterator` resolution for the back-compat wsClient shapes, and the `npm test -- --test-timeout=5000` flag not working) were each checked against the actual code/CLI and confirmed to be non-issues — no change needed for those.

## Global Constraints

- `package.json` `engines.node` is `>=20` — do not use anything newer (no need to; this plan only uses `Promise.race`, `setTimeout`, `Symbol.asyncIterator`, all long-available).
- Do not touch `scripts/framework/opencode-cli-provider.js` (locked, byte-identity-guarded) or any other provider file — this is scoped to `openhands-agent-server-provider.js` only.
- Env var name: reuse `OPENHANDS_STREAM_IDLE_TIMEOUT_MS` — the exact name the legacy `openhands-provider.js` already uses (see `ext/vd-data-engineering/tests/evals/scripts/openhands-provider.js` in the `vibedata-data-engineering` repo, line ~225: `STREAM_IDLE_TIMEOUT_MS = Number(process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS || 900_000)`). Reusing the name means one env var, set once by a consumer repo, tunes the stall floor for both providers during the `-oh` migration (VD-3793) — consumers do not have to learn a second variable for behaviorally-equivalent tuning. **Accepted risk:** the canonical definition of this name and its default lives in a different repo this one doesn't test or depend on — a future change to the legacy provider's semantics (e.g. treating `0` as "disable," or changing the default) would not be caught by this repo's CI and could silently retune this provider too. There's already same-repo precedent for one env var driving two provider kinds (`docs/setup.md`: `OPENHANDS_MODEL_OVERRIDE` covers both `openhands_sdk` and `openhands_agent_server`), but that precedent is for two providers this repo owns and tests together, which is a strictly narrower risk than this cross-repo reuse. Accepted anyway because a second, harness-only env var name would be one more thing for consumers to learn for identical behavior.
- Default: `900_000` ms (15 min) — copied verbatim from the legacy provider's own floor rationale (a cold Fabric/dbt build on a Spark session can be silent 5–10 min, so the floor must clear that).
- `npm test` (`node --test scripts/*.test.js scripts/framework/*.test.js scripts/framework/providers/**/*.test.js scripts/framework/providers/**/*.test.mjs`) is the verification gate — must stay green throughout, including every pre-existing `openhands-agent-server-provider.test.js` test (they exercise the same `_runOnce` code path and must not regress).
- No `console.log` / new logging library — match the file's existing `process.stderr.write(...)` convention (used nowhere yet in this file today, but is the house style in the legacy provider and elsewhere in this repo).
- This is a cross-repo fix relative to the Linear issue (VD-3814 is filed in `vibedata-data-engineering`/Studio's Linear workspace, but the code lives here in `promptfoo-eval-harness`) — the PR raised from this plan targets `accelerate-data/promptfoo-eval-harness`, not the Studio repo, and its description must say `Fixes VD-3814` per this repo's own `CONTRIBUTING.md` convention (`Fixes VD-XXX` in the PR body), even though the issue is filed in a different repo's Linear workspace.

## File Structure

- Modify: `scripts/framework/openhands-agent-server-provider.js`
  - New top-level constant `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 900_000` and helper `positiveInteger(value)`, placed after the existing `DEFAULT_EVAL_MODE_PREAMBLE` block (~line 33).
  - `constructor()` (~line 229) gains `this.idleTimeoutMs`, resolved constructor-option → env var → default, mirroring the existing `options.httpClient || defaultHttpClient()` pattern already used for test seams.
  - `_runOnce()`'s event-consumption loop (lines 353–409) is rewritten from `for await` to a manual-iterator `Promise.race` loop; everything else in `_runOnce` (workspace setup, REST POST, WS connect, trajectory/provider.json writes, `terminalError` handling) is unchanged, with one deliberate addition: the loop now calls `iterator.return?.()` on exit (see "Why `iterator.return?.()`" below) — `for await...of` does this automatically and the manual rewrite must replicate it explicitly.
  - `module.exports.__private` (line 414) gains `DEFAULT_STREAM_IDLE_TIMEOUT_MS` and `positiveInteger` so tests can assert on the constant without duplicating the magic number.
- Modify: `scripts/framework/openhands-agent-server-provider.test.js` — new tests appended after the existing `extractWorkspace parses both prompt conventions` test (end of file, ~line 267), before the "Phase 07" T11/T11b/T12 block (keeps the new tests together as their own reviewable group rather than interleaving).
- Modify: `docs/design.md` — one sentence added to the "Daemon-Lifecycle Providers" section (line 367, the paragraph describing the wrapper provider's REST+WS contract) documenting the new watchdog and its env var.
- Modify: `docs/setup.md` — one sentence added after the existing "Model precedence (highest wins): ..." line (line 313) documenting the same, in the same prose style already used there for `OPENHANDS_SERVER_URL`/`OPENHANDS_MODEL_OVERRIDE`.

## Why `iterator.return?.()`, and why it must not be awaited

`for await...of` calls the iterator's `.return()` method automatically whenever the loop body exits early (`break`, `return`, an uncaught throw) — this is spec behavior, not an implementation detail, and it's what lets a generator's own `try/finally` cleanup run on early exit. The manual `Promise.race` loop this plan introduces replaces `for await...of`, so it must call `iterator.return?.()` itself on every exit path or it silently regresses that guarantee for any current or future `wsClient.connect().events` implementation that relies on it (`defaultWsClient()`'s generator has no such cleanup today, so this is currently a no-op in production, but the guarantee should not quietly disappear from the contract).

The call must be fire-and-forget (not `await`ed), and the reason is specific to this watchdog: on every exit path *except* the idle-timeout path, the most recent `iterator.next()` has already resolved by the time the loop decides to `break` — exactly like `for await...of`, so `.return()` runs immediately with nothing queued ahead of it. But on the idle-timeout path specifically, there is always exactly one outstanding, unresolved `iterator.next()` call (the one that lost the `Promise.race`) — and per async-iterator semantics, a `.return()` call issued while a `.next()` is still in flight is queued behind it and only runs once that `.next()` settles. Awaiting `.return()` here would therefore block turn conclusion on the very silence this watchdog exists to route around, defeating the feature. Calling it without awaiting preserves the cleanup contract for well-behaved generators without reintroducing the hang.

## Why a trajectory marker, not just a stderr log

The legacy provider only logs the stall to stderr; `trajectory.json` (which is what an engineer actually opens when debugging a fabricated/empty eval result — see the issue's own motivation, VD-3777/VD-3750) has no record that a stall occurred versus a clean finish. Pushing one `{ kind: 'idle_timeout', idle_ms }` entry costs one line and directly serves the issue's stated debuggability goal, which is stronger than literal stderr-only parity with the legacy provider. This is called out explicitly here so a reviewer can push back on it if it's considered scope creep — it is the one place this plan deliberately does more than "match legacy behavior."

---

### Task 1: Idle-timeout configuration — constant, helper, constructor resolution

**Files:**
- Modify: `scripts/framework/openhands-agent-server-provider.js`
- Test: `scripts/framework/openhands-agent-server-provider.test.js`

**Interfaces:**
- Produces: `OpenhandsAgentServerProvider.__private.DEFAULT_STREAM_IDLE_TIMEOUT_MS` (number, `900_000`), `OpenhandsAgentServerProvider.__private.positiveInteger(value)` (returns a positive finite number or `null`), and an instance property `provider.idleTimeoutMs` (number) set by the constructor. Task 2 consumes `this.idleTimeoutMs` inside `_runOnce`.

- [ ] **Step 1: Write the failing tests for idle-timeout resolution precedence**

Append to `scripts/framework/openhands-agent-server-provider.test.js`, after the `extractWorkspace parses both prompt conventions` test and before the `// --- Phase 07 ---` comment block:

```javascript
// ---------------------------------------------------------------------------
// VD-3814 — idle/stall watchdog
// ---------------------------------------------------------------------------

test('idleTimeoutMs defaults to DEFAULT_STREAM_IDLE_TIMEOUT_MS (15 min) when unset', () => {
  const previous = process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS;
  delete process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS;
  try {
    const provider = new OpenhandsAgentServerProvider({ config: {} });
    assert.equal(__private.DEFAULT_STREAM_IDLE_TIMEOUT_MS, 900_000);
    assert.equal(provider.idleTimeoutMs, __private.DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS;
    else process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS = previous;
  }
});

test('OPENHANDS_STREAM_IDLE_TIMEOUT_MS env overrides the default idle timeout', () => {
  const previous = process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS;
  process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS = '5000';
  try {
    const provider = new OpenhandsAgentServerProvider({ config: {} });
    assert.equal(provider.idleTimeoutMs, 5000);
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS;
    else process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS = previous;
  }
});

test('idleTimeoutMs constructor option wins over OPENHANDS_STREAM_IDLE_TIMEOUT_MS env', () => {
  const previous = process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS;
  process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS = '5000';
  try {
    const provider = new OpenhandsAgentServerProvider({ config: {}, idleTimeoutMs: 1234 });
    assert.equal(provider.idleTimeoutMs, 1234);
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS;
    else process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS = previous;
  }
});

test('positiveInteger rejects non-positive and non-numeric values', () => {
  assert.equal(__private.positiveInteger('0'), null);
  assert.equal(__private.positiveInteger('-5'), null);
  assert.equal(__private.positiveInteger('not-a-number'), null);
  assert.equal(__private.positiveInteger(undefined), null);
  assert.equal(__private.positiveInteger('250'), 250);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npm test 2>&1 | grep -A5 "VD-3814\|idleTimeoutMs\|positiveInteger"`

Expected: FAIL — `__private.DEFAULT_STREAM_IDLE_TIMEOUT_MS` and `__private.positiveInteger` are `undefined`, and `provider.idleTimeoutMs` is `undefined`, so every new assertion throws.

- [ ] **Step 3: Add the constant, helper, and constructor resolution**

In `scripts/framework/openhands-agent-server-provider.js`, immediately after the `DEFAULT_EVAL_MODE_PREAMBLE` block (ends `].join(' ');` at the current line 33) and before the `OPENCODE_GO_BASE_URL` comment, insert:

```javascript
// Idle/stall watchdog: if no WS stream event arrives for this many ms,
// conclude the turn with whatever partial output has been collected so far
// instead of hanging until the outer promptfoo timeout. Mirrors the
// STREAM_IDLE_TIMEOUT_MS floor rationale in the legacy scripts/openhands-provider.js
// this provider replaces — a cold Fabric/dbt build on a Spark session can be
// silent 5-10 min, so the floor must clear that. env-tunable via
// OPENHANDS_STREAM_IDLE_TIMEOUT_MS — same var name as the legacy provider, so
// one setting covers both providers during the -oh migration.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 900_000;

// Note: 0 is treated as "unset" here (falls through to env/default), not as
// "disable the watchdog" — nothing in this codebase needs disable semantics
// today. If that's ever needed, this precedence chain needs an explicit
// `options.idleTimeoutMs === 0` check before it, since `0 || fallback` would
// otherwise silently discard an intentional 0.
function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
```

Then in the `constructor(options = {})` (currently):

```javascript
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = options.id || 'openhands-agent-server';
    this.httpClient = options.httpClient || defaultHttpClient();
    this.wsClient = options.wsClient || defaultWsClient();
  }
```

change to:

```javascript
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = options.id || 'openhands-agent-server';
    this.httpClient = options.httpClient || defaultHttpClient();
    this.wsClient = options.wsClient || defaultWsClient();
    this.idleTimeoutMs =
      positiveInteger(options.idleTimeoutMs) ||
      positiveInteger(process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS) ||
      DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }
```

Finally, in `module.exports.__private` at the end of the file, add the two new entries:

```javascript
module.exports.__private = {
  DEFAULT_MICROAGENT_REL_PATH,
  DEFAULT_AGENT_SEMANTICS,
  DEFAULT_EVAL_MODE_PREAMBLE,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OPENCODE_GO_BASE_URL,
  buildOpenhandsRunMetadata,
  buildLlmPayload,
  deriveLitellmProvider,
  extractWorkspace,
  installMicroagent,
  positiveInteger,
  resolveAdapter,
  writeProviderRunMetadata,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -30`

Expected: PASS — all 4 new tests plus every pre-existing test in this file (the constructor change is additive; no existing test constructs a provider with an `idleTimeoutMs`-shaped option today, so none can collide with the new default).

- [ ] **Step 5: Commit**

```bash
git add scripts/framework/openhands-agent-server-provider.js scripts/framework/openhands-agent-server-provider.test.js
git commit -m "feat(openhands-agent-server-provider): add idle-timeout configuration (VD-3814)"
```

---

### Task 2: Idle watchdog in the event loop, with partial-output conclusion and a trajectory marker

**Files:**
- Modify: `scripts/framework/openhands-agent-server-provider.js`
- Test: `scripts/framework/openhands-agent-server-provider.test.js`
- Modify: `docs/design.md`, `docs/setup.md` (folded into this task's final step — one sentence each, no separate task needed for a two-line doc update)

**Interfaces:**
- Consumes: `this.idleTimeoutMs` from Task 1's constructor resolution.
- Produces: `_runOnce()` returns the same shape as before (`string`, joined `textParts`) on every path — clean terminal event, `FinishAction`, **or now also an idle stall** — and still throws only on `ConversationErrorEvent` / `execution_status=error` / non-2xx REST, exactly as before. `trajectory.json` gains one additional possible entry shape: `{ kind: 'idle_timeout', idle_ms: <number> }`.

- [ ] **Step 1: Write the failing tests for watchdog behavior**

Append to `scripts/framework/openhands-agent-server-provider.test.js`, in the same "VD-3814" section added in Task 1, after the `positiveInteger` test:

```javascript
test('idle watchdog concludes the turn with partial output, a trajectory marker, and a closed WS when the stream goes silent', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  let closeCalls = 0;
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 200, json: { id: 'c1' } }; } },
      idleTimeoutMs: 30,
      wsClient: {
        connect() {
          return {
            events: (async function* () {
              yield {
                kind: 'MessageEvent',
                source: 'agent',
                llm_message: { content: [{ type: 'text', text: 'partial' }] },
              };
              // Never yields again within the test's lifetime — the idle
              // watchdog (30ms) must fire long before this 500ms elapses.
              // .unref() keeps this dangling timer from blocking process exit
              // once the test (and the file's other tests) are done.
              await new Promise((resolve) => setTimeout(resolve, 500).unref());
            })(),
            close() {
              closeCalls += 1;
            },
          };
        },
      },
    });

    const start = Date.now();
    const result = await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);
    const elapsedMs = Date.now() - start;

    assert.deepEqual(result, { output: 'partial' });
    assert.ok(elapsedMs < 400, `expected the idle watchdog to fire well before 500ms, took ${elapsedMs}ms`);
    assert.equal(closeCalls, 1);
    const traj = JSON.parse(fs.readFileSync(path.join(suite.workspace, '.eval-run', 'trajectory.json'), 'utf8'));
    const marker = traj.find((e) => e.kind === 'idle_timeout');
    assert.ok(marker, 'expected an idle_timeout trajectory entry');
    assert.equal(marker.idle_ms, 30);
  } finally {
    suite.cleanup();
  }
});

test('idle watchdog resets on every stream event so a slow-but-steady stream is not cut short', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 200, json: { id: 'c1' } }; } },
      idleTimeoutMs: 100,
      wsClient: {
        connect() {
          return {
            events: (async function* () {
              yield {
                kind: 'MessageEvent',
                source: 'agent',
                llm_message: { content: [{ type: 'text', text: 'a' }] },
              };
              await new Promise((resolve) => setTimeout(resolve, 60).unref());
              yield {
                kind: 'MessageEvent',
                source: 'agent',
                llm_message: { content: [{ type: 'text', text: 'b' }] },
              };
              await new Promise((resolve) => setTimeout(resolve, 60).unref());
              yield { kind: 'ConversationStateUpdateEvent', key: 'execution_status', value: 'finished' };
            })(),
            close() {},
          };
        },
      },
    });

    const result = await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);
    assert.deepEqual(result, { output: 'ab' });
  } finally {
    suite.cleanup();
  }
});

test('clean terminal event still triggers iterator.return() (for-await-of parity)', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  let returnCalled = false;
  try {
    async function* generatorWithCleanup() {
      try {
        yield { kind: 'MessageEvent', source: 'agent', llm_message: { content: [{ type: 'text', text: 'done' }] } };
        yield { kind: 'ConversationStateUpdateEvent', key: 'execution_status', value: 'finished' };
      } finally {
        // A `for await...of` loop's automatic `iterator.return()` call is what
        // runs this `finally` on early exit. This test exists specifically to
        // confirm the manual Promise.race loop still triggers it.
        returnCalled = true;
      }
    }
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 200, json: { id: 'c1' } }; } },
      wsClient: { connect: () => generatorWithCleanup() },
    });

    const result = await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);

    assert.deepEqual(result, { output: 'done' });
    assert.equal(returnCalled, true, 'expected iterator.return() to run the generator finally block');
  } finally {
    suite.cleanup();
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail (or hang)**

Run: `npm test -- --test-timeout=5000 2>&1 | tail -40` (the `--test-timeout` flag bounds how long a still-hanging `for await` loop is allowed to block, since the unmodified loop never resolves on a silent stream)

Expected: FAIL — the first test (idle stall) times out or errors, since the current `for await` loop never returns while the fake stream stays silent; the third test (`iterator.return()` parity) fails its `returnCalled` assertion, since the current code has no `iterator.return?.()` call at all. The second test (reset-on-event) may coincidentally pass before Step 3, since its fake stream reaches a clean `finished` event on its own — that's fine; the important signal is the first and third tests failing.

- [ ] **Step 3: Rewrite the event-consumption loop with the idle watchdog**

In `scripts/framework/openhands-agent-server-provider.js`, inside `_runOnce()`, the current block (from `const textParts = [];` through the closing `if (terminalError) throw new Error(terminalError); return textParts.join('');`) is:

```javascript
    const textParts = [];
    const trajectory = [];
    let terminalError = null;

    const runDir = path.join(workspace, '.eval-run');
    try {
      // LOCKSTEP NOTE: real OpenHands 1.23.1 (pair-bumped from 1.21.1 on
      // 2026-05-26 — event kinds preserved across the bump) event kinds:
      // SystemPromptEvent, MessageEvent, ActionEvent, ObservationEvent,
      // ConversationStateUpdateEvent, ConversationErrorEvent. Final answers
      // ride on MessageEvent.llm_message.content (free-form assistant text)
      // OR ActionEvent with action.kind === 'FinishAction'. Terminal:
      // ConversationErrorEvent OR ConversationStateUpdateEvent with
      // key=execution_status and value in {error, finished, paused}.
      for await (const event of events) {
        trajectory.push(event);
        if (event.kind === 'MessageEvent' && event.source === 'agent') {
          const content = event.llm_message?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part.text === 'string') textParts.push(part.text);
            }
          }
        }
        if (event.kind === 'ActionEvent' && event.action?.kind === 'FinishAction') {
          const msg = event.action?.message;
          if (typeof msg === 'string' && msg.length > 0) textParts.push(msg);
        }
        if (event.kind === 'ConversationErrorEvent') {
          const code = event.code || 'OpenHandsError';
          const detail = event.detail || '';
          terminalError = `OpenHands ${code}: ${detail}`.trim();
          break;
        }
        if (event.kind === 'ConversationStateUpdateEvent' && event.key === 'execution_status') {
          if (event.value === 'finished' || event.value === 'paused') break;
          if (event.value === 'error') {
            if (!terminalError) terminalError = 'OpenHands execution_status=error (no ConversationErrorEvent)';
            break;
          }
        }
      }
    } finally {
      // Close the WS unconditionally — without this the live socket can keep
      // the Promptfoo Node process alive past the eval's result and stall
      // until the outer timeout fires.
      closeWs();
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'trajectory.json'),
        `${JSON.stringify(trajectory, null, 2)}\n`,
        'utf8',
      );
    }

    if (terminalError) throw new Error(terminalError);
    return textParts.join('');
```

Replace it with:

```javascript
    const textParts = [];
    const trajectory = [];
    let terminalError = null;

    const runDir = path.join(workspace, '.eval-run');
    try {
      // LOCKSTEP NOTE: real OpenHands 1.23.1 (pair-bumped from 1.21.1 on
      // 2026-05-26 — event kinds preserved across the bump) event kinds:
      // SystemPromptEvent, MessageEvent, ActionEvent, ObservationEvent,
      // ConversationStateUpdateEvent, ConversationErrorEvent. Final answers
      // ride on MessageEvent.llm_message.content (free-form assistant text)
      // OR ActionEvent with action.kind === 'FinishAction'. Terminal:
      // ConversationErrorEvent OR ConversationStateUpdateEvent with
      // key=execution_status and value in {error, finished, paused}.
      //
      // Idle/stall watchdog (VD-3814): manual iteration instead of
      // `for await` — see DEFAULT_STREAM_IDLE_TIMEOUT_MS above for why, and
      // the `iterator.return?.()` call in the `finally` block below for why
      // this loop must replicate `for await...of`'s automatic cleanup call.
      const iterator = events[Symbol.asyncIterator]();
      const IDLE_SIGNAL = Symbol('idle-timeout');
      for (;;) {
        const nextPromise = iterator.next();
        let idleTimer;
        const idlePromise = new Promise((resolve) => {
          idleTimer = setTimeout(() => resolve(IDLE_SIGNAL), this.idleTimeoutMs);
        });
        const raced = await Promise.race([nextPromise, idlePromise]);
        clearTimeout(idleTimer);

        if (raced === IDLE_SIGNAL) {
          process.stderr.write(
            `[openhands-agent-server-provider] no stream events for ${this.idleTimeoutMs}ms; concluding turn (idle)\n`,
          );
          trajectory.push({ kind: 'idle_timeout', idle_ms: this.idleTimeoutMs });
          break;
        }

        const { value: event, done } = raced;
        if (done) break;
        trajectory.push(event);
        if (event.kind === 'MessageEvent' && event.source === 'agent') {
          const content = event.llm_message?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part.text === 'string') textParts.push(part.text);
            }
          }
        }
        if (event.kind === 'ActionEvent' && event.action?.kind === 'FinishAction') {
          const msg = event.action?.message;
          if (typeof msg === 'string' && msg.length > 0) textParts.push(msg);
        }
        if (event.kind === 'ConversationErrorEvent') {
          const code = event.code || 'OpenHandsError';
          const detail = event.detail || '';
          terminalError = `OpenHands ${code}: ${detail}`.trim();
          break;
        }
        if (event.kind === 'ConversationStateUpdateEvent' && event.key === 'execution_status') {
          if (event.value === 'finished' || event.value === 'paused') break;
          if (event.value === 'error') {
            if (!terminalError) terminalError = 'OpenHands execution_status=error (no ConversationErrorEvent)';
            break;
          }
        }
      }
    } finally {
      // Close the WS unconditionally — without this the live socket can keep
      // the Promptfoo Node process alive past the eval's result and stall
      // until the outer timeout fires. On the idle-timeout path above, this
      // is also what lets the abandoned `iterator.next()` promise eventually
      // settle instead of leaking.
      closeWs();
      // `for await...of` calls `iterator.return()` automatically on early
      // exit; this manual loop must do the same so a wsClient generator with
      // its own try/finally cleanup still gets it. NOT awaited: on the
      // idle-timeout path there's already an outstanding `next()` call in
      // flight, and `.return()` issued while a `.next()` is pending only
      // settles after that `.next()` does — awaiting it here would block
      // turn conclusion on the same silence this watchdog exists to route
      // around. Errors are swallowed; a generator's own cleanup failing must
      // not fail the eval turn.
      iterator.return?.().catch(() => {});
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'trajectory.json'),
        `${JSON.stringify(trajectory, null, 2)}\n`,
        'utf8',
      );
    }

    if (terminalError) throw new Error(terminalError);
    return textParts.join('');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -40`

Expected: PASS — all 7 VD-3814 tests (4 from Task 1, 3 from this task) plus every pre-existing test in the file and the rest of the suite (`scripts/*.test.js`, `scripts/framework/*.test.js`). Confirm the previously-passing tests that exercise the happy path (`posts the documented OpenHands 1.23.1 REST payload shape`, `drains FinishAction text when MessageEvent is absent`, `surfaces ConversationErrorEvent as a provider error`, etc.) still pass unmodified — they don't set `idleTimeoutMs`, so they get the 900s default and never come close to it.

- [ ] **Step 5: Document the new watchdog in `docs/design.md` and `docs/setup.md`**

In `docs/design.md`, in the "Daemon-Lifecycle Providers" section, the paragraph currently reading:

```markdown
The wrapper provider (`scripts/framework/openhands-agent-server-provider.js`) speaks the documented OpenHands 1.21.x REST + WebSocket contract. It reads `OPENHANDS_SERVER_URL` from the env (non-empty string wins over `openhands.json:openhands_server_url`, which is now omitted from templates). Model precedence is `OPENHANDS_MODEL_OVERRIDE` (env) > `this.config.model` (resolver-injected) > `cfg.agent[agent].model` (openhands.json fallback). For manual debugging without the CLI, set `OPENHANDS_SERVER_URL` in the shell — the provider will speak to whatever 127.0.0.1 daemon you started by hand.
```

gets one sentence appended at the end:

```markdown
The wrapper provider (`scripts/framework/openhands-agent-server-provider.js`) speaks the documented OpenHands 1.21.x REST + WebSocket contract. It reads `OPENHANDS_SERVER_URL` from the env (non-empty string wins over `openhands.json:openhands_server_url`, which is now omitted from templates). Model precedence is `OPENHANDS_MODEL_OVERRIDE` (env) > `this.config.model` (resolver-injected) > `cfg.agent[agent].model` (openhands.json fallback). For manual debugging without the CLI, set `OPENHANDS_SERVER_URL` in the shell — the provider will speak to whatever 127.0.0.1 daemon you started by hand. If the WS event stream goes silent for `OPENHANDS_STREAM_IDLE_TIMEOUT_MS` ms (default 900000 / 15 min), the provider concludes the turn with whatever partial output it has collected instead of hanging until the outer promptfoo timeout — the same watchdog behavior as the legacy `openhands-provider.js` this provider is replacing (VD-3814).
```

In `docs/setup.md`, the line currently reading:

```markdown
Model precedence (highest wins): `OPENHANDS_MODEL_OVERRIDE` env > the `model` field on the provider in `eval-tiers.toml` > `agent.<tier>.model` in `openhands.json`.
```

gets one sentence appended immediately after it (same paragraph, before the blank line):

```markdown
Model precedence (highest wins): `OPENHANDS_MODEL_OVERRIDE` env > the `model` field on the provider in `eval-tiers.toml` > `agent.<tier>.model` in `openhands.json`. If the stream produces no event for `OPENHANDS_STREAM_IDLE_TIMEOUT_MS` ms (default `900000`), the provider concludes the turn with its partial output rather than hanging until the outer promptfoo timeout — set this env var to raise the floor for a lane with legitimately longer silent gaps.
```

- [ ] **Step 6: Run the markdown lint and the full test suite one more time**

Run: `npm run lint:md 2>&1 | tail -20 && npm test 2>&1 | tail -10`

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/framework/openhands-agent-server-provider.js scripts/framework/openhands-agent-server-provider.test.js docs/design.md docs/setup.md
git commit -m "feat(openhands-agent-server-provider): add idle/stall watchdog matching legacy openhands-provider.js (VD-3814)"
```

---

## Out of scope

- Changing the legacy `openhands-provider.js` in `vibedata-data-engineering` — it already has this behavior; this plan only brings the new provider to parity.
- `OPENHANDS_TRAJECTORY_HEARTBEAT_MS`-style mid-run trajectory syncing for the docker-runtime case (VD-3777) — the agent-server provider has no docker-runtime/cross-uid split today; if one is added later, that heartbeat is a separate concern from this idle watchdog.
- Making the idle-timeout value configurable per-tier through `openhands.json`/`eval-tiers.toml` (i.e. a `stream_idle_timeout_ms` field alongside `model`/`steps`) — the env var already gives a single global knob, matching the legacy provider's own scope; a per-tier field can be added later if a consumer actually needs different floors for different tiers, but nothing in the issue asks for that.
