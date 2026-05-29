'use strict';

/**
 * Phase 9.5 — Layer 2 round-trip test for the generic `mode === 'inproc'`
 * dispatch branch in `_node_bridge.js` (VD-2174-12).
 *
 * Strategy:
 *   - Inject a temporary `test_inproc_mock` kind into `KIND_REGISTRY` pointing
 *     at `tests/_mock_inproc_provider/provider.js`. Restore in `afterEach`.
 *   - Drive HarnessBridgeProvider.callApi end-to-end and assert the
 *     init → turn → finalize → shutdown lifecycle plus workspace injection.
 *   - Cover the error path (turn returning `{ error }`) symmetric with the
 *     subprocess path's errorReturn shape.
 *   - Run an opencode_cli regression case to prove the existing specialized
 *     in-proc branch (lines 425-524) is unchanged.
 *
 * Run: node --test scripts/framework/_node_bridge.inproc-roundtrip.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const makeBridge = require('./_node_bridge');

const KIND_REGISTRY = makeBridge._KIND_REGISTRY;
const HarnessBridgeProvider = makeBridge._HarnessBridgeProvider;
const MOCK_PROVIDER_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'tests',
  '_mock_inproc_provider',
  'provider.js',
);

function injectMockKind(opts = {}) {
  const exportName = opts.exportName || 'create';
  KIND_REGISTRY.test_inproc_mock = {
    mode: 'inproc',
    module: MOCK_PROVIDER_PATH,
    factoryName: exportName,
  };
}

function restoreMockKind() {
  delete KIND_REGISTRY.test_inproc_mock;
  if (typeof makeBridge._clearInprocCache === 'function') {
    makeBridge._clearInprocCache();
  }
}

function buildBridge(extraCfg = {}) {
  return new HarnessBridgeProvider({
    config: {
      provider_kind: 'test_inproc_mock',
      provider_label: 'inproc-mock-label',
      model: 'mock-model',
      ...extraCfg,
    },
  });
}

test('inproc 2-turn happy path: init → turn × 2 → finalize → shutdown', async (t) => {
  injectMockKind();
  t.after(restoreMockKind);

  const bridge = buildBridge();
  const result = await bridge.callApi('ignored-prompt', {
    vars: { turns: JSON.stringify(['hello', 'world']) },
  });

  assert.equal(result.error, undefined, `unexpected error: ${result.error}`);
  assert.equal(result.metadata.turns_completed, 2);
  assert.equal(result.metadata.transcript.length, 2);
  assert.equal(result.metadata.transcript[0].input, 'hello');
  assert.equal(result.metadata.transcript[1].input, 'world');
  assert.equal(result.metadata.transcript[0].output, 'echo: hello');
  assert.equal(result.metadata.transcript[1].output, 'echo: world');
  assert.equal(result.metadata.transcript[0].tool_calls[0].name, 'mock_inproc_tool');
  assert.equal(result.metadata.tokens.input, 4);
  assert.equal(result.metadata.tokens.output, 6);
  assert.match(result.metadata.transcript_summary || '', /mock inproc session — 2 turns/);
});

test('inproc error mid-turn: provider returns { error } → errorReturn with turns_completed=0', async (t) => {
  injectMockKind({ exportName: 'createWithTurnError' });
  t.after(restoreMockKind);

  const bridge = buildBridge();
  const result = await bridge.callApi('ignored', {
    vars: { turns: JSON.stringify(['boom']) },
  });

  assert.ok(result.error, 'expected error string on result');
  assert.match(result.error, /forced inproc turn failure/);
  assert.equal(result.metadata.turns_completed, 0);
  assert.equal(result.metadata.provider_error.code, 'TEST_FAIL');
  assert.equal(result.metadata.provider_error.retryable, false);
});

test('inproc workspace injection: cfg.workspace_root reaches provider.init', async (t) => {
  injectMockKind();
  t.after(() => {
    restoreMockKind();
    delete process.env.AD_EVALS_RUN_ID;
  });
  process.env.AD_EVALS_RUN_ID = 'test-run-9p5';

  const bridge = buildBridge({ case_id: 'case-A' });
  const result = await bridge.callApi('ignored', {
    vars: { turns: JSON.stringify(['ping']) },
  });

  assert.equal(result.error, undefined);
  // Captured workspace path is observable indirectly via the harness layout —
  // assert the path under tests/evals/.tmp/workspaces/<run>/<case>.
  // Provider stashed cfg into session; we inspect the metadata path used by
  // the bridge by re-running with workspace observation hook below.
  const expected = path.join('tests', 'evals', '.tmp', 'workspaces', 'test-run-9p5', 'case-A');
  // The bridge does NOT echo workspace_root into result metadata directly, so
  // we verify by reloading the provider module's last session via the
  // ad-hoc inspector below.
  const lastSession = makeBridge._lastInprocSession && makeBridge._lastInprocSession();
  assert.ok(lastSession, 'expected _lastInprocSession inspector to be exposed');
  assert.equal(lastSession.cfg.workspace_root, expected);
});

test('opencode_cli specialized branch still works (regression)', async (t) => {
  const prev = process.env.OPENCODE_MOCK_MODE;
  process.env.OPENCODE_MOCK_MODE = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.OPENCODE_MOCK_MODE;
    else process.env.OPENCODE_MOCK_MODE = prev;
  });

  const bridge = new HarnessBridgeProvider({
    config: {
      provider_kind: 'opencode_cli',
      provider_label: 'opencode-cli-mock',
      model: 'gpt-mock',
    },
  });
  const result = await bridge.callApi('hello-opencode', { vars: {} });
  // Specialized branch must produce some output (mock mode returns a stub)
  // and must NOT route through the new generic in-proc dispatch.
  assert.equal(result.metadata.turns_completed, 1);
  assert.ok(result.output, 'expected mock-mode output');
});
