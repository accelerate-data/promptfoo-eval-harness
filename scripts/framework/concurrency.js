'use strict';

/**
 * Concurrency gates for the eval harness bridge (spec §4.2).
 *
 * TWO semaphore levels (spec §4.2, docs/concurrency.md):
 *
 *   OUTER — process-level cap on subprocess spawns / cross-process dir-walk
 *            parallelism (phase 08). Reads AD_EVALS_OUTER_CONCURRENCY
 *            (default: os.cpus().length). Was previously keyed by
 *            AD_EVALS_MAX_CONCURRENCY — that name now belongs to INNER.
 *
 *   INNER (global) — module-level singleton; caps concurrent callApi
 *            invocations entering the bridge, regardless of provider_kind.
 *            Reads AD_EVALS_MAX_CONCURRENCY (default: 4, matching Promptfoo's
 *            --max-concurrency default per spec §4.1). Every callApi acquires
 *            this before dispatching — including opencode_cli in-process calls.
 *
 * Node's require() cache ensures one instance per process even if the bridge
 * class is instantiated multiple times per Promptfoo row (spec §4.2).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// p-limit is held at ^3.1.0 (last CJS-compatible major) because every call site here is
// synchronous; p-limit v4+ is ESM-only and would require converting every caller to async.
// See VD-3796. Revisit only if a v4+-only feature becomes genuinely needed.
const pLimit = require('p-limit');
const { parse } = require('smol-toml');

// ---------------------------------------------------------------------------
// OUTER semaphore — caps subprocess spawns / cross-process dir-walk
// ---------------------------------------------------------------------------

/** @type {import('p-limit').Limit | null} */
let _outerLimit = null;

/**
 * Get (or lazily create) the OUTER concurrency gate.
 * Cap = AD_EVALS_OUTER_CONCURRENCY ?? os.cpus().length.
 * Throws at call time if the env var is set to an invalid value.
 *
 * @returns {import('p-limit').Limit}
 */
function getOuterLimit() {
  if (_outerLimit === null) {
    // Validate at call time so tests that override the env var before calling see the error.
    const raw = process.env.AD_EVALS_OUTER_CONCURRENCY;
    if (raw !== undefined && raw !== '') {
      const parsed = parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `AD_EVALS_OUTER_CONCURRENCY must be a positive integer, got: ${JSON.stringify(raw)}`,
        );
      }
      _outerLimit = pLimit(parsed);
    } else {
      _outerLimit = pLimit(os.cpus().length);
    }
  }
  return _outerLimit;
}

/**
 * Reset the OUTER limit singleton (for testing only).
 */
function _resetOuterLimit() {
  _outerLimit = null;
}

// ---------------------------------------------------------------------------
// INNER (global) semaphore — caps concurrent callApi invocations at the bridge
// ---------------------------------------------------------------------------

/** @type {import('p-limit').Limit | null} */
let _globalLimit = null;

/**
 * Get (or lazily create) the INNER (global) concurrency gate.
 * Cap = AD_EVALS_MAX_CONCURRENCY ?? 4 (matches Promptfoo --max-concurrency default).
 * Throws at call time if the env var is set to an invalid value.
 *
 * @returns {import('p-limit').Limit}
 */
function getGlobalLimit() {
  if (_globalLimit === null) {
    const raw = process.env.AD_EVALS_MAX_CONCURRENCY;
    if (raw !== undefined && raw !== '') {
      const parsed = parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(
          `AD_EVALS_MAX_CONCURRENCY must be a positive integer, got: ${JSON.stringify(raw)}`,
        );
      }
      _globalLimit = pLimit(parsed);
    } else {
      _globalLimit = pLimit(4);
    }
  }
  return _globalLimit;
}

/**
 * Reset the INNER (global) limit singleton (for testing only).
 */
function _resetGlobalLimit() {
  _globalLimit = null;
}

/**
 * Reset both singletons (for testing only).
 */
function _resetAllLimits() {
  _resetOuterLimit();
  _resetGlobalLimit();
}

// ---------------------------------------------------------------------------
// Hierarchical per-kind concurrency (Phase 9.5 — VD-2174-12)
//
// `acquire(kind?)` always takes the INNER (global) gate first. If `kind` is
// provided AND `[concurrency.<kind>]` is a positive integer in
// `config/eval-tiers.toml`, ALSO takes the per-kind gate. Release is in
// reverse order (per-kind → global) inside the returned `release()`.
//
// Invariant: total in-process callApi count ≤ AD_EVALS_MAX_CONCURRENCY,
// regardless of per-kind caps. Per-kind caps may only further restrict.
// ---------------------------------------------------------------------------

/** @type {Map<string, import('p-limit').Limit>} */
const _perKindLimits = new Map();

/** @type {Record<string, number> | null} */
let _tierConcurrencyCache = null;

/** @type {string | null} */
let _tierConcurrencyCachePath = null;

/** @type {boolean} */
let _tierConcurrencyOverride = false;

/**
 * Reset the per-kind limit map and tier config cache (for testing only).
 */
function _resetPerKindLimits() {
  _perKindLimits.clear();
  _tierConcurrencyCache = null;
  _tierConcurrencyCachePath = null;
  _tierConcurrencyOverride = false;
}

/**
 * Override the tier concurrency cache directly without reading TOML (for
 * testing only). Pass `null` to clear the override and re-enable disk reads.
 *
 * @param {Record<string, number> | null} caps
 */
function _setTierConcurrencyForTesting(caps) {
  if (caps === null) {
    _tierConcurrencyCache = null;
    _tierConcurrencyCachePath = null;
    _tierConcurrencyOverride = false;
  } else {
    _tierConcurrencyCache = { ...caps };
    _tierConcurrencyCachePath = '<test-override>';
    _tierConcurrencyOverride = true;
  }
}

