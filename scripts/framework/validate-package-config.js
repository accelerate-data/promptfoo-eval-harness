'use strict';

/**
 * Package config validator (spec §1.6, §4.3, B.11).
 *
 * validate(packageConfig, { kindRegistry }) → { ok: true } | { ok: false, errors: [...] }
 *
 * Each error: { path, expected, received, message }
 *   path     — YAML-style path, e.g. "tiers[0].providers[1].provider_kind"
 *   expected — what was expected (string description)
 *   received — what was received (safe to log — no secret-shaped values)
 *   message  — human-readable description
 *
 * Rules (spec §1.6 + §4.3):
 *   1. provider_kind ∈ Object.keys(kindRegistry).
 *      Reserved-but-rejected: codex_sdk (Phase 12 / v1.3.0) →
 *      exact message "provider_kind '<name>' is reserved for a future Phase
 *      and not registered in v1.0.0".
 *      Previously-reserved kinds claude_agent_sdk (Phase 10 / v1.1.0) and
 *      opencode_sdk (Phase 11 / v1.2.0) are now live and validated through
 *      the normal kindRegistry path.
 *   2. SDK kinds (mode === 'subprocess') require a non-empty model string.
 *      If model-resolver is available (scripts/framework/model-resolver.js),
 *      the model is also validated through it. In v1.0.0 model-resolver is
 *      not yet shipped (Phase 6 scope) — the check degrades gracefully to
 *      "model must be a non-empty string".
 *   3. vars.turns (if present in any test case) must be a non-empty array
 *      of non-empty strings. Rejects: [], [undefined], ["", "foo"], null.
 *   4. opencode_cli kind: vars.turns.length > 1 is rejected (spec §3.1).
 *
 * Security: validator never logs secret-shaped values. Received values in
 * errors are sanitised through _safeReceived() before inclusion.
 */

const path = require('node:path');

// ---------------------------------------------------------------------------
// Reserved kinds — registered in future phases, rejected in v1.0.0
// ---------------------------------------------------------------------------
const RESERVED_KINDS = new Set(['codex_sdk']);

// ---------------------------------------------------------------------------
// Model resolver — optional (Phase 6). Loaded once, null if not available.
// ---------------------------------------------------------------------------
let _modelResolver = undefined; // undefined = not yet attempted; null = unavailable

function _loadModelResolver() {
  if (_modelResolver !== undefined) return _modelResolver;
  try {
    _modelResolver = require('./model-resolver');
  } catch (_) {
    _modelResolver = null;
  }
  return _modelResolver;
}

// ---------------------------------------------------------------------------
// Security helper — strip secret-shaped values from error output
// ---------------------------------------------------------------------------
const SECRET_PATTERN = /[A-Za-z0-9_\-]{20,}/;

/**
 * Return a safe string representation of a received value.
 * If the value looks secret-shaped (long opaque string), replace with "[REDACTED]".
 *
 * @param {any} value
 * @returns {string}
 */
function _safeReceived(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (SECRET_PATTERN.test(value) && value.length > 30) return '[REDACTED]';
    // Truncate very long strings
    const truncated = value.length > 64 ? value.slice(0, 61) + '...' : value;
    return JSON.stringify(truncated);
  }
  return typeof value;
}

// ---------------------------------------------------------------------------
// Error builder
// ---------------------------------------------------------------------------

function _err(errPath, expected, received, message) {
  return { path: errPath, expected, received: _safeReceived(received), message };
}

// ---------------------------------------------------------------------------
// Validation sub-routines
// ---------------------------------------------------------------------------

/**
 * Validate a single provider entry within a tier.
 *
 * @param {object} provider
 * @param {string} basePath - YAML path prefix, e.g. "tiers[0].providers[1]"
 * @param {object} kindRegistry
 * @param {object[]} errors - Array to push errors into
 */
function _validateProvider(provider, basePath, kindRegistry, errors) {
  if (!provider || typeof provider !== 'object') {
    errors.push(_err(basePath, 'object', provider, `${basePath} must be an object`));
    return;
  }

  const kind = provider.provider_kind;
  const kindPath = `${basePath}.provider_kind`;

  // Rule 1 — provider_kind must be in kindRegistry
  if (!kind || typeof kind !== 'string') {
    errors.push(_err(kindPath, `one of [${Object.keys(kindRegistry).join(', ')}]`, kind,
      `provider_kind is required and must be a string`));
    return; // can't proceed without kind
  }

  if (RESERVED_KINDS.has(kind)) {
    errors.push(_err(kindPath,
      `one of [${Object.keys(kindRegistry).join(', ')}]`,
      kind,
      `provider_kind '${kind}' is reserved for a future Phase and not yet registered in this harness release`,
    ));
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(kindRegistry, kind)) {
    errors.push(_err(kindPath,
      `one of [${Object.keys(kindRegistry).join(', ')}]`,
      kind,
      `provider_kind '${kind}' is not registered in the harness KIND_REGISTRY`,
    ));
    return;
  }

  const kindEntry = kindRegistry[kind];

  // Rule 2 — SDK kinds (mode === 'subprocess') require model
  if (kindEntry && kindEntry.mode === 'subprocess') {
    const model = provider.model;
    const modelPath = `${basePath}.model`;

    if (!model || typeof model !== 'string' || model.trim() === '') {
      errors.push(_err(modelPath, 'non-empty string', model,
        `provider_kind '${kind}' (SDK/subprocess) requires a non-empty model field`));
    } else {
      // Attempt model-resolver validation if available (Phase 6+)
      const resolver = _loadModelResolver();
      if (resolver) {
        const resolveFn = resolver.resolveModel || resolver.parseModel || resolver.default;
        if (typeof resolveFn === 'function') {
          try {
            resolveFn(model);
          } catch (e) {
            errors.push(_err(modelPath, 'resolvable model string', model,
              `model '${_safeReceived(model)}' failed model-resolver validation: ${e.message}`));
          }
        }
      }
    }
  }
}

