'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveMultiProviderConfig,
  BRIDGE_FILE_URL,
  _resetRunId,
} = require('./resolve-promptfoo-config');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function loadFixture(name) {
  return require(path.join(FIXTURES_DIR, name));
}

// Build N generic test scenarios
function makeScenarios(n) {
  return Array.from({ length: n }, (_, i) => ({
    vars: { prompt: `scenario ${i}`, turns: `["turn ${i}"]` },
    assert: [],
  }));
}

describe('resolveMultiProviderConfig — v1 multi-provider', () => {
  beforeEach(() => {
    _resetRunId();
  });

  test('2 providers × 3 scenarios → exactly 6 provider entries', () => {
    // Build a tier config with 2 providers in one tier
    const tierConfig = {
      version: 'v1',
      tiers: {
        standard: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-sonnet-4-6', label: 'opencode-sonnet' },
            { provider_kind: 'openhands_sdk', model: 'anthropic/claude-sonnet-4-6', label: 'openhands-sonnet' },
          ],
        },
      },
    };
    const scenarios = makeScenarios(3);
    const result = resolveMultiProviderConfig(tierConfig, scenarios, 'standard', { runId: 'run-test-001' });

    assert.strictEqual(result.providers.length, 6, '2 providers × 3 scenarios = 6 entries');
  });

  test('every entry id equals BRIDGE_FILE_URL', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        low: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc-haiku' },
            { provider_kind: 'openhands_sdk', model: 'anthropic/claude-haiku-4-5', label: 'oh-haiku' },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(3), 'low', { runId: 'run-test-002' });

    for (const entry of result.providers) {
      assert.strictEqual(entry.id, BRIDGE_FILE_URL, `entry.id must equal ${BRIDGE_FILE_URL}`);
    }
  });

  test('every entry config carries provider_kind, model, run_id, case_id', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        low: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc-haiku' },
            { provider_kind: 'openhands_sdk', model: 'anthropic/claude-haiku-4-5', label: 'oh-haiku' },
          ],
        },
      },
    };
    const runId = 'run-test-003';
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(2), 'low', { runId });

    for (const entry of result.providers) {
      assert.ok(entry.config, 'config must exist');
      assert.ok(typeof entry.config.provider_kind === 'string', 'config.provider_kind must be string');
      assert.ok(typeof entry.config.model === 'string' || entry.config.model === null, 'config.model must be string or null');
      assert.strictEqual(entry.config.run_id, runId, 'config.run_id must match provided runId');
      assert.ok(typeof entry.config.case_id === 'string' && entry.config.case_id.length > 0, 'config.case_id must be non-empty string');
    }
  });

  test('vars are at top-level tests[], NOT inside config', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        low: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc' },
          ],
        },
      },
    };
    const scenarios = makeScenarios(2);
    const result = resolveMultiProviderConfig(tierConfig, scenarios, 'low', { runId: 'run-test-004' });

    // tests (scenarios) must be present at top level
    assert.strictEqual(result.tests.length, scenarios.length);
    // vars must NOT appear inside config
    for (const entry of result.providers) {
      assert.ok(!entry.config.vars, 'vars must not be inside config');
    }
  });

  test('run_id is stable across all entries in one call', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        low: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc' },
            { provider_kind: 'openhands_sdk', model: 'anthropic/claude-haiku-4-5', label: 'oh' },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(3), 'low', { runId: 'stable-run' });
    const runIds = result.providers.map((e) => e.config.run_id);
    const unique = new Set(runIds);
    assert.strictEqual(unique.size, 1, 'all entries must share the same run_id');
  });

  test('case_id is unique per (tier × provider × scenario)', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        low: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc' },
            { provider_kind: 'openhands_sdk', model: 'anthropic/claude-haiku-4-5', label: 'oh' },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(3), 'low', { runId: 'unique-case' });
    const caseIds = result.providers.map((e) => e.config.case_id);
    const unique = new Set(caseIds);
    assert.strictEqual(unique.size, result.providers.length, 'all case_ids must be unique');
  });

  test('emitted config does not contain --compare anywhere', () => {
    const tierConfig = loadFixture('v1-multi-provider-tier.json');
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(3), 'low', { runId: 'no-compare' });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('--compare'), 'emitted config must not reference --compare (deferred to Phase 2)');
    assert.ok(!serialized.includes('"compare"'), 'emitted config must not have a "compare" key');
  });
});

describe('resolveMultiProviderConfig — v0 legacy compatibility', () => {
  beforeEach(() => {
    _resetRunId();
  });

  test('v0 fixture resolves cleanly with opencode_cli provider', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    const result = resolveMultiProviderConfig(raw, makeScenarios(2), 'light', {
      runId: 'v0-compat',
      sourcePath: 'v0-legacy-tier.json',
    });

    assert.ok(result.providers.length > 0, 'must emit at least one provider entry');
    for (const entry of result.providers) {
      assert.strictEqual(entry.id, BRIDGE_FILE_URL);
      assert.strictEqual(entry.config.provider_kind, 'opencode_cli');
    }
  });

  test('v0 × 1 implicit provider × N scenarios → N entries', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    const scenarios = makeScenarios(3);
    const result = resolveMultiProviderConfig(raw, scenarios, 'standard', { runId: 'v0-n-entries' });
    // v0 has 1 provider per tier × 3 scenarios = 3 entries
    assert.strictEqual(result.providers.length, 3);
  });

  test('v0 provider entries all point at bridge URL', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    const result = resolveMultiProviderConfig(raw, makeScenarios(2), 'high', { runId: 'v0-bridge' });
    for (const entry of result.providers) {
      assert.strictEqual(entry.id, BRIDGE_FILE_URL);
    }
  });
});

describe('resolveMultiProviderConfig — error cases', () => {
  test('throws on unknown tier name', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'opencode_cli', model: 'x', label: 'x' }] },
      },
    };
    assert.throws(
      () => resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'nonexistent'),
      /unknown tier/,
    );
  });
});
