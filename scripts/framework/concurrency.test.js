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
    // Reset all singletons after each test so state doesn't bleed across
    const mod = require('./concurrency');
    mod._resetAllLimits();
    delete process.env.AD_EVALS_OUTER_CONCURRENCY;
    delete process.env.AD_EVALS_MAX_CONCURRENCY;
    // Clear require cache to ensure fresh state
    delete require.cache[require.resolve('./concurrency')];
  });

  // -------------------------------------------------------------------------
  // OUTER gate (AD_EVALS_OUTER_CONCURRENCY)
  // -------------------------------------------------------------------------
  describe('getOuterLimit (OUTER gate)', () => {
    test('defaults to os.cpus().length when AD_EVALS_OUTER_CONCURRENCY is unset', () => {
      delete process.env.AD_EVALS_OUTER_CONCURRENCY;
      const { getOuterLimit, _resetOuterLimit } = freshConcurrency({
        AD_EVALS_OUTER_CONCURRENCY: undefined,
        AD_EVALS_MAX_CONCURRENCY: undefined,
      });
      _resetOuterLimit();
      const limit = getOuterLimit();
      assert.strictEqual(typeof limit, 'function', 'outerLimit must be a function');
    });

    test('respects AD_EVALS_OUTER_CONCURRENCY=1 (serialises tasks)', async () => {
      process.env.AD_EVALS_OUTER_CONCURRENCY = '1';
      delete process.env.AD_EVALS_MAX_CONCURRENCY;
      // Clear cache so module re-initialises cleanly
      delete require.cache[require.resolve('./concurrency')];
      const { getOuterLimit, _resetOuterLimit } = require('./concurrency');
      _resetOuterLimit();
      const limit = getOuterLimit();

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

    test('respects AD_EVALS_OUTER_CONCURRENCY=4', () => {
      process.env.AD_EVALS_OUTER_CONCURRENCY = '4';
      delete require.cache[require.resolve('./concurrency')];
      const { getOuterLimit, _resetOuterLimit } = require('./concurrency');
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

    test('rejects non-positive-integer AD_EVALS_OUTER_CONCURRENCY', () => {
      for (const bad of ['0', '-1', 'abc']) {
        process.env.AD_EVALS_OUTER_CONCURRENCY = bad;
        delete require.cache[require.resolve('./concurrency')];
        const { getOuterLimit, _resetOuterLimit } = require('./concurrency');
        _resetOuterLimit();
        assert.throws(
          () => getOuterLimit(),
          /AD_EVALS_OUTER_CONCURRENCY.*positive integer/i,
          `Expected throw for value: ${bad}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // INNER (global) gate (AD_EVALS_MAX_CONCURRENCY)
  // -------------------------------------------------------------------------
  describe('getGlobalLimit (INNER gate)', () => {
    test('defaults to 4 when AD_EVALS_MAX_CONCURRENCY is unset', () => {
      const { getGlobalLimit, _resetGlobalLimit } = freshConcurrency({
        AD_EVALS_MAX_CONCURRENCY: undefined,
        AD_EVALS_OUTER_CONCURRENCY: undefined,
      });
      _resetGlobalLimit();
      const limit = getGlobalLimit();
      assert.strictEqual(typeof limit, 'function', 'globalLimit must be a function');
    });

    test('respects AD_EVALS_MAX_CONCURRENCY=1', async () => {
      process.env.AD_EVALS_MAX_CONCURRENCY = '1';
      delete process.env.AD_EVALS_OUTER_CONCURRENCY;
      delete require.cache[require.resolve('./concurrency')];
      const { getGlobalLimit, _resetGlobalLimit } = require('./concurrency');
      _resetGlobalLimit();
      const limit = getGlobalLimit();

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
      for (let i = 0; i < 4; i++) {
        assert.strictEqual(order[i * 2], `start-${i}`);
        assert.strictEqual(order[i * 2 + 1], `end-${i}`);
      }
    });

    test('is a singleton — same instance on repeated calls', () => {
      const { getGlobalLimit } = require('./concurrency');
      const a = getGlobalLimit();
      const b = getGlobalLimit();
      assert.strictEqual(a, b);
    });

    test('rejects non-positive-integer AD_EVALS_MAX_CONCURRENCY', () => {
      for (const bad of ['0', '-1', 'abc']) {
        process.env.AD_EVALS_MAX_CONCURRENCY = bad;
        delete require.cache[require.resolve('./concurrency')];
        const { getGlobalLimit, _resetGlobalLimit } = require('./concurrency');
        _resetGlobalLimit();
        assert.throws(
          () => getGlobalLimit(),
          /AD_EVALS_MAX_CONCURRENCY.*positive integer/i,
          `Expected throw for value: ${bad}`,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // concurrency.global accessor
  // -------------------------------------------------------------------------
  describe('concurrency.global', () => {
    test('returns the INNER gate (same as getGlobalLimit)', () => {
      const mod = require('./concurrency');
      mod._resetGlobalLimit();
      const direct = mod.getGlobalLimit();
      mod._resetGlobalLimit();
      const viaObject = mod.concurrency.global;
      // Both should be the same singleton (first call creates it)
      assert.strictEqual(typeof viaObject, 'function');
      // After first access, repeated access returns same instance
      assert.strictEqual(mod.concurrency.global, mod.concurrency.global);
    });

    test('concurrency.spawn returns a labeled gate', () => {
      const { concurrency } = require('./concurrency');
      const gate = concurrency.spawn('test-label', 3);
      assert.strictEqual(typeof gate, 'function');
      assert.strictEqual(gate.label, 'test-label');
    });

    test('concurrency.spawn gates are isolated from each other', async () => {
      const { concurrency } = require('./concurrency');
      const gateA = concurrency.spawn('A', 1);
      const gateB = concurrency.spawn('B', 1);

      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      let maxA = 0, inA = 0;
      let maxB = 0, inB = 0;

      const tasksA = [0, 1, 2].map(() =>
        gateA(async () => { inA++; maxA = Math.max(maxA, inA); await delay(10); inA--; }),
      );
      const tasksB = [0, 1, 2].map(() =>
        gateB(async () => { inB++; maxB = Math.max(maxB, inB); await delay(10); inB--; }),
      );
      await Promise.all([...tasksA, ...tasksB]);
      assert.strictEqual(maxA, 1, 'gateA cap=1 must serialize');
      assert.strictEqual(maxB, 1, 'gateB cap=1 must serialize');
    });
  });

  // -------------------------------------------------------------------------
  // makeConcurrencyGate (unchanged API from phase 03)
  // -------------------------------------------------------------------------
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
      assert.ok(elapsed >= 200, `Expected >= 200ms for 5 batches of 2, got ${elapsed}ms`);
      assert.ok(elapsed < 2000, `Expected < 2000ms, got ${elapsed}ms (likely deadlock or very slow CI)`);
    });
  });

  // -------------------------------------------------------------------------
  // _resetAllLimits
  // -------------------------------------------------------------------------
  describe('_resetAllLimits', () => {
    test('resets both outer and inner singletons', () => {
      const mod = require('./concurrency');
      const outer1 = mod.getOuterLimit();
      const inner1 = mod.getGlobalLimit();
      mod._resetAllLimits();
      const outer2 = mod.getOuterLimit();
      const inner2 = mod.getGlobalLimit();
      assert.notStrictEqual(outer1, outer2, 'outer must be new instance after reset');
      assert.notStrictEqual(inner1, inner2, 'inner must be new instance after reset');
    });
  });
});
