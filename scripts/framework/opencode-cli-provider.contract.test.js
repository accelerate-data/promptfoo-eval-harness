'use strict';

/**
 * Layer 2 contract test for opencode-cli-provider.js (spec §8.3, C.13).
 *
 * TDD discipline: written BEFORE the C.14 refactor so that the sections
 * testing new contract shape (init/turn/finalize/shutdown) fail against
 * the current provider, providing the green-light signal for refactoring.
 *
 * Section 1 — Lifecycle (init → turn ×N → finalize → shutdown)
 * Section 2 — vars.turns invariants (via bridge / validator, not raw provider)
 * Section 3 — §7.4 five behaviors (env, argv, exit-code, mock-mode, redaction)
 * Section 4 — Regression cases mined from git log
 *
 * §7.4 five behaviors tracked by line numbers in C.14-refactored provider:
 *   B1: env passthrough (OPENCODE_CONFIG, XDG_STATE_HOME, process.env spread)
 *   B2: argv shape (opencode run --agent ... --dir ... --format ... --log-level ... <prompt>)
 *   B3: exit-code mapping (0 → success, non-zero → error)
 *   B4: mock-mode bypass (OPENCODE_MOCK_MODE=1 → canned response, no spawn)
 *   B5: redaction-friendly logging (no secret-shaped env values in thrown messages)
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDER_PATH = path.resolve(__dirname, 'opencode-cli-provider.js');

/** Clear require cache so each test group loads a fresh module. */
function loadProvider() {
  delete require.cache[PROVIDER_PATH];
  return require(PROVIDER_PATH);
}

/** Minimal valid config for the provider (all required fields). */
const VALID_CONFIG = {
  agent: 'eval_light',
  opencode_config: '/suite/opencode.json',
  project_dir: '/repo',
  format: 'json',
  log_level: 'WARN',
};

/** A runner that immediately returns a canned response. */
function makeSuccessRunner(output = 'canned response') {
  return async () => output;
}

/** A runner that records calls and returns a canned response. */
function makeRecordingRunner(output = 'canned response') {
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, options });
    return output;
  };
  runner.calls = calls;
  return runner;
}

