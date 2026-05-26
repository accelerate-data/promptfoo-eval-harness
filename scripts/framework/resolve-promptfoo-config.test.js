'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveConfigFile,
  resolveMultiProviderConfig,
  resolveProviderId,
  BRIDGE_FILE_URL,
  _isV1RawShape,
  _resetRunId,
} = require('./resolve-promptfoo-config');
const { FRAMEWORK_ROOT } = require('./roots');

const AGENT_SERVER_FILE_URL = 'framework://openhands-agent-server-provider.js';

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

describe('resolveMultiProviderConfig — openhands_agent_server routing', () => {
  beforeEach(() => {
    _resetRunId();
  });

  test('emits agent-server provider URL (not bridge) when provider_kind = openhands_agent_server', () => {
    const tierConfig = {
      version: 'v1',
      default_tier: 'light',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'openhands_agent_server',
              agent: 'eval_light',
              openhands_config: 'openhands.json',
              model: 'openai/gpt-4o-mini',
            },
          ],
        },
      },
    };
    const scenarios = makeScenarios(1);
    const result = resolveMultiProviderConfig(tierConfig, scenarios, 'light', { runId: 'as-001' });

    assert.strictEqual(result.providers.length, 1);
    const entry = result.providers[0];
    assert.strictEqual(entry.id, AGENT_SERVER_FILE_URL);
    assert.notStrictEqual(entry.id, BRIDGE_FILE_URL, 'must NOT route through bridge');

    // Consumer fields arrive at config TOP LEVEL — never under provider_options.
    assert.strictEqual(entry.config.provider_kind, 'openhands_agent_server');
    assert.strictEqual(entry.config.agent, 'eval_light');
    assert.strictEqual(entry.config.openhands_config, 'openhands.json');
    assert.strictEqual(entry.config.model, 'openai/gpt-4o-mini');
    assert.strictEqual(entry.config.run_id, 'as-001');
    assert.ok(entry.config.case_id && typeof entry.config.case_id === 'string');
    assert.ok(!('provider_options' in entry.config), 'agent-server kind has no provider_options bag');
  });

  test('non-agent-server kinds still emit BRIDGE_FILE_URL', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc' },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'as-002' });
    assert.strictEqual(result.providers[0].id, BRIDGE_FILE_URL);
  });

  test('framework:// resolves agent-server URL to absolute file:// under FRAMEWORK_ROOT', () => {
    const resolved = resolveProviderId(AGENT_SERVER_FILE_URL);
    const expected = `file://${path.join(FRAMEWORK_ROOT, 'openhands-agent-server-provider.js')}`;
    assert.strictEqual(resolved, expected);
  });

  test('T13 — public-API resolver routing reaches the provider module, not the bridge', () => {
    const tierConfig = {
      version: 'v1',
      default_tier: 'light',
      tiers: {
        light: {
          providers: [{
            provider_kind: 'openhands_agent_server',
            agent: 'eval_light',
            openhands_config: 'openhands.json',
            model: 'openai/gpt-4o-mini',
          }],
        },
      },
    };
    const { providers } = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 't13' });
    assert.strictEqual(providers.length, 1);
    assert.strictEqual(providers[0].id, AGENT_SERVER_FILE_URL);
    assert.strictEqual(providers[0].config.provider_kind, 'openhands_agent_server');
    assert.strictEqual(providers[0].config.agent, 'eval_light');
    assert.strictEqual(providers[0].config.model, 'openai/gpt-4o-mini');

    // require-identity proof: resolver lands on the provider module, NOT the bridge.
    const filePath = resolveProviderId(providers[0].id).replace(/^file:\/\//, '');
    const providerMod = require(filePath);
    const directMod = require('./openhands-agent-server-provider');
    assert.strictEqual(providerMod, directMod, 'resolver must reach the openhands-agent-server-provider module');
    assert.notStrictEqual(
      path.resolve(filePath),
      require.resolve('./_node_bridge'),
      'resolver must NOT route agent-server through _node_bridge.js',
    );
  });
});