/**
 * Read `[concurrency]` table from `config/eval-tiers.toml`. Returns
 * `{ [kind]: cap }` where `cap` is a positive integer; invalid entries are
 * silently dropped. Returns `{}` on missing file or missing table.
 *
 * Result is memoized per configPath. Pass a different path to bust the cache
 * for testing.
 *
 * @param {string} [configPath]
 * @returns {Record<string, number>}
 */
function _loadTierConcurrencyConfig(configPath) {
  if (_tierConcurrencyOverride && _tierConcurrencyCache !== null) {
    return _tierConcurrencyCache;
  }
  const resolved = configPath || _defaultTierConfigPath();
  if (_tierConcurrencyCache !== null && _tierConcurrencyCachePath === resolved) {
    return _tierConcurrencyCache;
  }

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      _tierConcurrencyCache = {};
      _tierConcurrencyCachePath = resolved;
      return _tierConcurrencyCache;
    }
    throw err;
  }

  let parsed;
  try {
    parsed = parse(raw);
  } catch {
    _tierConcurrencyCache = {};
    _tierConcurrencyCachePath = resolved;
    return _tierConcurrencyCache;
  }

  const table = parsed && parsed.concurrency;
  const result = {};
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const [kind, value] of Object.entries(table)) {
      if (typeof value === 'bigint') {
        const asNumber = Number(value);
        if (Number.isInteger(asNumber) && asNumber > 0) result[kind] = asNumber;
      } else if (Number.isInteger(value) && value > 0) {
        result[kind] = value;
      }
    }
  }

  _tierConcurrencyCache = result;
  _tierConcurrencyCachePath = resolved;
  return _tierConcurrencyCache;
}

function _defaultTierConfigPath() {
  // Lazy import to avoid a circular dep at module load time.
  // `roots` is small and side-effect-free; this is fine.
  const { EVAL_ROOT } = require('./roots');
  return path.join(EVAL_ROOT, 'config', 'eval-tiers.toml');
}

function _getPerKindLimit(kind, cap) {
  let limit = _perKindLimits.get(kind);
  if (!limit) {
    limit = pLimit(cap);
    _perKindLimits.set(kind, limit);
  }
  return limit;
}

/**
 * Acquire a hold on the bridge concurrency gates. Returns an object with a
 * `release()` function the caller must invoke when work is done.
 *
 * @param {string} [kind] - Optional provider kind for nested per-kind gate.
 * @returns {Promise<{ release: () => void }>}
 */
async function acquire(kind) {
  const globalRelease = await _acquireSlot(getGlobalLimit());
  let perKindRelease = null;

  if (kind) {
    const caps = _loadTierConcurrencyConfig();
    const cap = caps[kind];
    if (Number.isInteger(cap) && cap > 0) {
      perKindRelease = await _acquireSlot(_getPerKindLimit(kind, cap));
    }
  }

  return {
    release() {
      try {
        if (perKindRelease) perKindRelease();
      } finally {
        globalRelease();
      }
    },
  };
}

/**
 * Hold-and-release adapter over a p-limit instance. Returns a release fn the
 * caller invokes when done. The slot is held for the lifetime of the
 * returned release fn; calling it frees the slot.
 *
 * @param {import('p-limit').Limit} limit
 * @returns {Promise<() => void>}
 */
function _acquireSlot(limit) {
  return new Promise((resolveAcquired, rejectAcquired) => {
    limit(() =>
      new Promise((resolveHeld) => {
        // Inside the limit slot now. Hand the caller a release function that
        // resolves the held promise (which frees the slot in p-limit).
        resolveAcquired(() => resolveHeld());
      }),
    ).catch(rejectAcquired);
  });
}

// ---------------------------------------------------------------------------
// Named concurrency gate factory (per-call inner gates)
// ---------------------------------------------------------------------------

/**
 * Create an isolated p-limit gate with the given concurrency cap.
 * Used by subprocess-backed providers to pipeline turns inside a single
 * subprocess session (inner-inner gate, cap=1 per spec §4.1).
 *
 * @param {string} _name  - Descriptive name (for debugging; not enforced).
 * @param {number} max    - Maximum number of concurrent tasks.
 * @returns {import('p-limit').Limit}
 */
function makeConcurrencyGate(_name, max) {
  return pLimit(max);
}

/**
 * Create a labeled concurrency gate for diagnostics.
 * Returns the p-limit function with an attached .label property.
 *
 * @param {string} label  - Human-readable label for diagnostics.
 * @param {number} max    - Maximum number of concurrent tasks.
 * @returns {import('p-limit').Limit & { label: string }}
 */
function spawn(label, max) {
  const gate = pLimit(max);
  gate.label = label;
  return gate;
}

// ---------------------------------------------------------------------------
// Convenience object (mirrors spec §4.2 API surface)
// ---------------------------------------------------------------------------

/**
 * concurrency.global — INNER singleton gate (AD_EVALS_MAX_CONCURRENCY, default 4).
 * Accessed as a lazy getter so tests can override the env var before first access.
 */
const concurrency = {
  get global() {
    return getGlobalLimit();
  },
  spawn,
};

module.exports = {
  // OUTER
  getOuterLimit,
  _resetOuterLimit,
  // INNER / global
  getGlobalLimit,
  _resetGlobalLimit,
  _resetAllLimits,
  concurrency,
  // Per-call gate factory
  makeConcurrencyGate,
  spawn,
  // Hierarchical per-kind (Phase 9.5)
  acquire,
  _loadTierConcurrencyConfig,
  _resetPerKindLimits,
  _setTierConcurrencyForTesting,
};
