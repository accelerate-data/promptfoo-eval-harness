'use strict';

/**
 * Phase 11 — Layer 2 callApi round-trip for the opencode_sdk in-proc kind.
 *
 * Mirrors `_node_bridge.openhands_sdk.test.js` for the Node SDK path. Spawns
 * a child Node process with `--import` pointing at the mock loader hook so
 * that `await import('@opencode-ai/sdk')` inside the provider resolves to
 * `tests/_mock_opencode_sdk/sdk.mjs`. The child runs `_test_runner.cjs`,
 * which drives a real HarnessBridgeProvider end-to-end and prints the
 * result JSON to stdout. This test does NOT need Node 20 features in the
 * parent process — only the child gets the ESM loader hook.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REGISTER = path.resolve(__dirname, '..', '..', 'tests', '_mock_opencode_sdk', 'register.mjs');
const RUNNER = path.resolve(__dirname, 'providers', 'opencode_sdk', '_test_runner.cjs');

function runRunner(req, { scenario = 'happy', extraEnv = {} } = {}) {
  const result = spawnSync(process.execPath, ['--import', REGISTER, RUNNER], {
    encoding: 'utf8',
    input: JSON.stringify(req),
    env: {
      ...process.env,
      OPENCODE_SDK_MOCK_SCENARIO: scenario,
      AD_EVALS_RUN_ID: process.env.AD_EVALS_RUN_ID || 'opencode_sdk-test',
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(`runner exited ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('opencode_sdk: single-turn happy path returns greeting and metadata', () => {
  const out = runRunner({ turns: ['hello world'] });
  assert.equal(out.error, undefined, `unexpected error: ${out.error}`);
  assert.equal(out.metadata.turns_completed, 1);
  assert.match(out.output, /Hi there!/);
  assert.equal(out.metadata.transcript.length, 1);
  assert.equal(typeof out.metadata.cost_usd, 'number');
  assert.ok(out.metadata.tokens && typeof out.metadata.tokens === 'object');
});

test('opencode_sdk: multi-turn dependency — turn 2 recalls remembered number', () => {
  const out = runRunner({ turns: ['Please remember 42 for me.', 'what number was it?'] });
  assert.equal(out.error, undefined, `unexpected error: ${out.error}`);
  assert.equal(out.metadata.turns_completed, 2);
  assert.equal(out.metadata.transcript.length, 2);
  assert.match(out.metadata.transcript[0].output, /remember 42/);
  assert.match(out.metadata.transcript[1].output, /42/);
});

test('opencode_sdk: startup timeout surfaces STARTUP_TIMEOUT', () => {
  const out = runRunner({ turns: ['hi'] }, { scenario: 'startup_timeout' });
  assert.ok(out.error, 'expected error');
  assert.equal(out.metadata.provider_error.code, 'STARTUP_TIMEOUT');
  assert.equal(out.metadata.provider_error.retryable, false);
});

test('opencode_sdk: SDK auth failure surfaces AUTH', () => {
  const out = runRunner({ turns: ['hi'] }, { scenario: 'auth' });
  assert.ok(out.error, 'expected error');
  assert.equal(out.metadata.provider_error.code, 'AUTH');
  assert.equal(out.metadata.provider_error.retryable, false);
});

test('opencode_sdk: unsupported agent surfaces UNSUPPORTED_AGENT', () => {
  const out = runRunner({ turns: ['hi'], agent: 'wizard' });
  assert.ok(out.error, 'expected error');
  assert.equal(out.metadata.provider_error.code, 'UNSUPPORTED_AGENT');
  assert.equal(out.metadata.provider_error.retryable, false);
});

test('opencode_sdk: agent and model pass through to the SDK session', () => {
  const out = runRunner({ turns: ['describe yourself'], agent: 'plan', model: 'openai/gpt-4o' });
  assert.equal(out.error, undefined, `unexpected error: ${out.error}`);
  assert.equal(out.metadata.turns_completed, 1);
});
