'use strict';

/**
 * Layer 2 test — INNER concurrency gate enforced at the bridge boundary.
 *
 * Sets AD_EVALS_MAX_CONCURRENCY=2, fires 8 simultaneous callApi invocations
 * via a mock bridge (stub subprocess ~50ms each), and asserts:
 *   - max in-flight at any point ≤ 2
 *   - all 8 complete (no leaks)
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// We need to control the env + module cache carefully so the bridge picks
// up our concurrency cap before it creates its singleton.
const BRIDGE_PATH = path.resolve(__dirname, '_node_bridge.js');
const CONCURRENCY_PATH = path.resolve(__dirname, 'concurrency.js');
const OPENCODE_PATH = path.resolve(__dirname, 'opencode-cli-provider.js');

let savedEnv;
let makeBridge;

function purgeModuleCache() {
  // Clear bridge + concurrency from require cache so they re-initialise.
  for (const p of [BRIDGE_PATH, CONCURRENCY_PATH]) {
    delete require.cache[p];
  }
}

describe('bridge INNER concurrency gate (AD_EVALS_MAX_CONCURRENCY)', () => {
  before(() => {
    savedEnv = {
      AD_EVALS_MAX_CONCURRENCY: process.env.AD_EVALS_MAX_CONCURRENCY,
      AD_EVALS_OUTER_CONCURRENCY: process.env.AD_EVALS_OUTER_CONCURRENCY,
    };
    // Set INNER cap = 2 before loading the bridge
    process.env.AD_EVALS_MAX_CONCURRENCY = '2';
    delete process.env.AD_EVALS_OUTER_CONCURRENCY;
    purgeModuleCache();
    makeBridge = require(BRIDGE_PATH);
    // Reset singletons so they re-read our env override
    const { _resetAllLimits } = require(CONCURRENCY_PATH);
    _resetAllLimits();
  });

  after(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    purgeModuleCache();
  });

  test('max in-flight callApi ≤ 2 when AD_EVALS_MAX_CONCURRENCY=2', async () => {
    const TASK_COUNT = 8;
    const TASK_DELAY_MS = 50;

    let inFlight = 0;
    let maxInFlight = 0;
    let completed = 0;

    // Mock opencode-cli-provider so callApi runs a controlled delay
    // instead of spawning a real process.
    const MockProvider = function () {};
    MockProvider.prototype.callApi = async function () {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, TASK_DELAY_MS));
      inFlight--;
      completed++;
      return { output: 'mock', metadata: {} };
    };

    // Patch opencode-cli-provider in the require cache
    const prevOpencode = require.cache[OPENCODE_PATH];
    require.cache[OPENCODE_PATH] = { id: OPENCODE_PATH, filename: OPENCODE_PATH, loaded: true, exports: MockProvider };

    try {
      const tasks = Array.from({ length: TASK_COUNT }, (_, i) => {
        const bridge = makeBridge({
          config: {
            provider_kind: 'opencode_cli',
            model: 'anthropic/claude-sonnet-4-6',
            provider_label: `mock-${i}`,
          },
        });
        return bridge.callApi(`turn ${i}`, { vars: { turns: `["turn ${i}"]` } });
      });

      await Promise.all(tasks);
    } finally {
      // Restore or remove the mock
      if (prevOpencode) {
        require.cache[OPENCODE_PATH] = prevOpencode;
      } else {
        delete require.cache[OPENCODE_PATH];
      }
    }

    assert.ok(maxInFlight <= 2,
      `Max in-flight was ${maxInFlight}, expected ≤ 2 (AD_EVALS_MAX_CONCURRENCY=2)`);
    assert.strictEqual(completed, TASK_COUNT,
      `Expected all ${TASK_COUNT} callApis to complete, got ${completed}`);
  });

  test('all 8 tasks complete (no leaks)', async () => {
    const TASK_COUNT = 8;
    let completed = 0;

    const MockProvider = function () {};
    MockProvider.prototype.callApi = async function () {
      await new Promise((r) => setTimeout(r, 10));
      completed++;
      return { output: 'done', metadata: {} };
    };

    const prevOpencode = require.cache[OPENCODE_PATH];
    require.cache[OPENCODE_PATH] = { id: OPENCODE_PATH, filename: OPENCODE_PATH, loaded: true, exports: MockProvider };

    try {
      const tasks = Array.from({ length: TASK_COUNT }, (_, i) => {
        const bridge = makeBridge({
          config: {
            provider_kind: 'opencode_cli',
            model: 'anthropic/claude-sonnet-4-6',
            provider_label: `leak-test-${i}`,
          },
        });
        return bridge.callApi(`turn ${i}`, { vars: { turns: `["turn ${i}"]` } });
      });
      await Promise.all(tasks);
    } finally {
      if (prevOpencode) require.cache[OPENCODE_PATH] = prevOpencode;
      else delete require.cache[OPENCODE_PATH];
    }

    assert.strictEqual(completed, TASK_COUNT, `All ${TASK_COUNT} tasks must complete`);
  });
});
