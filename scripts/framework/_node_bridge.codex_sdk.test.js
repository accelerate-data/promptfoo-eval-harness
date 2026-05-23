'use strict';

/**
 * Phase 12 — Layer 2 callApi round-trip for the codex_sdk in-proc kind.
 *
 * Mirrors `_node_bridge.opencode_sdk.test.js` for the Codex SDK path. The
 * difference: @openai/codex-sdk is CJS, so the mock uses a
 * `Module._resolveFilename` hook installed via `--require`. The hook lives
 * at `tests/_mock_codex_sdk/register.js` and remaps the bare specifier to
 * `tests/_mock_codex_sdk/index.js` — that way the real package does not
 * need to be installed for these tests.
 *
 * The child runs `_test_runner.cjs`, which drives a real
 * HarnessBridgeProvider through the codex_sdk KIND_REGISTRY entry. The
 * parent process here does not need the mock — only the child does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REGISTER = path.resolve(__dirname, '..', '..', 'tests', '_mock_codex_sdk', 'register.js');
const RUNNER = path.resolve(__dirname, 'providers', 'codex_sdk', '_test_runner.cjs');

function runRunner(req, { scenario = 'happy', extraEnv = {} } = {}) {
  const result = spawnSync(process.execPath, ['--require', REGISTER, RUNNER], {
    encoding: 'utf8',
    input: JSON.stringify(req),
    env: {
      ...process.env,
      CODEX_SDK_MOCK_SCENARIO: scenario,
      AD_EVALS_RUN_ID: process.env.AD_EVALS_RUN_ID || 'codex_sdk-test',
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(`runner exited ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

test('codex_sdk: single-turn happy path returns greeting + tokens metadata', () => {
  const out = runRunner({ turns: ['hello world'] });
  assert.equal(out.error, undefined, `unexpected error: ${out.error}`);
  assert.equal(out.metadata.turns_completed, 1);
  assert.match(out.output, /Hi there!/);
  assert.equal(out.metadata.transcript.length, 1);
  assert.ok(out.metadata.tokens && typeof out.metadata.tokens === 'object');
  assert.equal(typeof out.metadata.tokens.total, 'number');
  assert.ok(out.metadata.tokens.total > 0, 'expected tokens.total > 0');
});

test('codex_sdk: multi-turn dependency — turn 2 recalls remembered number', () => {
  const out = runRunner({ turns: ['Please remember 42 for me.', 'what number was it?'] });
  assert.equal(out.error, undefined, `unexpected error: ${out.error}`);
  assert.equal(out.metadata.turns_completed, 2);
  assert.equal(out.metadata.transcript.length, 2);
  assert.match(out.metadata.transcript[0].output, /remember 42/);
  assert.match(out.metadata.transcript[1].output, /42/);
});

test('codex_sdk: auth scenario surfaces AUTH (retryable=false)', () => {
  const out = runRunner({ turns: ['hi'] }, { scenario: 'auth' });
  assert.ok(out.error, 'expected error');
  assert.equal(out.metadata.provider_error.code, 'AUTH');
  assert.equal(out.metadata.provider_error.retryable, false);
});

test('codex_sdk: rate_limit scenario surfaces rate_limit (retryable=true)', () => {
  const out = runRunner({ turns: ['hi'] }, { scenario: 'rate_limit' });
  assert.ok(out.error, 'expected error');
  assert.equal(out.metadata.provider_error.code, 'rate_limit');
  assert.equal(out.metadata.provider_error.retryable, true);
});

test('codex_sdk: unsupported_model scenario surfaces UNSUPPORTED_MODEL (retryable=false)', () => {
  const out = runRunner({ turns: ['hi'] }, { scenario: 'unsupported_model' });
  assert.ok(out.error, 'expected error');
  assert.equal(out.metadata.provider_error.code, 'UNSUPPORTED_MODEL');
  assert.equal(out.metadata.provider_error.retryable, false);
});

test('codex_sdk: sandbox_mode + reasoning_effort pass through and case completes', () => {
  const out = runRunner({
    turns: ['describe yourself'],
    model: 'gpt-4o',
    sandbox_mode: 'workspace-write',
    reasoning_effort: 'high',
  });
  assert.equal(out.error, undefined, `unexpected error: ${out.error}`);
  assert.equal(out.metadata.turns_completed, 1);
});