/**
 * Validate vars.turns for a single test case.
 *
 * @param {any} turns - The vars.turns value
 * @param {string} basePath - YAML path for error context
 * @param {string} providerKind - provider_kind for opencode_cli single-turn check
 * @param {object[]} errors
 */
function _validateTurns(turns, basePath, providerKind, errors) {
  const turnsPath = `${basePath}.turns`;

  if (turns === null || turns === undefined) {
    errors.push(_err(turnsPath, 'non-empty array of non-empty strings', turns,
      `vars.turns must be a non-empty array of non-empty strings`));
    return;
  }

  if (!Array.isArray(turns)) {
    errors.push(_err(turnsPath, 'non-empty array of non-empty strings', turns,
      `vars.turns must be an array`));
    return;
  }

  if (turns.length === 0) {
    errors.push(_err(turnsPath, 'non-empty array', '[]',
      `vars.turns must not be empty`));
    return;
  }

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn === undefined || turn === null || typeof turn !== 'string' || turn === '') {
      errors.push(_err(`${turnsPath}[${i}]`,
        'non-empty string',
        turn,
        `vars.turns[${i}] must be a non-empty string`));
    }
  }

  // Rule 4 — opencode_cli: turns.length > 1 rejected (spec §3.1)
  if (providerKind === 'opencode_cli' && turns.length > 1) {
    errors.push(_err(turnsPath,
      'array of length 1',
      `array of length ${turns.length}`,
      `vars.turns.length > 1 is not supported by opencode_cli in v1.0.0 (spec §3.1)`));
  }
}

// ---------------------------------------------------------------------------
// Main validate function
// ---------------------------------------------------------------------------

/**
 * Validate a package config object.
 *
 * @param {object} packageConfig - The parsed package/tier config object.
 * @param {{ kindRegistry: object }} opts
 * @returns {{ ok: true } | { ok: false, errors: Array<{path, expected, received, message}> }}
 */
function validate(packageConfig, { kindRegistry = {} } = {}) {
  const errors = [];

  if (!packageConfig || typeof packageConfig !== 'object') {
    errors.push(_err('(root)', 'object', packageConfig, 'packageConfig must be a plain object'));
    return { ok: false, errors };
  }

  const tiers = packageConfig.tiers;
  if (!tiers || typeof tiers !== 'object') {
    // No tiers — nothing to validate provider-level rules against
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }

  const tierEntries = Object.entries(tiers);

  for (let tIdx = 0; tIdx < tierEntries.length; tIdx++) {
    const [tierName, tier] = tierEntries[tIdx];
    if (!tier || typeof tier !== 'object') continue;

    // v1 shape: tier.providers[]
    const providers = tier.providers;
    if (Array.isArray(providers)) {
      for (let pIdx = 0; pIdx < providers.length; pIdx++) {
        const providerPath = `tiers[${tIdx}].providers[${pIdx}]`;
        _validateProvider(providers[pIdx], providerPath, kindRegistry, errors);
      }
    }

    // Validate test cases vars.turns if present in tier config
    const testCases = tier.tests || tier.cases || [];
    if (Array.isArray(testCases)) {
      for (let cIdx = 0; cIdx < testCases.length; cIdx++) {
        const testCase = testCases[cIdx];
        if (!testCase || !testCase.vars) continue;
        if (!Object.prototype.hasOwnProperty.call(testCase.vars, 'turns')) continue;

        const turnsBasePath = `tiers[${tIdx}].tests[${cIdx}].vars`;
        // Determine provider kind for opencode_cli check (use first provider if available)
        const firstProviderKind = Array.isArray(providers) && providers[0]
          ? providers[0].provider_kind
          : undefined;

        _validateTurns(testCase.vars.turns, turnsBasePath, firstProviderKind, errors);
      }
    }
  }

  // Also validate top-level tests/cases vars.turns (flat config shape)
  const topTests = packageConfig.tests || packageConfig.cases || [];
  if (Array.isArray(topTests)) {
    // Determine the provider_kind from the first tier's first provider, if available
    let topProviderKind;
    for (const tier of Object.values(tiers)) {
      if (tier && Array.isArray(tier.providers) && tier.providers[0]) {
        topProviderKind = tier.providers[0].provider_kind;
        break;
      }
    }

    for (let cIdx = 0; cIdx < topTests.length; cIdx++) {
      const testCase = topTests[cIdx];
      if (!testCase || !testCase.vars) continue;
      if (!Object.prototype.hasOwnProperty.call(testCase.vars, 'turns')) continue;
      _validateTurns(testCase.vars.turns, `tests[${cIdx}].vars`, topProviderKind, errors);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

module.exports = { validate };
