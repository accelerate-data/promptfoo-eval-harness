'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseTierConfig } = require('./eval-tier-config');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function loadFixture(name) {
  return require(path.join(FIXTURES_DIR, name));
}

describe('parseTierConfig — v0 (legacy OpenCode-only)', () => {
  test('normalizes v0 fixture to v1 shape', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    const result = parseTierConfig(raw, 'v0-legacy-tier.json');

    assert.strictEqual(result.version, 'v1-normalized', 'version marker must be v1-normalized');
    assert.ok(result.tiers, 'tiers field must exist');
    assert.ok(result.tiers.light, 'light tier must exist');
    assert.ok(Array.isArray(result.tiers.light.providers), 'providers must be an array');
    assert.strictEqual(result.tiers.light.providers.length, 1);
  });

  test('v0 injects provider_kind: opencode_cli from legacy agent field', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    const result = parseTierConfig(raw);

    for (const [tierName, tier] of Object.entries(result.tiers)) {
      assert.strictEqual(tier.providers[0].provider_kind, 'opencode_cli',
        `tier ${tierName}: provider_kind must be opencode_cli`);
    }
  });

  test('v0 preserves agent name as label', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    const result = parseTierConfig(raw);

    assert.strictEqual(result.tiers.light.providers[0].label, 'opencode-haiku');
    assert.strictEqual(result.tiers.standard.providers[0].label, 'opencode-sonnet');
  });

  test('v0 normalized result passes v1 structural checks', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    const result = parseTierConfig(raw);

    for (const tier of Object.values(result.tiers)) {
      assert.ok(Array.isArray(tier.providers));
      for (const p of tier.providers) {
        assert.ok(typeof p.provider_kind === 'string' && p.provider_kind.length > 0);
      }
    }
  });
});

describe('parseTierConfig — v1 (multi-provider)', () => {
  test('returns v1 fixture unchanged (idempotent)', () => {
    const raw = loadFixture('v1-multi-provider-tier.json');
    const result = parseTierConfig(raw, 'v1-multi-provider-tier.json');

    assert.ok(['v1', 'v1-normalized'].includes(result.version), 'version must be v1 or v1-normalized');
    assert.deepStrictEqual(result.tiers, raw.tiers, 'tiers must be unchanged');
  });

  test('v1 version field is preserved', () => {
    const raw = loadFixture('v1-multi-provider-tier.json');
    const result = parseTierConfig(raw);
    assert.strictEqual(result.version, 'v1');
  });

  test('v1 multi-provider tier has multiple providers', () => {
    const raw = loadFixture('v1-multi-provider-tier.json');
    const result = parseTierConfig(raw);

    assert.strictEqual(result.tiers.low.providers.length, 2);
    assert.strictEqual(result.tiers.low.providers[0].provider_kind, 'opencode_cli');
    assert.strictEqual(result.tiers.low.providers[1].provider_kind, 'openhands_sdk');
  });

  test('v1 is idempotent — parsing twice gives same result', () => {
    const raw = loadFixture('v1-multi-provider-tier.json');
    const first = parseTierConfig(raw);
    const second = parseTierConfig(first);
    assert.deepStrictEqual(first.tiers, second.tiers);
  });
});

describe('parseTierConfig — malformed input', () => {
  test('throws on null input with path context', () => {
    assert.throws(
      () => parseTierConfig(null, 'my-config.json'),
      (e) => {
        assert.ok(e.message.includes('my-config.json'), 'error must include file path');
        return true;
      },
    );
  });

  test('throws on array input', () => {
    assert.throws(() => parseTierConfig([]));
  });

  test('throws on missing tiers field', () => {
    assert.throws(
      () => parseTierConfig({ version: 'v1' }, 'no-tiers.toml'),
      /parseTierConfig/,
    );
  });

  test('throws on v1 tier missing providers array', () => {
    assert.throws(
      () => parseTierConfig({
        version: 'v1',
        tiers: { low: { agent: 'something' } },
      }, 'bad-v1.toml'),
      (e) => {
        assert.ok(e.message.includes('providers'), 'error must mention providers');
        return true;
      },
    );
  });

  test('throws on v1 provider missing provider_kind', () => {
    assert.throws(
      () => parseTierConfig({
        version: 'v1',
        tiers: { low: { providers: [{ model: 'gpt-4' }] } },
      }, 'bad-kind.toml'),
      (e) => {
        assert.ok(e.message.includes('provider_kind'), 'error must mention provider_kind');
        return true;
      },
    );
  });

  test('throws on unrecognizable shape with path context', () => {
    assert.throws(
      () => parseTierConfig({ foo: 'bar' }, 'unknown-shape.toml'),
      (e) => {
        assert.ok(e.message.includes('unknown-shape.toml'), 'error must include path');
        return true;
      },
    );
  });

  test('throws on v0 tier with empty agent string', () => {
    assert.throws(
      () => parseTierConfig({
        tiers: { light: { agent: '' } },
      }, 'bad-v0.toml'),
      (e) => {
        assert.ok(e.message.includes('light'), 'error must mention tier name');
        return true;
      },
    );
  });
});
