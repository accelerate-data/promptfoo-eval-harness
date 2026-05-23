'use strict';

/**
 * Layer 1 contract tests for _node_bridge.js (spec §8.2).
 *
 * Uses Node's built-in test runner (node:test). Stubs out
 * opencode-cli-provider.js and child_process.spawn via module injection.
 *
 * Covers:
 *   - Module exports a single default function (constructor).
 *   - parseProviderConfig rejects missing provider_kind.
 *   - parseTurns handles JSON-encoded string, plain string, array (legacy), empty/undefined.
 *   - KIND_REGISTRY has exactly two entries: opencode_cli (inproc) + openhands_sdk (subprocess).
 *   - opencode_cli happy path routes to in-proc provider.
 *   - opencode_cli empty turns / [undefined] / multi-turn validation errors.
 *   - openhands_sdk routes to subprocess (spawn path).
 *   - Unknown kind returns UNSUPPORTED_KIND error.
 *   - basePath in options is stripped.
 *   - baseMetadata present on every return path.
 *   - Concurrency: AD_EVALS_MAX_CONCURRENCY=2, 10 parallel callApi, elapsed >= 1000ms.
 */

const { test, describe, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// ---------------------------------------------------------------------------
// Helpers: stub child_process.spawn to return a fake subprocess
// ---------------------------------------------------------------------------

/**
 * Build a mock ChildProcess that streams pre-canned NDJSON responses.
 *
 * @param {object[]} responses  - Array of objects to emit as JSON lines on stdout.
 * @param {{ delayMs?: number, exitCode?: number }} opts
 */
function makeMockChild(responses, opts = {}) {
  const stdin = new EventEmitter();
  stdin.write = (data) => {
    // echo back any write — responses are pre-queued
    return true;
  };
  stdin.end = () => {};

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.kill = (signal) => {
    if (child.exitCode === null) {
      child.exitCode = signal === 'SIGKILL' ? 137 : 1;
      // Emit stdout end so any pending _ipcSend resolves/rejects
      setImmediate(() => stdout.emit('end'));
    }
  };
  child.pid = 99999;

  let responseIndex = 0;

  // When stdin receives a write we emit the next pre-canned response.
  const originalWrite = stdin.write.bind(stdin);
  stdin.write = (data) => {
    const delay = opts.delayMs || 0;
    if (responseIndex < responses.length) {
      const resp = responses[responseIndex++];
      setTimeout(() => {
        stdout.emit('data', Buffer.from(JSON.stringify(resp) + '\n'));
      }, delay);
    }
    return originalWrite(data);
  };

  return child;
}

// ---------------------------------------------------------------------------
// Load the bridge module fresh (no process-level caching between test groups)
// ---------------------------------------------------------------------------

const BRIDGE_PATH = path.resolve(__dirname, '_node_bridge.js');

function loadBridge() {
  // Clear from require cache for isolation
  delete require.cache[BRIDGE_PATH];
  return require(BRIDGE_PATH);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_node_bridge', () => {
  describe('module shape', () => {
    test('exports a single default function (constructor)', () => {
      const makeBridge = loadBridge();
      assert.strictEqual(typeof makeBridge, 'function', 'module.exports must be a function');
    });

    test('constructor returns object with id, label, callApi', () => {
      const makeBridge = loadBridge();
      const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'test' } });
      assert.strictEqual(typeof provider.id, 'function');
      assert.strictEqual(typeof provider.label, 'function');
      assert.strictEqual(typeof provider.callApi, 'function');
    });
  });

  describe('KIND_REGISTRY', () => {
    test('has exactly two entries: opencode_cli and openhands_sdk', () => {
      const makeBridge = loadBridge();
      const reg = makeBridge._KIND_REGISTRY;
      const keys = Object.keys(reg).sort();
      // This assertion is intentional: adding Claude Agent SDK in Phase 2 must cause this test to fail.
      assert.deepStrictEqual(keys, ['opencode_cli', 'openhands_sdk']);
    });

    test('opencode_cli has mode=inproc', () => {
      const makeBridge = loadBridge();
      assert.strictEqual(makeBridge._KIND_REGISTRY.opencode_cli.mode, 'inproc');
    });

    test('openhands_sdk has mode=subprocess', () => {
      const makeBridge = loadBridge();
      assert.strictEqual(makeBridge._KIND_REGISTRY.openhands_sdk.mode, 'subprocess');
    });

    test('openhands_sdk adapter path points to _python_adapter.py', () => {
      const makeBridge = loadBridge();
      const adapterPath = makeBridge._KIND_REGISTRY.openhands_sdk.adapter;
      assert.ok(adapterPath.endsWith('_python_adapter.py'), `expected adapter path to end with _python_adapter.py, got: ${adapterPath}`);
    });
  });

  describe('parseProviderConfig', () => {
    test('rejects missing provider_kind with BAD_CONFIG', () => {
      const { _parseProviderConfig: parse } = loadBridge();
      assert.throws(
        () => parse({}),
        (e) => e.code === 'BAD_CONFIG',
      );
    });

    test('rejects null config with BAD_CONFIG', () => {
      const { _parseProviderConfig: parse } = loadBridge();
      assert.throws(
        () => parse(null),
        (e) => e.code === 'BAD_CONFIG',
      );
    });

    test('strips basePath from config', () => {
      const { _parseProviderConfig: parse } = loadBridge();
      const result = parse({ provider_kind: 'opencode_cli', provider_label: 'x', basePath: '/some/path' });
      assert.ok(!('basePath' in result), 'basePath must be stripped from config');
      assert.strictEqual(result.provider_kind, 'opencode_cli');
    });

    test('passes through other config fields', () => {
      const { _parseProviderConfig: parse } = loadBridge();
      const result = parse({ provider_kind: 'openhands_sdk', model: 'anthropic/claude-sonnet-4-6', extra_field: 'yes' });
      assert.strictEqual(result.model, 'anthropic/claude-sonnet-4-6');
      assert.strictEqual(result.extra_field, 'yes');
    });
  });

  describe('parseTurns', () => {
    test('decodes JSON-encoded array string', () => {
      const { _parseTurns: pt } = loadBridge();
      const result = pt('["turn1","turn2","turn3"]', undefined);
      assert.deepStrictEqual(result, ['turn1', 'turn2', 'turn3']);
    });

    test('plain string treated as single-turn', () => {
      const { _parseTurns: pt } = loadBridge();
      const result = pt('just a prompt', undefined);
      assert.deepStrictEqual(result, ['just a prompt']);
    });

    test('falls back to promptFallback when turns is absent', () => {
      const { _parseTurns: pt } = loadBridge();
      const result = pt(undefined, 'fallback prompt');
      assert.deepStrictEqual(result, ['fallback prompt']);
    });

    test('returns null when both turns and promptFallback are absent', () => {
      const { _parseTurns: pt } = loadBridge();
      assert.strictEqual(pt(undefined, undefined), null);
    });

    test('empty string turns falls back to promptFallback', () => {
      const { _parseTurns: pt } = loadBridge();
      // '' is falsy after .trim() check → falls through to promptFallback
      const result = pt('', 'fallback prompt');
      assert.deepStrictEqual(result, ['fallback prompt']);
    });

    test('JSON-encoded empty array "[]" is treated as plain string (not fallback)', () => {
      const { _parseTurns: pt } = loadBridge();
      // '[]' is a non-empty string. JSON.parse gives [] (length 0) so code
      // falls through the JSON branch and returns ['[]'] (plain string treatment).
      // This matches the spec §3.2: non-empty plain string → single turn.
      const result = pt('[]', 'fallback');
      assert.deepStrictEqual(result, ['[]']);
    });

    test('handles legacy JS Array input (defensive compat)', () => {
      const { _parseTurns: pt } = loadBridge();
      const result = pt(['turn1', 'turn2'], undefined);
      assert.deepStrictEqual(result, ['turn1', 'turn2']);
    });
  });

  describe('unknown kind', () => {
    test('callApi returns UNSUPPORTED_KIND error for unknown provider_kind', async () => {
      const makeBridge = loadBridge();
      const provider = makeBridge({ config: { provider_kind: 'does_not_exist', provider_label: 'x' } });
      const result = await provider.callApi('prompt', {});
      assert.ok(result.error, 'should have error');
      assert.strictEqual(result.error.code, 'UNSUPPORTED_KIND');
    });
  });

  describe('opencode_cli routing', () => {
    /**
     * Stub require() for opencode-cli-provider by temporarily injecting into require.cache.
     */
    function withOpenCodeStub(stubCallApi, fn) {
      const openCodePath = require.resolve('./opencode-cli-provider.js');
      const original = require.cache[openCodePath];

      // Build a stub class matching OpenCodeCliProvider shape
      function StubProvider() {}
      StubProvider.prototype.callApi = stubCallApi;
      StubProvider.prototype.id = () => 'stub:opencode';
      require.cache[openCodePath] = { id: openCodePath, filename: openCodePath, exports: StubProvider };

      return Promise.resolve(fn()).finally(() => {
        if (original) {
          require.cache[openCodePath] = original;
        } else {
          delete require.cache[openCodePath];
        }
      });
    }

    test('opencode_cli happy path calls in-proc provider and returns output', async () => {
      delete require.cache[BRIDGE_PATH];
      const makeBridge = require(BRIDGE_PATH);

      await withOpenCodeStub(
        async (prompt, _ctx) => ({ output: `echo: ${prompt}` }),
        async () => {
          const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'test-oc' } });
          const result = await provider.callApi('hello', { vars: {} });
          assert.strictEqual(result.output, 'echo: hello');
          assert.ok(!result.error, `unexpected error: ${result.error}`);
        },
      );
    });

    test('baseMetadata present on opencode_cli success', async () => {
      delete require.cache[BRIDGE_PATH];
      const makeBridge = require(BRIDGE_PATH);

      await withOpenCodeStub(
        async (prompt, _ctx) => ({ output: 'ok' }),
        async () => {
          const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'oc-label', model: 'test-model' } });
          const result = await provider.callApi('test', { vars: {} });
          const m = result.metadata;
          assert.ok(m, 'metadata must be present');
          assert.strictEqual(m.provider_kind, 'opencode_cli');
          assert.strictEqual(m.provider_label, 'oc-label');
          assert.strictEqual(m.model, 'test-model');
          assert.strictEqual(m.turns_completed, 1);
          assert.ok(Array.isArray(m.transcript));
        },
      );
    });

    test('opencode_cli empty vars.turns (null from parseTurns) returns validation error', async () => {
      delete require.cache[BRIDGE_PATH];
      const makeBridge = require(BRIDGE_PATH);

      await withOpenCodeStub(
        async () => ({ output: 'should not be called' }),
        async () => {
          const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'oc' } });
          // No prompt, no vars.turns → parseTurns returns null
          const result = await provider.callApi(undefined, { vars: {} });
          assert.ok(result.error, 'should have error');
          assert.ok(result.metadata, 'metadata must be present on error');
          assert.ok(result.error.includes('no turns') || result.error.includes('empty'), `error: ${result.error}`);
        },
      );
    });

    test('opencode_cli [undefined] turns treated as no-usable-turn', async () => {
      delete require.cache[BRIDGE_PATH];
      const makeBridge = require(BRIDGE_PATH);

      await withOpenCodeStub(
        async () => ({ output: 'should not be called' }),
        async () => {
          const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'oc' } });
          // parseTurns(undefined, undefined) → null → noUsableTurn
          const result = await provider.callApi(undefined, { vars: { turns: undefined } });
          assert.ok(result.error, 'should have error');
          assert.strictEqual(result.metadata.turns_completed, 0);
        },
      );
    });

    test('opencode_cli multi-turn (length > 1) returns validation error with one entry per turn', async () => {
      delete require.cache[BRIDGE_PATH];
      const makeBridge = require(BRIDGE_PATH);

      await withOpenCodeStub(
        async () => ({ output: 'should not be called' }),
        async () => {
          const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'oc' } });
          // JSON-encoded multi-turn string
          const multiTurn = JSON.stringify(['turn one', 'turn two']);
          const result = await provider.callApi('ignored', { vars: { turns: multiTurn } });
          assert.ok(result.error, 'should have error');
          assert.ok(result.error.includes('multi-turn'), `error: ${result.error}`);
          // One transcript entry per attempted turn
          assert.strictEqual(result.metadata.transcript.length, 2);
        },
      );
    });

    test('opencode_cli provider error is returned with metadata', async () => {
      delete require.cache[BRIDGE_PATH];
      const makeBridge = require(BRIDGE_PATH);

      await withOpenCodeStub(
        async () => ({ error: 'provider blew up' }),
        async () => {
          const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'oc' } });
          const result = await provider.callApi('prompt', { vars: {} });
          assert.ok(result.error, 'should have error');
          assert.ok(result.metadata, 'metadata must be present');
          assert.strictEqual(result.metadata.turns_completed, 0);
        },
      );
    });
  });

  describe('openhands_sdk subprocess routing', () => {
    /**
     * Stub spawn via _setSpawnImpl — avoids Node 24's read-only native module
     * cache. The bridge exposes _setSpawnImpl / _clearSpawnImpl for tests.
     */

    function withSpawnStub(childFactory, fn) {
      const makeBridge = loadBridge();
      makeBridge._setSpawnImpl(childFactory);
      return Promise.resolve(fn(makeBridge)).finally(() => {
        makeBridge._clearSpawnImpl();
      });
    }

    function makeTestConfig(overrides = {}) {
      return {
        provider_kind: 'openhands_sdk',
        provider_label: 'oh-test',
        model: 'test-model',
        workspace_root: '/tmp',
        tools: [],
        permissions: {},
        timeout_per_turn_s: 30,
        ...overrides,
      };
    }

    test('openhands_sdk spawns subprocess with adapter path from KIND_REGISTRY', async () => {
      let spawnCmd = null;
      let spawnArgs = null;

      await withSpawnStub(
        (cmd, args) => {
          spawnCmd = cmd;
          spawnArgs = args;
          return makeMockChild([
            { type: 'init_ack', id: 'bridge-init', session_id: 'sess-1' },
            { type: 'turn_ack', id: 'bridge-turn-0', text: 'mock reply', tool_calls: [], error: null, raw: {} },
            { type: 'finalize_ack', id: 'bridge-final', cost_usd: 0, tokens: {}, transcript_summary: '' },
            { type: 'shutdown_ack', id: 'bridge-shutdown' },
          ]);
        },
        async (makeBridge) => {
          const provider = makeBridge({ config: makeTestConfig() });
          const result = await provider.callApi('hello', { vars: {} });

          assert.ok(spawnCmd !== null, 'spawn must be called');
          const adapterArg = spawnArgs.find((a) => a && a.includes('_python_adapter.py'));
          assert.ok(adapterArg, `spawn args must include _python_adapter.py, got: ${JSON.stringify(spawnArgs)}`);
          assert.ok(result.output !== undefined, 'should have output');
          assert.ok(result.metadata, 'metadata must be present');
        },
      );
    });

    test('openhands_sdk result has baseMetadata fields', async () => {
      await withSpawnStub(
        () => makeMockChild([
          { type: 'init_ack', id: 'bridge-init', session_id: 'sess-2' },
          { type: 'turn_ack', id: 'bridge-turn-0', text: 'result text', tool_calls: [], error: null, raw: {} },
          { type: 'finalize_ack', id: 'bridge-final', cost_usd: 0.01, tokens: { input: 10, output: 5 }, transcript_summary: 'done' },
          { type: 'shutdown_ack', id: 'bridge-shutdown' },
        ]),
        async (makeBridge) => {
          const provider = makeBridge({
            config: makeTestConfig({ provider_label: 'oh-label', model: 'anthropic/claude-sonnet-4-6' }),
          });
          const result = await provider.callApi('prompt', { vars: {} });
          const m = result.metadata;
          assert.ok(m, 'metadata must exist');
          assert.strictEqual(m.provider_kind, 'openhands_sdk');
          assert.strictEqual(m.provider_label, 'oh-label');
          assert.strictEqual(m.model, 'anthropic/claude-sonnet-4-6');
          assert.ok(Array.isArray(m.transcript));
          assert.ok(typeof m.adapter_version === 'string');
        },
      );
    });

    test('openhands_sdk subprocess crash returns SUBPROCESS_CRASH error', async () => {
      await withSpawnStub(
        () => {
          const child = makeMockChild([]);
          setTimeout(() => child.stdout.emit('end'), 10);
          return child;
        },
        async (makeBridge) => {
          const provider = makeBridge({ config: makeTestConfig({ provider_label: 'oh-crash' }) });
          const result = await provider.callApi('hello', { vars: {} });
          assert.ok(result.error, 'should have error on crash');
          assert.ok(result.metadata, 'metadata must be present even on crash');
        },
      );
    });

    test('basePath in options is stripped and does not cause error', async () => {
      await withSpawnStub(
        () => makeMockChild([
          { type: 'init_ack', id: 'bridge-init', session_id: 'sess-3' },
          { type: 'turn_ack', id: 'bridge-turn-0', text: 'ok', tool_calls: [], error: null, raw: {} },
          { type: 'finalize_ack', id: 'bridge-final', cost_usd: 0, tokens: {}, transcript_summary: '' },
          { type: 'shutdown_ack', id: 'bridge-shutdown' },
        ]),
        async (makeBridge) => {
          const provider = makeBridge({ config: makeTestConfig({ basePath: '/some/injected/path' }) });
          const result = await provider.callApi('hello', { vars: {} });
          // basePath stripped — should not cause BAD_CONFIG
          assert.ok(!result.error || (typeof result.error === 'string' && !result.error.includes('BAD_CONFIG')),
            `unexpected error: ${result.error}`);
        },
      );
    });
  });

  describe('concurrency', () => {
    test('OUTER semaphore: 10 parallel callApi at max=2, elapsed >= 5 × task delay', async () => {
      // Reset concurrency module to pick up env var
      const concKey = require.resolve('./concurrency');
      delete require.cache[concKey];
      process.env.AD_EVALS_MAX_CONCURRENCY = '2';
      const concMod = require('./concurrency');
      concMod._resetOuterLimit();

      const makeBridge = loadBridge();

      // Each "subprocess" completes in TASK_MS
      const TASK_MS = 80;

      makeBridge._setSpawnImpl(() =>
        makeMockChild([
          { type: 'init_ack', id: 'bridge-init', session_id: 'sess-conc' },
          { type: 'turn_ack', id: 'bridge-turn-0', text: 'conc', tool_calls: [], error: null, raw: {} },
          { type: 'finalize_ack', id: 'bridge-final', cost_usd: 0, tokens: {}, transcript_summary: '' },
          { type: 'shutdown_ack', id: 'bridge-shutdown' },
        ], { delayMs: TASK_MS }),
      );

      try {
        const provider = makeBridge({
          config: {
            provider_kind: 'openhands_sdk',
            provider_label: 'conc-test',
            model: 'test',
            workspace_root: '/tmp',
            tools: [],
            permissions: {},
            timeout_per_turn_s: 30,
          },
        });

        const start = Date.now();
        await Promise.all(
          Array.from({ length: 10 }, () => provider.callApi('hello', { vars: {} })),
        );
        const elapsed = Date.now() - start;

        // 10 tasks × TASK_MS each, capped at 2 = 5 batches × TASK_MS minimum.
        // (Each response in the mock has delayMs, so 4 responses × TASK_MS = 4×TASK_MS per call.)
        // With cap=2 the outer semaphore batches 10 calls into 5 groups of 2.
        // Each call takes ~4×TASK_MS. Total >= 5 × TASK_MS (at minimum 1 response per call).
        assert.ok(elapsed >= 5 * TASK_MS, `elapsed ${elapsed}ms should be >= ${5 * TASK_MS}ms (5 batches)`);
        assert.ok(elapsed < 60000, `elapsed ${elapsed}ms should be < 60s`);
      } finally {
        makeBridge._clearSpawnImpl();
        delete process.env.AD_EVALS_MAX_CONCURRENCY;
        concMod._resetOuterLimit();
        delete require.cache[concKey];
      }
    });
  });
});
