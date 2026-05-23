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

const os = require('node:os');
const pLimit = require('p-limit');

// ---------------------------------------------------------------------------
// OUTER semaphore — caps subprocess spawns / cross-process dir-walk
// ---------------------------------------------------------------------------

/** @type {import('p-limit').LimitFunction | null} */
let _outerLimit = null;

/**
 * Get (or lazily create) the OUTER concurrency gate.
 * Cap = AD_EVALS_OUTER_CONCURRENCY ?? os.cpus().length.
 * Throws at call time if the env var is set to an invalid value.
 *
 * @returns {import('p-limit').LimitFunction}
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

/** @type {import('p-limit').LimitFunction | null} */
let _globalLimit = null;

/**
 * Get (or lazily create) the INNER (global) concurrency gate.
 * Cap = AD_EVALS_MAX_CONCURRENCY ?? 4 (matches Promptfoo --max-concurrency default).
 * Throws at call time if the env var is set to an invalid value.
 *
 * @returns {import('p-limit').LimitFunction}
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
// Named concurrency gate factory (per-call inner gates)
// ---------------------------------------------------------------------------

/**
 * Create an isolated p-limit gate with the given concurrency cap.
 * Used by subprocess-backed providers to pipeline turns inside a single
 * subprocess session (inner-inner gate, cap=1 per spec §4.1).
 *
 * @param {string} _name  - Descriptive name (for debugging; not enforced).
 * @param {number} max    - Maximum number of concurrent tasks.
 * @returns {import('p-limit').LimitFunction}
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
 * @returns {import('p-limit').LimitFunction & { label: string }}
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
};
