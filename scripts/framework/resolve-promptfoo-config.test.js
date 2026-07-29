'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveConfigFile,
  resolveMultiProviderConfig,
  resolveMultiTurnProviderBlock,
  resolveProviderId,
  BRIDGE_FILE_URL,
  _isV1RawShape,
  _hasMultiTurnTest,
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

  test('AC-3: opencode_cli v1 entry exposes agent/opencode_config/project_dir at config TOP LEVEL, not nested under provider_options', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_cli',
              model: 'anthropic/claude-haiku-4-5',
              label: 'oc',
              agent: 'eval_light',
              opencode_config: 'opencode.json',
              project_dir: '../..',
              format: 'json',
              log_level: 'info',
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-flatten' });
    const entry = result.providers[0];

    // The exact bug from VD-3912: opencode-cli-provider.js reads these fields
    // off the top level of config, never off a nested provider_options bag.
    assert.strictEqual(entry.config.agent, 'eval_light');
    assert.strictEqual(entry.config.opencode_config, 'opencode.json');
    assert.strictEqual(entry.config.project_dir, '../..');
    assert.strictEqual(entry.config.format, 'json');
    assert.strictEqual(entry.config.log_level, 'info');
    assert.ok(!('provider_options' in entry.config), 'fields must not be nested under provider_options');
  });

  test('AC-3: opencode_sdk v1 entry exposes extra.opencode_agent at config.extra top level', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_sdk',
              model: 'opencode-go/qwen3.5-plus',
              label: 'oc-sdk',
              extra: { opencode_agent: 'build' },
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-sdk-flatten' });
    const entry = result.providers[0];
    assert.deepStrictEqual(entry.config.extra, { opencode_agent: 'build' });
    assert.ok(!('provider_options' in entry.config), 'extra must not be nested under provider_options');
  });

  test('AC-3: codex_sdk v1 entry exposes extra.sandbox_mode/reasoning_effort at config.extra top level', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'codex_sdk',
              model: 'gpt-5-codex',
              label: 'codex',
              extra: { sandbox_mode: 'workspace-write', reasoning_effort: 'high' },
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-codex-flatten' });
    const entry = result.providers[0];
    assert.deepStrictEqual(entry.config.extra, { sandbox_mode: 'workspace-write', reasoning_effort: 'high' });
    assert.ok(!('provider_options' in entry.config), 'extra must not be nested under provider_options');
  });

  test('AC-3: openhands_sdk v1 entry exposes extra.base_url at config.extra top level (gateway mode)', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'openhands_sdk',
              model: 'gpt-4o',
              label: 'oh-gateway',
              extra: { base_url: 'https://gateway.internal/v1' },
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'ac3-oh-flatten' });
    const entry = result.providers[0];
    // This is the exact field OpenHands gateway mode reads (agent_factory.py
    // cfg.extra.get("base_url")) to decide whether to bypass legacy
    // prefix-routed API keys. Nested under provider_options, gateway mode
    // silently never activates.
    assert.deepStrictEqual(entry.config.extra, { base_url: 'https://gateway.internal/v1' });
    assert.ok(!('provider_options' in entry.config), 'extra must not be nested under provider_options');
  });

  test('AC-3: a provider-declared field cannot clobber resolver-owned run_id/case_id/provider_label', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_cli',
              model: 'anthropic/claude-haiku-4-5',
              label: 'oc',
              agent: 'eval_light',
              opencode_config: 'opencode.json',
              project_dir: '../..',
              format: 'json',
              log_level: 'info',
              // Adversarial: a consumer TOML entry that happens to declare
              // these names should never be able to overwrite the resolver's
              // own run/case identity — nothing in parseTierConfig forbids
              // a provider entry from declaring them.
              run_id: 'attacker-controlled-run-id',
              case_id: 'attacker-controlled-case-id',
              provider_label: 'attacker-controlled-label',
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'real-run-id' });
    const entry = result.providers[0];
    assert.strictEqual(entry.config.run_id, 'real-run-id', 'resolver-owned run_id must win');
    assert.notStrictEqual(entry.config.case_id, 'attacker-controlled-case-id', 'resolver-owned case_id must win');
    assert.strictEqual(entry.config.provider_label, 'oc', 'resolver-owned provider_label (from `label`) must win');
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

  test('AC-3: a provider-declared field cannot clobber resolver-owned run_id/case_id in the openhands_agent_server branch', () => {
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'openhands_agent_server',
              agent: 'eval_light',
              openhands_config: 'openhands.json',
              model: 'openai/gpt-4o-mini',
              // Adversarial: a consumer TOML entry that happens to declare
              // these names should never be able to overwrite the resolver's
              // own run/case identity — nothing in parseTierConfig forbids
              // a provider entry from declaring them.
              run_id: 'attacker-controlled-run-id',
              case_id: 'attacker-controlled-case-id',
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'real-run-id' });
    const entry = result.providers[0];
    assert.strictEqual(entry.config.run_id, 'real-run-id', 'resolver-owned run_id must win');
    assert.notStrictEqual(entry.config.case_id, 'attacker-controlled-case-id', 'resolver-owned case_id must win');
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