describe('resolveConfigFile — v1 materialize branch', () => {
  beforeEach(() => {
    _resetRunId();
  });

  const SMOKE_CONFIG = 'examples/harness-smoke/promptfooconfig.json';

  test('_isV1RawShape detects version=v1, providers[] arrays, and rejects v0', () => {
    assert.equal(_isV1RawShape({ version: 'v1', tiers: { light: { providers: [] } } }), true);
    assert.equal(
      _isV1RawShape({ tiers: { light: { providers: [{ provider_kind: 'opencode_cli' }] } } }),
      true,
    );
    assert.equal(_isV1RawShape({ tiers: { light: { agent: 'eval_light' } } }), false);
    assert.equal(_isV1RawShape(null), false);
    assert.equal(_isV1RawShape([]), false);
  });

  test('v1 rawTierConfig with opencode_cli routes through BRIDGE_FILE_URL', () => {
    const rawTierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc' },
          ],
        },
      },
    };
    const resolved = resolveConfigFile(SMOKE_CONFIG, { rawTierConfig });

    assert.equal(resolved.providers.length, 1);
    assert.equal(resolved.providers[0].id, BRIDGE_FILE_URL);
    assert.equal(resolved.providers[0].config.provider_kind, 'opencode_cli');
    // Original consumer fields (tests, prompts, description) survive.
    assert.equal(resolved.description, 'OpenCode harness smoke test.');
    assert.ok(Array.isArray(resolved.tests) && resolved.tests.length === 1);
    assert.ok(Array.isArray(resolved.prompts) && resolved.prompts.length === 1);
  });

  test('v1 with openhands_agent_server resolves framework:// to absolute file://', () => {
    const rawTierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'openhands_agent_server',
              agent: 'eval_light',
              openhands_config: 'openhands.json',
              model: 'openai/gpt-4o-mini',
            },
          ],
        },
      },
    };
    const resolved = resolveConfigFile(SMOKE_CONFIG, { rawTierConfig });

    assert.equal(resolved.providers.length, 1);
    const expectedUrl = `file://${path.join(FRAMEWORK_ROOT, 'openhands-agent-server-provider.js')}`;
    assert.equal(resolved.providers[0].id, expectedUrl,
      'framework:// must be resolved to absolute file:// before promptfoo sees it');
    assert.equal(resolved.providers[0].config.provider_kind, 'openhands_agent_server');
    assert.equal(resolved.providers[0].config.agent, 'eval_light');
    assert.equal(resolved.providers[0].config.openhands_config, 'openhands.json');
    assert.equal(resolved.providers[0].config.model, 'openai/gpt-4o-mini');
  });

  test('v1 collapses scenario fan-out (Phase 1) — N tier-providers = N entries regardless of tests[].length', () => {
    const rawTierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5', label: 'oc' },
            { provider_kind: 'openhands_sdk', model: 'anthropic/claude-haiku-4-5', label: 'oh' },
          ],
        },
      },
    };
    const resolved = resolveConfigFile(SMOKE_CONFIG, { rawTierConfig });
    // 2 tier-providers × Phase-1-collapsed scenarios = 2 entries (NOT 2 × tests.length).
    assert.equal(resolved.providers.length, 2,
      'Phase 1 must collapse scenario fan-out; --compare semantics are Phase 2');
  });

  test('v1 throws on unknown eval_tier referenced by metadata', () => {
    const rawTierConfig = {
      version: 'v1',
      tiers: {
        standard: { providers: [{ provider_kind: 'opencode_cli', model: 'x', label: 'x' }] },
      },
    };
    // SMOKE_CONFIG metadata.eval_tier = 'light', tier config only defines 'standard'.
    assert.throws(
      () => resolveConfigFile(SMOKE_CONFIG, { rawTierConfig }),
      /unknown tier "light"/,
    );
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
