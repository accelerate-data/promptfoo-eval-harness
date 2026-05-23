'use strict';

/**
 * migrate-from-v0.test.js — Unit tests for the v0 → v1 TOML migrator (G.29).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');

const { migrate, _isV1, _isV0, _buildV1 } = require('./migrate-from-v0');

// Fixture paths.
const V0_FIXTURE = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'v0-legacy-tier.toml');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v0-test-'));
}
function rmTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// _isV0 / _isV1 detection
// ---------------------------------------------------------------------------

describe('version detection', () => {
  test('_isV0 detects v0 shape (tiers.X.agent)', () => {
    const raw = { tiers: { light: { agent: 'eval_light' } } };
    assert.ok(_isV0(raw));
    assert.ok(!_isV1(raw));
  });

  test('_isV1 detects explicit version="v1"', () => {
    const raw = { version: 'v1', tiers: {} };
    assert.ok(_isV1(raw));
    assert.ok(!_isV0(raw));
  });

  test('_isV1 detects providers-array shape without version field', () => {
    const raw = { tiers: { low: { providers: [{ provider_kind: 'opencode_cli' }] } } };
    assert.ok(_isV1(raw));
  });

  test('neither v0 nor v1 for empty object', () => {
    assert.ok(!_isV0({}));
    assert.ok(!_isV1({}));
  });
});

// ---------------------------------------------------------------------------
// _buildV1 transformation
// ---------------------------------------------------------------------------

describe('_buildV1', () => {
  test('injects provider_kind=opencode_cli into each tier', () => {
    const raw = {
      tiers: {
        light: { agent: 'eval_light' },
        standard: { agent: 'eval_standard' },
      },
    };
    const v1 = _buildV1(raw);
    assert.equal(v1.version, 'v1');
    assert.ok(Array.isArray(v1.tiers.light.providers));
    assert.equal(v1.tiers.light.providers[0].provider_kind, 'opencode_cli');
    assert.equal(v1.tiers.light.providers[0].label, 'eval_light');
    assert.equal(v1.tiers.standard.providers[0].label, 'eval_standard');
  });

  test('preserves agent_config from runtime.opencode_config', () => {
    const raw = {
      runtime: { opencode_config: 'opencode.json' },
      tiers: { light: { agent: 'eval_light' } },
    };
    const v1 = _buildV1(raw);
    assert.equal(v1.tiers.light.providers[0].agent_config, 'opencode.json');
  });

  test('drops the [runtime] block from v1 output', () => {
    const raw = {
      runtime: { provider_id: 'framework://opencode-cli-provider.js' },
      tiers: { light: { agent: 'eval_light' } },
    };
    const v1 = _buildV1(raw);
    assert.ok(!('runtime' in v1), '[runtime] should not appear in v1 output');
  });

  test('throws for tier missing agent field', () => {
    const raw = { tiers: { bad: { model: 'something' } } };
    assert.throws(() => _buildV1(raw), /missing a valid agent field/);
  });
});

// ---------------------------------------------------------------------------
// migrate() — full in-place rewrite
// ---------------------------------------------------------------------------

describe('migrate()', () => {
  let tmpDir;

  before(() => { tmpDir = makeTmpDir(); });
  after(() => rmTmpDir(tmpDir));

  test('v0 → v1: changes file, returns changed=true and non-empty diff', async () => {
    const dest = path.join(tmpDir, 'eval-tiers.toml');
    fs.copyFileSync(V0_FIXTURE, dest);
    const before = fs.readFileSync(dest, 'utf8');

    const { changed, diff, warnings } = await migrate(dest);

    assert.ok(changed, 'expected changed=true for v0 input');
    assert.ok(diff.length > 0, 'expected non-empty diff');
    assert.deepEqual(warnings, []);

    const after = fs.readFileSync(dest, 'utf8');
    assert.notEqual(before, after, 'file should have been rewritten');

    // Verify the rewritten file is valid v1.
    const { parse } = require('smol-toml');
    const rewritten = parse(after);
    assert.ok(_isV1(rewritten), 'rewritten file should be v1 shape');
    assert.equal(rewritten.version, 'v1');
    assert.ok(Array.isArray(rewritten.tiers.light.providers));
    assert.equal(rewritten.tiers.light.providers[0].provider_kind, 'opencode_cli');
  });

  test('idempotent: re-running on v1 output returns changed=false, empty diff, byte-identical file', async () => {
    const dest = path.join(tmpDir, 'eval-tiers-idem.toml');
    fs.copyFileSync(V0_FIXTURE, dest);

    // First migration.
    await migrate(dest);
    const afterFirst = fs.readFileSync(dest, 'utf8');

    // Second migration — must be no-op.
    const { changed, diff, warnings } = await migrate(dest);
    const afterSecond = fs.readFileSync(dest, 'utf8');

    assert.ok(!changed, 'second run should report changed=false');
    assert.equal(diff, '', 'second run should have empty diff');
    assert.ok(warnings.includes('already-v1'), 'second run should warn already-v1');
    assert.equal(afterFirst, afterSecond, 'file must be byte-identical after second run');
  });

  test('diff is non-empty for v0 input', async () => {
    const dest = path.join(tmpDir, 'eval-tiers-diff.toml');
    fs.copyFileSync(V0_FIXTURE, dest);

    const { diff } = await migrate(dest);
    assert.ok(diff.length > 0);
    assert.ok(diff.includes('---'), 'diff should contain header');
    assert.ok(diff.includes('+++'), 'diff should contain header');
  });

  test('diff is empty when already v1', async () => {
    const dest = path.join(tmpDir, 'eval-tiers-v1.toml');
    fs.copyFileSync(V0_FIXTURE, dest);
    await migrate(dest); // migrate to v1

    const { diff } = await migrate(dest); // already v1
    assert.equal(diff, '');
  });

  test('malformed TOML throws clear error with file path', async () => {
    const dest = path.join(tmpDir, 'bad.toml');
    fs.writeFileSync(dest, 'not valid toml ====== !!!');

    await assert.rejects(
      () => migrate(dest),
      (err) => {
        assert.ok(err.message.includes('bad.toml') || err.message.includes('failed to parse'), err.message);
        return true;
      },
    );
  });

  test('non-existent file throws clear error', async () => {
    await assert.rejects(
      () => migrate(path.join(tmpDir, 'nonexistent.toml')),
      /cannot read/,
    );
  });
});
