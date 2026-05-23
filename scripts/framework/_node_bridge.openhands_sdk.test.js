'use strict';

/**
 * Layer 2 dispatch-resolution tests for KIND_REGISTRY.openhands_sdk (spec §8.2).
 *
 * SCOPE: dispatch resolution only — does NOT duplicate the full NDJSON round-trip
 * from _node_bridge.test.js (phase 03 owns the protocol coverage per spec §2.4).
 *
 * Covers:
 *   - KIND_REGISTRY.openhands_sdk.mode === 'subprocess'
 *   - KIND_REGISTRY.openhands_sdk.spawn[0] === 'uv'
 *   - spawn argv contains '--with openhands-sdk==<version>'
 *   - version in spawn argv matches loadSdkPins().openhands_sdk.version (dynamic, not hard-coded)
 *   - dispatch routes kind=openhands_sdk callApi to the subprocess path (not inproc)
 *   - PYTHONPATH override is forwarded to spawned subprocess env
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const BRIDGE_PATH = path.resolve(__dirname, '_node_bridge.js');
const { loadSdkPins } = require('./sdk-pins');

function loadBridge() {
  delete require.cache[BRIDGE_PATH];
  return require(BRIDGE_PATH);
}

// ---------------------------------------------------------------------------
// Minimal mock ChildProcess (only needs enough for dispatch routing tests)
// ---------------------------------------------------------------------------

function makeMockChild(responses = []) {
  const stdin = new EventEmitter();
  stdin.write = () => true;
  stdin.end = () => {};

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();

  const child = new EventEmitter();
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.kill = () => { child.exitCode = 1; setImmediate(() => stdout.emit('end')); };
  child.pid = 12345;

  let responseIndex = 0;
  const originalWrite = stdin.write.bind(stdin);
  stdin.write = (data) => {
    if (responseIndex < responses.length) {
      const resp = responses[responseIndex++];
      setImmediate(() => stdout.emit('data', Buffer.from(JSON.stringify(resp) + '\n')));
    }
    return originalWrite(data);
  };

  return child;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KIND_REGISTRY.openhands_sdk dispatch resolution', () => {

  test('mode is subprocess', () => {
    const makeBridge = loadBridge();
    assert.strictEqual(makeBridge._KIND_REGISTRY.openhands_sdk.mode, 'subprocess');
  });

  test('spawn[0] is uv', () => {
    const makeBridge = loadBridge();
    const spawn = makeBridge._KIND_REGISTRY.openhands_sdk.spawn;
    assert.ok(Array.isArray(spawn), 'spawn must be an array');
    assert.strictEqual(spawn[0], 'uv');
  });

  test('spawn contains --with openhands-sdk==<version>', () => {
    const makeBridge = loadBridge();
    const spawn = makeBridge._KIND_REGISTRY.openhands_sdk.spawn;
    const withIdx = spawn.indexOf('--with');
    assert.ok(withIdx >= 0, 'spawn must contain --with flag');
    const withValue = spawn[withIdx + 1];
    assert.ok(
      /^openhands-sdk==[\d.]+$/.test(withValue),
      `spawn --with value must be openhands-sdk==<version>, got: ${withValue}`,
    );
  });

  test('spawn version matches loadSdkPins().openhands_sdk.version (dynamic source-of-truth)', () => {
    const makeBridge = loadBridge();
    const spawn = makeBridge._KIND_REGISTRY.openhands_sdk.spawn;
    const pins = loadSdkPins();
    const pinnedVersion = pins.openhands_sdk.version;

    const withIdx = spawn.indexOf('--with');
    assert.ok(withIdx >= 0, 'spawn must have --with');
    const withValue = spawn[withIdx + 1];
    assert.strictEqual(
      withValue,
      `openhands-sdk==${pinnedVersion}`,
      `spawn version must equal sdk-pins.toml version=${pinnedVersion}`,
    );
  });

  test('spawn uses -m module invocation (not a raw file path)', () => {
    const makeBridge = loadBridge();
    const spawn = makeBridge._KIND_REGISTRY.openhands_sdk.spawn;
    const mIdx = spawn.indexOf('-m');
    assert.ok(mIdx >= 0, 'spawn must use -m module flag');
    const moduleName = spawn[mIdx + 1];
    assert.ok(
      moduleName.includes('_python_adapter'),
      `spawn -m target must include _python_adapter, got: ${moduleName}`,
    );
  });

  test('spawn argv contains --kind=openhands_sdk', () => {
    const makeBridge = loadBridge();
    const spawn = makeBridge._KIND_REGISTRY.openhands_sdk.spawn;
    assert.ok(
      spawn.includes('--kind=openhands_sdk'),
      `spawn must contain --kind=openhands_sdk; got: ${spawn.join(' ')}`,
    );
  });

  test('dispatch routes openhands_sdk callApi to subprocess (not inproc)', async () => {
    const makeBridge = loadBridge();

    // Capture the spawn cmd/args
    let spawnedCmd = null;
    let spawnedArgs = null;

    const mockChild = makeMockChild([
      { type: 'init_ack', id: 'bridge-init', session_id: 'sess-1' },
      { type: 'turn_ack', id: 'bridge-turn-0', text: 'hello back', tool_calls: [], error: null, raw: {} },
      { type: 'finalize_ack', id: 'bridge-final', cost_usd: 0, tokens: {}, transcript_summary: '1 turn(s)' },
      { type: 'shutdown_ack', id: 'bridge-shutdown' },
    ]);

    makeBridge._setSpawnImpl((cmd, args, opts) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      return mockChild;
    });

    const provider = makeBridge({
      config: {
        provider_kind: 'openhands_sdk',
        provider_label: 'test-oh',
        model: 'anthropic/claude-sonnet-4-6',
      },
    });

    await provider.callApi('hello', { vars: { turns: 'hello' } });

    makeBridge._clearSpawnImpl();

    assert.strictEqual(spawnedCmd, 'uv', 'subprocess must be spawned with uv');
    assert.ok(spawnedArgs.includes('--with'), 'uv args must include --with');
    assert.ok(
      spawnedArgs.some((a) => /openhands-sdk==[\d.]+/.test(a)),
      'uv args must pin openhands-sdk version',
    );
  });

  test('PYTHONPATH env override is forwarded to subprocess', async () => {
    const makeBridge = loadBridge();

    let capturedEnv = null;
    const mockChild = makeMockChild([
      { type: 'init_ack', id: 'bridge-init', session_id: 's1' },
      { type: 'turn_ack', id: 'bridge-turn-0', text: 'ok', tool_calls: [], error: null, raw: {} },
      { type: 'finalize_ack', id: 'bridge-final', cost_usd: 0, tokens: {}, transcript_summary: '1 turn(s)' },
      { type: 'shutdown_ack', id: 'bridge-shutdown' },
    ]);

    makeBridge._setSpawnImpl((cmd, args, opts) => {
      capturedEnv = opts.env;
      return mockChild;
    });

    const saved = process.env.PYTHONPATH;
    process.env.PYTHONPATH = '/mock/sdk/path:/other/path';

    const provider = makeBridge({
      config: {
        provider_kind: 'openhands_sdk',
        provider_label: 'test-oh',
        model: 'anthropic/claude-sonnet-4-6',
      },
    });

    await provider.callApi('test', { vars: { turns: 'test' } });

    makeBridge._clearSpawnImpl();
    if (saved === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = saved;

    assert.ok(capturedEnv !== null, 'env must be captured');
    assert.strictEqual(
      capturedEnv.PYTHONPATH,
      '/mock/sdk/path:/other/path',
      'PYTHONPATH must be forwarded to subprocess env',
    );
  });

  test('opencode_cli kind still routes inproc (no subprocess spawn)', async () => {
    const makeBridge = loadBridge();

    let spawnCalled = false;
    makeBridge._setSpawnImpl(() => {
      spawnCalled = true;
      return makeMockChild([]);
    });

    // Stub out the OpenCode CLI provider to avoid requiring the real module
    const originalRequire = require;
    const ocPath = path.resolve(__dirname, 'opencode-cli-provider.js');
    require.cache[ocPath] = {
      id: ocPath, filename: ocPath, loaded: true, exports: class {
        constructor() {}
        callApi() { return Promise.resolve({ output: 'oc-output', metadata: {} }); }
      },
    };

    const provider = makeBridge({
      config: {
        provider_kind: 'opencode_cli',
        provider_label: 'test-oc',
        model: 'anthropic/claude-sonnet-4-6',
      },
    });

    await provider.callApi('hello', { vars: { turns: 'hello' } });

    makeBridge._clearSpawnImpl();
    delete require.cache[ocPath];

    assert.strictEqual(spawnCalled, false, 'opencode_cli must NOT spawn a subprocess');
  });
});
