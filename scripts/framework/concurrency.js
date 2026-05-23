'use strict';

/**
 * Concurrency gates for the eval harness bridge (spec §4.2).
 *
 * Two semaphore levels:
 *   OUTER — module-level singleton; caps total concurrent callApi invocations
 *            across all provider kinds in one ad-evals process.
 *            Reads AD_EVALS_MAX_CONCURRENCY (default: os.cpus().length).
 *   INNER — per-call gate; used by subprocess-backed providers to pipeline
 *            turns inside a single subprocess. Created via makeConcurrencyGate().
 *
 * Node's require() cache ensures one outerLimit instance per process even if
 * the bridge class is instantiated multiple times per Promptfoo row (spec §4.2).
 */

const os = require('node:os');
const pLimit = require('p-limit');

/**
 * Create an isolated p-limit gate with the given concurrency cap.
 *
 * @param {string} _name  - Descriptive name (for debugging; not enforced).
 * @param {number} max    - Maximum number of concurrent tasks.
 * @returns {import('p-limit').LimitFunction}
 */
function makeConcurrencyGate(_name, max) {
  return pLimit(max);
}

/**
 * Module-level OUTER semaphore singleton.
 *
 * Cap = parseInt(AD_EVALS_MAX_CONCURRENCY) || os.cpus().length.
 * Initialized lazily on first access so tests can override the env var
 * before the limit is created.
 *
 * @type {import('p-limit').LimitFunction | null}
 */
let _outerLimit = null;

/**
 * @returns {import('p-limit').LimitFunction}
 */
function getOuterLimit() {
  if (_outerLimit === null) {
    const cap = parseInt(process.env.AD_EVALS_MAX_CONCURRENCY, 10) || os.cpus().length;
    _outerLimit = pLimit(cap);
  }
  return _outerLimit;
}

/**
 * Reset the outer limit singleton (for testing only).
 * Call this in test teardown after modifying AD_EVALS_MAX_CONCURRENCY.
 */
function _resetOuterLimit() {
  _outerLimit = null;
}

module.exports = { makeConcurrencyGate, getOuterLimit, _resetOuterLimit };
