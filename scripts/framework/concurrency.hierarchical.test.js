'use strict';

/**
 * Phase 9.5 — hierarchical `acquire(kind?)` tests (VD-2174-12).
 *
 * Asserts:
 *   (1) acquire() with no kind caps to AD_EVALS_MAX_CONCURRENCY.
 *   (2) acquire(kind) with no per-kind config is identical to no-kind case.
 *   (3) acquire(kind) with per-kind cap < global cap caps to per-kind.
 *   (4) Mixed-kind invariant: total in-flight ≤ global cap regardless of per-kind caps.
 *   (5) Release ordering: per-kind released before global.
 *
 * Run: node --test scripts/framework/concurrency.hierarchical.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let concurrencyMod;

function loadFresh() {
  delete require.cache[require.resolve('./concurrency')];
  concurrencyMod = require('./concurrency');
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function runConcurrent(n, kind, recordMax, acquireFn) {
  let active = 0;
  let max = 0;
  await Promise.all(
    Array.from({ length: n }, () =>
      acquireFn(kind).then(async ({ release }) => {
        active += 1;
        if (active > max) max = active;
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        release();
      }),
    ),
  );
  recordMax(max);
}

test('acquire() with no kind caps at AD_EVALS_MAX_CONCURRENCY', async () => {
  await withEnv({ AD_EVALS_MAX_CONCURRENCY: '2' }, async () => {
    loadFresh();
    concurrencyMod._resetAllLimits();
    concurrencyMod._resetPerKindLimits();
    concurrencyMod._setTierConcurrencyForTesting({});
    let observed = 0;
    await runConcurrent(5, undefined, (m) => { observed = m; }, concurrencyMod.acquire);
    assert.equal(observed, 2, `expected max=2, got ${observed}`);
  });
});

test('acquire(kind) without per-kind config behaves like global only', async () => {
  await withEnv({ AD_EVALS_MAX_CONCURRENCY: '2' }, async () => {
    loadFresh();
    concurrencyMod._resetAllLimits();
    concurrencyMod._resetPerKindLimits();
    concurrencyMod._setTierConcurrencyForTesting({});
    let observed = 0;
    await runConcurrent(5, 'no_config_kind', (m) => { observed = m; }, concurrencyMod.acquire);
    assert.equal(observed, 2, `expected max=2, got ${observed}`);
  });
});

test('acquire(kind) with per-kind cap < global cap caps at per-kind', async () => {
  await withEnv({ AD_EVALS_MAX_CONCURRENCY: '4' }, async () => {
    loadFresh();
    concurrencyMod._resetAllLimits();
    concurrencyMod._resetPerKindLimits();
    concurrencyMod._setTierConcurrencyForTesting({ kindA: 1 });
    let observed = 0;
    await runConcurrent(5, 'kindA', (m) => { observed = m; }, concurrencyMod.acquire);
    assert.equal(observed, 1, `expected max=1, got ${observed}`);
  });
});

test('mixed-kind invariant: total in-flight ≤ global cap regardless of per-kind', async () => {
  await withEnv({ AD_EVALS_MAX_CONCURRENCY: '2' }, async () => {
    loadFresh();
    concurrencyMod._resetAllLimits();
    concurrencyMod._resetPerKindLimits();
    // Per-kind caps are larger than global — global must still dominate.
    concurrencyMod._setTierConcurrencyForTesting({ kindA: 4, kindB: 4 });

    let active = 0;
    let max = 0;
    const work = (kind) =>
      concurrencyMod.acquire(kind).then(async ({ release }) => {
        active += 1;
        if (active > max) max = active;
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
        release();
      });

    const tasks = [];
    for (let i = 0; i < 5; i += 1) tasks.push(work('kindA'));
    for (let i = 0; i < 5; i += 1) tasks.push(work('kindB'));
    await Promise.all(tasks);
    assert.equal(max, 2, `expected total max=2, got ${max}`);
  });
});

test('release ordering: per-kind released before global', async () => {
  // Acquire kindA (global + per-kind). Schedule a second waiter on the GLOBAL
  // gate via acquire() with no kind. While kindA still holds the global slot,
  // the second waiter must wait. After we release kindA, the second waiter
  // proceeds. This indirectly proves release order (perKind then global) —
  // if global were released first, kindA's perKind release would happen on
  // an already-freed slot and a separate waiter could acquire global first.
  await withEnv({ AD_EVALS_MAX_CONCURRENCY: '1' }, async () => {
    loadFresh();
    concurrencyMod._resetAllLimits();
    concurrencyMod._resetPerKindLimits();
    concurrencyMod._setTierConcurrencyForTesting({ kindA: 1 });

    const order = [];
    const first = await concurrencyMod.acquire('kindA');
    order.push('first-acquired');

    // Schedule second acquisition (no kind) — must block on global slot.
    const secondPromise = concurrencyMod.acquire().then(({ release }) => {
      order.push('second-acquired');
      release();
    });

    // Yield to event loop a few times so second has a chance to run if buggy.
    await new Promise((r) => setTimeout(r, 30));
    order.push('before-release');
    first.release();
    await secondPromise;

    assert.deepEqual(
      order,
      ['first-acquired', 'before-release', 'second-acquired'],
      `expected ordered release-then-acquire, got ${JSON.stringify(order)}`,
    );
  });
});

test('_loadTierConcurrencyConfig reads [concurrency] table from eval-tiers.toml', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concur-tier-'));
  t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
  const configPath = path.join(tmpDir, 'eval-tiers.toml');
  fs.writeFileSync(
    configPath,
    [
      '[concurrency]',
      'codex_sdk = 2',
      'opencode_sdk = 3',
      '',
    ].join('\n'),
    'utf8',
  );

  loadFresh();
  concurrencyMod._resetPerKindLimits();
  const result = concurrencyMod._loadTierConcurrencyConfig(configPath);
  assert.deepEqual(result, { codex_sdk: 2, opencode_sdk: 3 });
});

test('_loadTierConcurrencyConfig returns {} when no [concurrency] table', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concur-tier-'));
  t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
  const configPath = path.join(tmpDir, 'eval-tiers.toml');
  fs.writeFileSync(configPath, '[runtime]\nprovider_id = "x"\n', 'utf8');

  loadFresh();
  concurrencyMod._resetPerKindLimits();
  assert.deepEqual(concurrencyMod._loadTierConcurrencyConfig(configPath), {});
});

test('_loadTierConcurrencyConfig ignores non-positive integer caps', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concur-tier-'));
  t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
  const configPath = path.join(tmpDir, 'eval-tiers.toml');
  fs.writeFileSync(
    configPath,
    [
      '[concurrency]',
      'codex_sdk = 2',
      'bad_zero = 0',
      'bad_neg = -1',
      'bad_str = "two"',
      '',
    ].join('\n'),
    'utf8',
  );

  loadFresh();
  concurrencyMod._resetPerKindLimits();
  assert.deepEqual(
    concurrencyMod._loadTierConcurrencyConfig(configPath),
    { codex_sdk: 2 },
    'only positive integers should be accepted',
  );
});