describe('multi-turn auto-route — v0 tier with vars.turns', () => {
  const MULTITURN_CONFIG = 'tests/fixtures/multiturn-package-config.json';

  function v0RawTier(extra = {}) {
    return {
      runtime: {
        provider_id: 'file://scripts/framework/opencode-cli-provider.js',
        opencode_config: 'opencode.json',
        project_dir: '../..',
      },
      tiers: {
        light: { agent: 'eval_light' },
        standard: { agent: 'eval_standard' },
        high: { agent: 'eval_high' },
        x_high: { agent: 'eval_x_high' },
      },
      ...extra,
    };
  }

  test('_hasMultiTurnTest detects vars.turns in tests[] (string + array) and defaultTest', () => {
    assert.equal(_hasMultiTurnTest({ tests: [{ vars: { turns: '["a","b"]' } }] }), true);
    assert.equal(_hasMultiTurnTest({ tests: [{ vars: { turns: ['a', 'b'] } }] }), true);
    assert.equal(_hasMultiTurnTest({ defaultTest: { vars: { turns: '["a"]' } } }), true);
    // negatives — no turns, empty turns, missing vars, bad shapes
    assert.equal(_hasMultiTurnTest({ tests: [{ vars: { prompt: 'x' } }] }), false);
    assert.equal(_hasMultiTurnTest({ tests: [{ vars: { turns: '   ' } }] }), false);
    assert.equal(_hasMultiTurnTest({ tests: [{ vars: { turns: [] } }] }), false);
    assert.equal(_hasMultiTurnTest({ tests: [] }), false);
    assert.equal(_hasMultiTurnTest(null), false);
  });

  test('resolveMultiTurnProviderBlock builds an opencode_sdk bridge block (extra.opencode_agent)', () => {
    const block = resolveMultiTurnProviderBlock(
      v0RawTier({
        multiturn: {
          provider_kind: 'opencode_sdk',
          model: 'opencode-go/qwen3.5-plus',
          opencode_agent: 'build',
        },
      }),
    );
    assert.equal(block.id, BRIDGE_FILE_URL);
    assert.equal(block.label, 'opencode_sdk/opencode-go/qwen3.5-plus');
    assert.equal(block.config.provider_kind, 'opencode_sdk');
    assert.equal(block.config.model, 'opencode-go/qwen3.5-plus');
    assert.deepEqual(block.config.extra, { opencode_agent: 'build' });
    assert.ok(!('provider_options' in block.config), 'fields land at config top level');
  });

  test('resolveMultiTurnProviderBlock honors an explicit label and openhands_sdk agent', () => {
    const block = resolveMultiTurnProviderBlock(
      v0RawTier({
        multiturn: {
          provider_kind: 'openhands_sdk',
          model: 'openai/gpt-4o-mini',
          agent: 'eval_light',
          label: 'oh-mini',
        },
      }),
    );
    assert.equal(block.label, 'oh-mini');
    assert.equal(block.config.provider_label, 'oh-mini');
    assert.equal(block.config.agent, 'eval_light');
  });

  test('resolveMultiTurnProviderBlock throws when [multiturn] is missing or malformed', () => {
    assert.throws(() => resolveMultiTurnProviderBlock(v0RawTier()), /no\s+\[multiturn\] block/);
    assert.throws(
      () => resolveMultiTurnProviderBlock(v0RawTier({ multiturn: { model: 'x' } })),
      /provider_kind is required/,
    );
    assert.throws(
      () => resolveMultiTurnProviderBlock(v0RawTier({ multiturn: { provider_kind: 'opencode_sdk' } })),
      /model is required/,
    );
  });

  test('resolveConfigFile auto-routes a v0 multi-turn package to the bridge', () => {
    const rawTierConfig = v0RawTier({
      multiturn: {
        provider_kind: 'opencode_sdk',
        model: 'opencode-go/qwen3.5-plus',
        opencode_agent: 'build',
      },
    });
    const resolved = resolveConfigFile(MULTITURN_CONFIG, { rawTierConfig });

    assert.equal(resolved.providers.length, 1);
    assert.equal(resolved.providers[0].id, BRIDGE_FILE_URL);
    assert.equal(resolved.providers[0].config.provider_kind, 'opencode_sdk');
    assert.deepEqual(resolved.providers[0].config.extra, { opencode_agent: 'build' });
    // Consumer tests/prompts survive unchanged.
    assert.ok(Array.isArray(resolved.tests) && resolved.tests.length === 1);
    assert.ok(_hasMultiTurnTest(resolved), 'vars.turns must survive into the resolved config');
  });

  test('resolveConfigFile throws a clear error when a multi-turn package has no [multiturn] block', () => {
    assert.throws(
      () => resolveConfigFile(MULTITURN_CONFIG, { rawTierConfig: v0RawTier() }),
      /declares a multi-turn test.*no\s+\[multiturn\] block/s,
    );
  });

  test('AC-3: resolveConfigFile rejects a package-declared providers field before the multi-turn auto-route runs', () => {
    const MULTITURN_WITH_PROVIDERS = 'tests/fixtures/multiturn-package-with-providers.json';
    assert.throws(
      () => resolveConfigFile(MULTITURN_WITH_PROVIDERS, {
        rawTierConfig: v0RawTier({
          multiturn: { provider_kind: 'opencode_sdk', model: 'opencode-go/qwen3.5-plus' },
        }),
      }),
      /declares its own "providers"/,
    );
  });
});

