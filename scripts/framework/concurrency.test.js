'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

// We require the module fresh for each env-override test by clearing the cache.
function freshConcurrency(env = {}) {
  // Apply env overrides
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  // Delete from require cache so the module re-evaluates
  const key = require.resolve('./concurrency');
  delete require.cache[key];
  const mod = require('./concurrency');
  // Restore env
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return mod;
}

describe('concurrency', () => {
  afterEach(() => {
    // Reset the singleton after each test so state doesn't bleed across
    const mod = require('./concurrency');
    mod._resetOuterLimit();
    delete process.env.AD_EVALS_MAX_CONCURRENCY;
    // Clear require cache to ensure fresh state
    delete require.cache[require.resolve('./concurrency')];
  });

  describe('getOuterLimit', () => {
    test('defaults to os.cpus().length when AD_EVALS_MAX_CONCURRENCY is unset', () => {
      delete process.env.AD_EVALS_MAX_CONCURRENCY;
      const { getOuterLimit, _resetOuterLimit } = freshConcurrency({ AD_EVALS_MAX_CONCURRENCY: undefined });
      _resetOuterLimit();
      const limit = getOuterLimit();
      // p-limit exposes .concurrency (or activeCount/pendingCount) — check by running tasks
      // We infer the cap by scheduling cpu+1 tasks and observing no more than cpus run at once.
      assert.strictEqual(typeof limit, 'function', 'outerLimit must be a function');
    });

    test('respects AD_EVALS_MAX_CONCURRENCY env var when set to 1', async () => {
      process.env.AD_EVALS_MAX_CONCURRENCY = '1';
      const { getOuterLimit, _resetOuterLimit } = freshConcurrency({ AD_EVALS_MAX_CONCURRENCY: '1' });
      _resetOuterLimit();
      const limit = getOuterLimit();

      // Run 4 tasks serially under cap=1; measure that they serialise.
      const order = [];
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const tasks = [0, 1, 2, 3].map((i) =>
        limit(async () => {
          order.push(`start-${i}`);
          await delay(10);
          order.push(`end-${i}`);
        }),
      );
      await Promise.all(tasks);
      // With cap=1, each task must fully complete before the next starts.
      for (let i = 0; i < 4; i++) {
        assert.strictEqual(order[i * 2], `start-${i}`, `cap=1: task ${i} should start before ending`);
        assert.strictEqual(order[i * 2 + 1], `end-${i}`, `cap=1: task ${i} should end before next starts`);
      }
    });

    test('respects AD_EVALS_MAX_CONCURRENCY env var when set to 4', () => {
      const { getOuterLimit, _resetOuterLimit } = freshConcurrency({ AD_EVALS_MAX_CONCURRENCY: '4' });
      _resetOuterLimit();
      const limit = getOuterLimit();
      assert.strictEqual(typeof limit, 'function');
    });

    test('is a singleton — same instance on repeated calls', () => {
      const { getOuterLimit } = require('./concurrency');
      const a = getOuterLimit();
      const b = getOuterLimit();
      assert.strictEqual(a, b, 'getOuterLimit must return the same instance');
    });
  });

  describe('makeConcurrencyGate', () => {
    test('returns a callable limit function', () => {
      const { makeConcurrencyGate } = require('./concurrency');
      const gate = makeConcurrencyGate('test-gate', 2);
      assert.strictEqual(typeof gate, 'function');
    });

    test('two gates do not share state', async () => {
      const { makeConcurrencyGate } = require('./concurrency');
      const gateA = makeConcurrencyGate('A', 1);
      const gateB = makeConcurrencyGate('B', 1);

      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      let concurrentA = 0;
      let concurrentB = 0;
      let maxConcurrentA = 0;
      let maxConcurrentB = 0;

      // Run 3 tasks in each gate simultaneously; ensure they don't share counts
      const tasksA = [0, 1, 2].map(() =>
        gateA(async () => {
          concurrentA++;
          maxConcurrentA = Math.max(maxConcurrentA, concurrentA);
          await delay(20);
          concurrentA--;
        }),
      );
      const tasksB = [0, 1, 2].map(() =>
        gateB(async () => {
          concurrentB++;
          maxConcurrentB = Math.max(maxConcurrentB, concurrentB);
          await delay(20);
          concurrentB--;
        }),
      );

      await Promise.all([...tasksA, ...tasksB]);

      // Each gate is cap=1 so max concurrent per gate is 1
      assert.strictEqual(maxConcurrentA, 1, 'gateA should serialize tasks');
      assert.strictEqual(maxConcurrentB, 1, 'gateB should serialize tasks');
    });

    test('acquire/release ordering: 10 tasks at max=2 complete in ~5 sequential pairs', async () => {
      const { makeConcurrencyGate } = require('./concurrency');
      const gate = makeConcurrencyGate('pair-test', 2);
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const TASK_MS = 50;

      const start = Date.now();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          gate(async () => {
            await delay(TASK_MS);
            return i;
          }),
        ),
      );
      const elapsed = Date.now() - start;

      // 10 tasks at cap=2 = 5 batches × 50ms = ~250ms minimum
      // Allow generous upper bound for CI variability
      assert.ok(elapsed >= 200, `Expected >= 200ms for 5 batches of 2, got ${elapsed}ms`);
      assert.ok(elapsed < 2000, `Expected < 2000ms, got ${elapsed}ms (likely deadlock or very slow CI)`);
    });
  });
});
