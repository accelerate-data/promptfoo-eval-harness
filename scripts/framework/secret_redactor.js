'use strict';

/**
 * Secret redactor — applies version-controlled patterns from config/redaction-patterns.json
 * to strings and object trees. Both Node and Python implementations load the same JSON
 * so redaction is consistent across the bridge and adapter.
 */

const path = require('node:path');
const _PATTERNS_PATH = path.resolve(__dirname, '../../config/redaction-patterns.json');

// Compile patterns once at module load time.
const _compiled = (() => {
  const raw = require(_PATTERNS_PATH);
  return raw.map(({ name, regex, replacement }) => ({
    name,
    // Use 'g' flag for global replacement plus 'i' will be inlined via (?i) in pattern.
    // Node does not support (?i) inline flag in RegExp constructor, so handle it here:
    re: regex.startsWith('(?i)') ? new RegExp(regex.slice(4), 'gi') : new RegExp(regex, 'g'),
    replacement,
  }));
})();

/**
 * Redact a single string by applying all patterns in order.
 * @param {string} input
 * @returns {string}
 */
function _redactString(input) {
  let out = input;
  for (const { re, replacement } of _compiled) {
    // Reset lastIndex for stateful global regexes.
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Recursively redact an input value:
 * - strings → pattern-redacted string
 * - plain objects → same structure with string leaf values redacted
 * - arrays → each element recursively redacted
 * - other types (null, undefined, number, boolean) → returned as-is
 *
 * @param {any} input
 * @returns {any}
 */
function redact(input) {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return _redactString(input);
  if (Array.isArray(input)) return input.map(redact);
  if (typeof input === 'object') {
    const out = {};
    for (const key of Object.keys(input)) {
      out[key] = redact(input[key]);
    }
    return out;
  }
  // numbers, booleans, etc. — pass through unchanged
  return input;
}

/**
 * Return the array of compiled pattern names (used by parity tests).
 * @returns {string[]}
 */
function redactPatternNames() {
  return _compiled.map((p) => p.name);
}

module.exports = { redact, redactPatternNames };