describe('resolveConfigFile — package-declared providers rejected (VD-3792)', () => {
  beforeEach(() => {
    _resetRunId();
  });

  const PACKAGE_WITH_PROVIDERS = 'tests/fixtures/package-with-providers.json';

  test('AC-1: throws for a v0-tier-shaped config before any tier-derived provider block is computed', () => {
    const rawTierConfig = {
      runtime: {
        provider_id: 'file://scripts/framework/opencode-cli-provider.js',
        opencode_config: 'opencode.json',
        project_dir: '../..',
      },
      tiers: { light: { agent: 'eval_light' } },
    };
    assert.throws(
      () => resolveConfigFile(PACKAGE_WITH_PROVIDERS, { rawTierConfig }),
      /declares its own "providers"/,
    );
  });

  test('AC-1b: throws even with no rawTierConfig override, i.e. before _readRawTierConfig/_isV1RawShape ' +
    'ever inspects the real on-disk config/eval-tiers.toml — proves the guard precedes the legacy ' +
    'v0-non-multiturn resolveProviderBlock() branch too, which is the one branch that ignores an ' +
    'injected rawTierConfig entirely', () => {
    assert.throws(
      () => resolveConfigFile(PACKAGE_WITH_PROVIDERS),
      /declares its own "providers"/,
    );
  });

  test('AC-2: throws for a v1-tier-shaped config before any tier-derived provider block is computed', () => {
    const rawTierConfig = {
      version: 'v1',
      tiers: {
        light: { providers: [{ provider_kind: 'opencode_cli', model: 'x', label: 'x' }] },
      },
    };
    assert.throws(
      () => resolveConfigFile(PACKAGE_WITH_PROVIDERS, { rawTierConfig }),
      /declares its own "providers"/,
    );
  });

  test('AC-4: thrown message names the package path and mentions both providers and metadata.eval_tier', () => {
    const rawTierConfig = {
      version: 'v1',
      tiers: {
        light: { providers: [{ provider_kind: 'opencode_cli', model: 'x', label: 'x' }] },
      },
    };
    assert.throws(
      () => resolveConfigFile(PACKAGE_WITH_PROVIDERS, { rawTierConfig }),
      (err) => {
        assert.match(err.message, /tests\/fixtures\/package-with-providers\.json/);
        assert.match(err.message, /"providers"/);
        assert.match(err.message, /metadata\.eval_tier/);
        return true;
      },
    );
  });

  test('AC-5: a config with metadata.eval_tier and no providers field resolves unaffected (v1, multiturn)', () => {
    // The legacy v0-non-multiturn branch resolves tiers via the real on-disk
    // config/eval-tiers.toml (resolveProviderBlock does not accept an injected
    // rawTierConfig), so it is exercised separately, not here — this test
    // covers the two branches that do honor the injected rawTierConfig seam.
    const SMOKE_CONFIG = 'examples/harness-smoke/promptfooconfig.json';
    const MULTITURN_CONFIG = 'tests/fixtures/multiturn-package-config.json';

    const v1Tier = {
      version: 'v1',
      tiers: { light: { providers: [{ provider_kind: 'opencode_cli', model: 'x', label: 'x' }] } },
    };
    const v0TierWithMultiturn = {
      runtime: {
        provider_id: 'file://scripts/framework/opencode-cli-provider.js',
        opencode_config: 'opencode.json',
        project_dir: '../..',
      },
      tiers: { light: { agent: 'eval_light' } },
      multiturn: { provider_kind: 'opencode_sdk', model: 'opencode-go/qwen3.5-plus' },
    };

    assert.doesNotThrow(() => resolveConfigFile(SMOKE_CONFIG, { rawTierConfig: v1Tier }));
    assert.doesNotThrow(() => resolveConfigFile(MULTITURN_CONFIG, { rawTierConfig: v0TierWithMultiturn }));
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

describe('VD-3912 integration — resolver output feeds a REAL (non-stubbed) OpenCodeCliProvider', () => {
  // Guard: mock mode bypasses the exact missingField validation this bug
  // lives in (opencode-cli-provider.js's turn()/callApi() check
  // OPENCODE_MOCK_MODE before validating config), so a test run under mock
  // mode would "pass" whether or not the fix is present — a false positive.
  // Explicitly unset it for this describe block, and restore whatever value
  // was present beforehand so this file doesn't leak global env state into
  // whatever runs after it in the same process.
  let _savedOpencodeMockMode;

  beforeEach(() => {
    _resetRunId();
    _savedOpencodeMockMode = process.env.OPENCODE_MOCK_MODE;
    delete process.env.OPENCODE_MOCK_MODE;
  });

  afterEach(() => {
    if (_savedOpencodeMockMode === undefined) {
      delete process.env.OPENCODE_MOCK_MODE;
    } else {
      process.env.OPENCODE_MOCK_MODE = _savedOpencodeMockMode;
    }
  });

  test('AC-1/AC-2: resolver output satisfies the real provider\'s missingField check without a manual patch', async () => {
    const OpenCodeCliProvider = require('./opencode-cli-provider.js');
    const tierConfig = {
      version: 'v1',
      tiers: {
        light: {
          providers: [
            {
              provider_kind: 'opencode_cli',
              model: 'anthropic/claude-haiku-4-5',
              label: 'oc',
              agent: 'eval_light',
              opencode_config: 'opencode.json',
              project_dir: '../..',
              format: 'json',
              log_level: 'info',
            },
          ],
        },
      },
    };
    const result = resolveMultiProviderConfig(tierConfig, makeScenarios(1), 'light', { runId: 'integration-001' });
    const { config } = result.providers[0];

    // Real provider, real config — only the runner is faked, so this never
    // spawns the actual opencode binary. This is the same construction
    // _node_bridge.js's opencode_cli dispatch performs in production.
    const fakeRunner = async () => 'stub output';
    const provider = new OpenCodeCliProvider({ config, runner: fakeRunner });
    const response = await provider.callApi('hello', { vars: {} });

    assert.ok(!response.error, `expected no error, got: ${response.error}`);
    assert.strictEqual(response.output, 'stub output');
  });
});