/** A runner that rejects with an error (simulates non-zero exit). */
function makeFailingRunner(message = 'opencode exited with code 1') {
  return async () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Section 1 — Lifecycle: init → turn(s) → finalize → shutdown
// ---------------------------------------------------------------------------

describe('Section 1 — Lifecycle (spec §1.2)', () => {
  test('provider exports init, turn, finalize, shutdown functions', () => {
    const OpenCodeCliProvider = loadProvider();
    assert.strictEqual(typeof OpenCodeCliProvider.init, 'function', 'init must be exported');
    assert.strictEqual(typeof OpenCodeCliProvider.turn, 'function', 'turn must be exported');
    assert.strictEqual(typeof OpenCodeCliProvider.finalize, 'function', 'finalize must be exported');
    assert.strictEqual(typeof OpenCodeCliProvider.shutdown, 'function', 'shutdown must be exported');
  });

  test('init(cfg) returns a Session object (opaque handle)', async () => {
    const { init } = loadProvider();
    const session = await init(VALID_CONFIG);
    assert.ok(session !== null && session !== undefined, 'init must return a session');
    assert.strictEqual(typeof session, 'object', 'session must be an object');
  });

  test('init with missing required config field throws or returns error', async () => {
    const { init } = loadProvider();
    // missing agent field
    try {
      const session = await init({ ...VALID_CONFIG, agent: '' });
      // If it doesn't throw, the session should be usable but turn should fail
      // Accept either behavior — the contract allows validation at init or turn time
      assert.ok(session !== undefined);
    } catch (e) {
      assert.ok(e instanceof Error, 'must throw an Error');
    }
  });

  test('turn(session, input) returns {output} shape on success', async () => {
    const { init, turn } = loadProvider();
    const session = await init({ ...VALID_CONFIG, _runner: makeSuccessRunner('hello world') });
    const result = await turn(session, 'what is 2+2?');
    assert.ok(typeof result === 'object', 'turn must return an object');
    assert.ok('output' in result || 'error' in result, 'turn result must have output or error');
    if (!result.error) {
      assert.strictEqual(typeof result.output, 'string', 'output must be a string');
    }
  });

  test('turn(session, input) returns {error} shape on provider failure', async () => {
    const { init, turn } = loadProvider();
    const session = await init({ ...VALID_CONFIG, _runner: makeFailingRunner('opencode exited with code 2') });
    const result = await turn(session, 'prompt');
    assert.ok('error' in result, 'failed turn must have error field');
    assert.strictEqual(typeof result.error, 'string', 'error must be a string');
  });

  test('finalize(session) returns FinalResult shape', async () => {
    const { init, turn, finalize } = loadProvider();
    const session = await init({ ...VALID_CONFIG, _runner: makeSuccessRunner('response') });
    await turn(session, 'hello');
    const result = await finalize(session);
    assert.ok(typeof result === 'object', 'finalize must return an object');
    // FinalResult: { final_text, turns_completed, tool_calls, metadata }
    assert.ok('turns_completed' in result, 'finalize result must have turns_completed');
    assert.strictEqual(typeof result.turns_completed, 'number', 'turns_completed must be a number');
  });

  test('shutdown(session) is idempotent (second call is a no-op)', async () => {
    const { init, shutdown } = loadProvider();
    const session = await init({ ...VALID_CONFIG, _runner: makeSuccessRunner() });
    // First shutdown
    await shutdown(session);
    // Second shutdown must not throw
    await assert.doesNotReject(
      () => shutdown(session),
      'shutdown must be idempotent — second call must not throw',
    );
  });

  test('full lifecycle: init → turn ×2 → finalize → shutdown', async () => {
    const { init, turn, finalize, shutdown } = loadProvider();
    let callCount = 0;
    const runner = async () => {
      callCount += 1;
      return `response ${callCount}`;
    };

    const session = await init({ ...VALID_CONFIG, _runner: runner });
    const r1 = await turn(session, 'first');
    const r2 = await turn(session, 'second');
    const final = await finalize(session);
    await shutdown(session);

    assert.ok(!r1.error, `first turn failed: ${r1.error}`);
    assert.ok(!r2.error, `second turn failed: ${r2.error}`);
    assert.strictEqual(typeof final.turns_completed, 'number');
    assert.ok(final.turns_completed >= 1, 'finalize should report at least 1 turn');
  });
});

// ---------------------------------------------------------------------------
// Section 2 — vars.turns invariants
// (tested via bridge / validator per phase doc — provider receives raw input string)
// ---------------------------------------------------------------------------

describe('Section 2 — vars.turns invariants (via bridge, spec §3)', () => {
  // Per phase doc: vars.turns validation lives in the BRIDGE (and phase 04 validator),
  // NOT the provider. These tests confirm the bridge/validator rejects invalid inputs
  // before the provider is reached.

  let makeBridge;
  before(() => {
    makeBridge = require('./_node_bridge.js');
  });

  function bridgeWith(turns, runner) {
    // Build a provider config that wires our recording runner
    const bridge = makeBridge({
      config: {
        provider_kind: 'opencode_cli',
        provider_label: 'test',
        agent: 'eval_light',
        opencode_config: '/suite/opencode.json',
        project_dir: '/repo',
        format: 'json',
        log_level: 'WARN',
        _runner: runner,
      },
    });
    const context = { vars: { turns } };
    return bridge.callApi('fallback-prompt', context);
  }

  test('vars.turns = ["hello"] (length 1) is accepted', async () => {
    const runner = makeSuccessRunner('ok');
    const result = await bridgeWith(JSON.stringify(['hello']), runner);
    // May have error from missing required config fields (agent etc. not in provider_kind path)
    // but must NOT be a validation rejection about turns length
    if (result.error) {
      assert.ok(
        !result.error.includes('multi-turn'),
        `single-turn must not be rejected as multi-turn: ${result.error}`,
      );
    }
  });

  test('vars.turns = ["a","b"] (length > 1) is rejected with multi-turn error', async () => {
    const result = await bridgeWith(JSON.stringify(['a', 'b']), makeSuccessRunner());
    assert.ok(result.error, 'multi-turn must be rejected');
    assert.ok(
      result.error.includes('multi-turn') || result.error.toLowerCase().includes('not supported'),
      `error must mention multi-turn: ${result.error}`,
    );
  });

  test('vars.turns = [] (empty) is rejected', async () => {
    const result = await bridgeWith(JSON.stringify([]), makeSuccessRunner());
    assert.ok(result.error, 'empty turns must be rejected');
  });

  test('vars.turns = [undefined] is rejected', async () => {
    // JSON.stringify([undefined]) produces "[null]" — which parseTurns sees as a usable
    // array but with a null element → bridge noUsableTurn check fires
    const result = await bridgeWith(JSON.stringify([undefined]), makeSuccessRunner());
    assert.ok(result.error, '[undefined] turns must produce an error');
  });

  test('validate-package-config rejects opencode_cli turns.length > 1', () => {
    const { validate } = require('./validate-package-config');
    const KIND_REGISTRY = require('./_node_bridge.js')._KIND_REGISTRY;
    const result = validate(
      {
        tiers: {
          light: {
            providers: [{ provider_kind: 'opencode_cli' }],
            tests: [{ vars: { turns: ['a', 'b'] } }],
          },
        },
      },
      { kindRegistry: KIND_REGISTRY },
    );
    assert.strictEqual(result.ok, false, 'validator must reject multi-turn for opencode_cli');
    const multiTurnError = result.errors.find(
      (e) => e.message.includes('opencode_cli') || e.message.includes('§3.1'),
    );
    assert.ok(multiTurnError, `must have an opencode_cli multi-turn error: ${JSON.stringify(result.errors)}`);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — §7.4 five behaviors
// ---------------------------------------------------------------------------

describe('Section 3 — §7.4 five behaviors', () => {
  // B1: env passthrough
  test('B1: turn passes OPENCODE_CONFIG and XDG_STATE_HOME to runner env', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('env test output');
    const session = await init({
      ...VALID_CONFIG,
      opencode_config: '/custom/opencode.json',
      _runner: runner,
    });
    await turn(session, 'env test');
    assert.ok(runner.calls.length > 0, 'runner must have been called');
    const { options } = runner.calls[0];
    assert.ok('OPENCODE_CONFIG' in options.env, 'OPENCODE_CONFIG must be in env');
    assert.ok('XDG_STATE_HOME' in options.env, 'XDG_STATE_HOME must be in env');
  });

  test('B1: ANTHROPIC_API_KEY from process.env is forwarded via spread', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('ok');
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake-key-for-env-passthrough';
    try {
      const session = await init({ ...VALID_CONFIG, _runner: runner });
      await turn(session, 'test');
      assert.ok(runner.calls.length > 0, 'runner must be called');
      assert.strictEqual(
        runner.calls[0].options.env.ANTHROPIC_API_KEY,
        'sk-test-fake-key-for-env-passthrough',
        'ANTHROPIC_API_KEY must be forwarded to child process env',
      );
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  // B2: argv shape
  test('B2: argv shape — opencode run --agent --dir --format --log-level <prompt>', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('argv snapshot output');
    const session = await init({
      ...VALID_CONFIG,
      agent: 'eval_standard',
      format: 'json',
      log_level: 'WARN',
      _runner: runner,
    });
    await turn(session, 'the prompt text');
    assert.ok(runner.calls.length > 0, 'runner must be called');
    const { args } = runner.calls[0];
    // Snapshot: ['run', '--agent', 'eval_standard', '--dir', <projectDir>, '--format', 'json', '--log-level', 'WARN', 'the prompt text']
    assert.strictEqual(args[0], 'run', 'first arg must be "run"');
    assert.strictEqual(args[1], '--agent', 'second arg must be "--agent"');
    assert.strictEqual(args[2], 'eval_standard', 'third arg must be agent name');
    assert.strictEqual(args[3], '--dir', 'fourth arg must be "--dir"');
    // args[4] is the resolved project dir
    assert.strictEqual(args[5], '--format', 'sixth arg must be "--format"');
    assert.strictEqual(args[6], 'json', 'seventh arg must be format value');
    assert.strictEqual(args[7], '--log-level', 'eighth arg must be "--log-level"');
    assert.strictEqual(args[8], 'WARN', 'ninth arg must be log_level value');
    assert.strictEqual(args[args.length - 1], 'the prompt text', 'last arg must be the prompt');
  });

  test('B2: --print-logs appended when print_logs=true', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('ok');
    const session = await init({ ...VALID_CONFIG, print_logs: true, _runner: runner });
    await turn(session, 'hello');
    const { args } = runner.calls[0];
    assert.ok(args.includes('--print-logs'), 'argv must include --print-logs when print_logs=true');
  });

  test('B2: --print-logs NOT appended when print_logs=false', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('ok');
    const session = await init({ ...VALID_CONFIG, print_logs: false, _runner: runner });
    await turn(session, 'hello');
    const { args } = runner.calls[0];
    assert.ok(!args.includes('--print-logs'), 'argv must NOT include --print-logs when print_logs=false');
  });

  // B3: exit-code mapping
  test('B3: exit code 0 → turn returns {output}', async () => {
    const { init, turn } = loadProvider();
    const session = await init({ ...VALID_CONFIG, _runner: makeSuccessRunner('exit-0-output') });
    const result = await turn(session, 'test');
    assert.ok(!result.error, `exit 0 must not produce error: ${result.error}`);
    assert.strictEqual(result.output, 'exit-0-output', 'output must match runner return');
  });

  test('B3: non-zero exit code → turn returns {error}', async () => {
    const { init, turn } = loadProvider();
    const runner = makeFailingRunner('opencode exited with code 1');
    const session = await init({ ...VALID_CONFIG, _runner: runner });
    const result = await turn(session, 'test');
    assert.ok(result.error, 'non-zero exit must produce error');
    assert.ok(
      result.error.includes('opencode exited with code 1') || result.error.length > 0,
      'error message must be meaningful',
    );
  });

  test('B3: runner error message is propagated verbatim', async () => {
    const { init, turn } = loadProvider();
    const runner = makeFailingRunner('stderr: authentication failed');
    const session = await init({ ...VALID_CONFIG, _runner: runner });
    const result = await turn(session, 'test');
    assert.ok(result.error.includes('stderr: authentication failed'), 'runner error must propagate verbatim');
  });

  // B4: mock-mode bypass
  test('B4: OPENCODE_MOCK_MODE=1 returns canned response without calling runner', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('real response — must not be called');
    const prev = process.env.OPENCODE_MOCK_MODE;
    process.env.OPENCODE_MOCK_MODE = '1';
    try {
      const session = await init({ ...VALID_CONFIG, _runner: runner });
      const result = await turn(session, 'hello mock');
      // Must not have called the real runner
      assert.strictEqual(runner.calls.length, 0, 'runner must NOT be called in mock mode');
      // Must return something (canned response or stub)
      assert.ok(!result.error || result.output !== undefined, 'mock mode must return a usable result');
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_MOCK_MODE;
      else process.env.OPENCODE_MOCK_MODE = prev;
    }
  });

  // B5: redaction-friendly logging
  test('B5: error messages do not leak secret-shaped env values', async () => {
    const { init, turn } = loadProvider();
    const secretKey = 'sk-ant-SUPERSECRETKEY12345678901234567890';
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = secretKey;
    const runner = makeFailingRunner('opencode: tool error — see logs');
    try {
      const session = await init({ ...VALID_CONFIG, _runner: runner });
      const result = await turn(session, 'probe');
      // The error message returned by the provider must not contain the secret key
      if (result.error) {
        assert.ok(
          !result.error.includes(secretKey),
          `error message must not contain ANTHROPIC_API_KEY value: "${result.error}"`,
        );
      }
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Section 4 — Regression cases (mined from git log)
// ---------------------------------------------------------------------------

describe('Section 4 — Regression cases', () => {
  // The opencode-cli-provider.js was created in a single commit
  // (feat: implement promptfoo eval harness framework package).
  // No subsequent bug-fix commits were found for this file.
  // The following regression cases are derived from the spec's change-log
  // notes (§2.6 fix-log) which document bugs caught during review:

  // Regression: empty-output retry logic (empty string after trim)
  test('REG-1: empty output retried up to configured count before failing', async () => {
    const { init, turn } = loadProvider();
    let calls = 0;
    const runner = async () => {
      calls += 1;
      if (calls <= 1) return '   '; // whitespace-only on first attempt
      return 'second attempt output';
    };
    const session = await init({
      ...VALID_CONFIG,
      empty_output_retries: 1,
      _runner: runner,
    });
    const result = await turn(session, 'test');
    assert.ok(!result.error, `with 1 retry allowed, second attempt should succeed: ${result.error}`);
    assert.strictEqual(result.output, 'second attempt output');
    assert.strictEqual(calls, 2, 'runner must be called twice (1 empty + 1 retry)');
  });

  test('REG-2: exhausted retries return error (not empty output)', async () => {
    const { init, turn } = loadProvider();
    const runner = async () => '  '; // always empty
    const session = await init({
      ...VALID_CONFIG,
      empty_output_retries: 1,
      _runner: runner,
    });
    const result = await turn(session, 'test');
    assert.ok(result.error, 'exhausted retries must produce an error');
    assert.ok(result.error.includes('empty output'), `error must mention empty output: ${result.error}`);
  });

  test('REG-3: invalid empty_output_retries (negative) is rejected', async () => {
    const { init, turn } = loadProvider();
    const runner = makeSuccessRunner('ok');
    const session = await init({
      ...VALID_CONFIG,
      empty_output_retries: -1,
      _runner: runner,
    });
    const result = await turn(session, 'test');
    assert.ok(result.error, 'negative retry count must produce error');
    assert.ok(
      result.error.includes('non-negative integer') || result.error.includes('empty_output_retries'),
      `error must describe the constraint: ${result.error}`,
    );
  });

  test('REG-4: missing required config field returns error without throwing', async () => {
    const { init, turn } = loadProvider();
    const runner = makeSuccessRunner('ok');
    const session = await init({
      // intentionally omit 'agent'
      opencode_config: '/suite/opencode.json',
      project_dir: '/repo',
      format: 'json',
      log_level: 'WARN',
      _runner: runner,
    });
    const result = await turn(session, 'probe');
    assert.ok(result.error, 'missing required field must produce error (not throw)');
    assert.ok(
      result.error.includes('agent') || result.error.includes('requires'),
      `error must name the missing field: ${result.error}`,
    );
  });

  test('REG-5: XDG_STATE_HOME is preserved from env when already set', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('ok');
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = '/custom/state/home';
    try {
      const session = await init({ ...VALID_CONFIG, _runner: runner });
      await turn(session, 'test');
      assert.strictEqual(
        runner.calls[0].options.env.XDG_STATE_HOME,
        '/custom/state/home',
        'pre-existing XDG_STATE_HOME must not be overridden',
      );
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });

  test('REG-6: XDG_STATE_HOME defaults to .tmp/opencode-state when not set', async () => {
    const { init, turn } = loadProvider();
    const runner = makeRecordingRunner('ok');
    const prev = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;
    try {
      const session = await init({ ...VALID_CONFIG, _runner: runner });
      await turn(session, 'test');
      assert.ok(
        runner.calls[0].options.env.XDG_STATE_HOME.includes('.tmp/opencode-state') ||
        runner.calls[0].options.env.XDG_STATE_HOME.includes('opencode-state'),
        `XDG_STATE_HOME must default to opencode-state path: ${runner.calls[0].options.env.XDG_STATE_HOME}`,
      );
    } finally {
      if (prev === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prev;
    }
  });
});
