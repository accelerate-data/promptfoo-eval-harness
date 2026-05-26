'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const {
  _tierUsesAgentServer,
  _readEvalTierFromConfig,
  _configsUseAgentServer,
} = require('./ad-evals');

const NORMALISED_FIXTURE = {
  defaults: { tier: 'light' },
  tiers: {
    light: {
      providers: [
        { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5' },
        { provider_kind: 'openhands_agent_server', agent: 'eval_light' },
      ],
    },
    standard: {
      providers: [{ provider_kind: 'opencode_cli', model: 'anthropic/claude-sonnet-4-6' }],
    },
  },
};

describe('_tierUsesAgentServer — T14 unit helper', () => {
  test('returns true when the named tier declares openhands_agent_server', () => {
    assert.equal(_tierUsesAgentServer(NORMALISED_FIXTURE, 'light'), true);
  });

  test('returns false when the named tier does NOT declare openhands_agent_server', () => {
    assert.equal(_tierUsesAgentServer(NORMALISED_FIXTURE, 'standard'), false);
  });

  test('returns false on missing tier name, null normalised, or malformed structure', () => {
    assert.equal(_tierUsesAgentServer(null, 'light'), false);
    assert.equal(_tierUsesAgentServer(NORMALISED_FIXTURE, null), false);
    assert.equal(_tierUsesAgentServer(NORMALISED_FIXTURE, 'missing'), false);
    assert.equal(_tierUsesAgentServer({}, 'light'), false);
    assert.equal(_tierUsesAgentServer({ tiers: { light: { providers: null } } }, 'light'), false);
  });
});

describe('_readEvalTierFromConfig — T14 unit helper', () => {
  let tmpDir;

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-test-'));
  });

  test.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parses metadata.eval_tier from a JSON config', () => {
    const p = path.join(tmpDir, 'a.json');
    fs.writeFileSync(p, JSON.stringify({ metadata: { eval_tier: 'standard' } }));
    assert.equal(_readEvalTierFromConfig(p), 'standard');
  });

  test('parses metadata.eval_tier from a YAML config', () => {
    const p = path.join(tmpDir, 'a.yaml');
    fs.writeFileSync(p, 'metadata:\n  eval_tier: light\n');
    assert.equal(_readEvalTierFromConfig(p), 'light');
  });

  test('returns null for missing files, unknown extensions, and configs without metadata.eval_tier', () => {
    assert.equal(_readEvalTierFromConfig(path.join(tmpDir, 'missing.json')), null);
    assert.equal(_readEvalTierFromConfig(null), null);
    const noTier = path.join(tmpDir, 'b.json');
    fs.writeFileSync(noTier, JSON.stringify({ description: 'no tier' }));
    assert.equal(_readEvalTierFromConfig(noTier), null);
    const unknown = path.join(tmpDir, 'c.txt');
    fs.writeFileSync(unknown, 'metadata:\n  eval_tier: light\n');
    assert.equal(_readEvalTierFromConfig(unknown), null);
  });
});

describe('_configsUseAgentServer — T14 unit helper', () => {
  let tmpDir;

  test.before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-test-'));
  });

  test.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns true when a config\'s eval_tier maps to a tier using openhands_agent_server', () => {
    const p = path.join(tmpDir, 'uses.json');
    fs.writeFileSync(p, JSON.stringify({ metadata: { eval_tier: 'light' } }));
    assert.equal(_configsUseAgentServer([p], NORMALISED_FIXTURE), true);
  });

  test('returns false when configs target only non-agent-server tiers', () => {
    const p = path.join(tmpDir, 'safe.json');
    fs.writeFileSync(p, JSON.stringify({ metadata: { eval_tier: 'standard' } }));
    assert.equal(_configsUseAgentServer([p], NORMALISED_FIXTURE), false);
  });

  test('falls back to defaults.tier when a config has no metadata.eval_tier', () => {
    const p = path.join(tmpDir, 'no-tier.json');
    fs.writeFileSync(p, JSON.stringify({ description: 'no tier' }));
    assert.equal(_configsUseAgentServer([p], NORMALISED_FIXTURE), true);
    const noDefaults = { ...NORMALISED_FIXTURE, defaults: undefined };
    assert.equal(_configsUseAgentServer([p], noDefaults), false);
  });

  test('returns false on empty input or null normalised', () => {
    assert.equal(_configsUseAgentServer([], NORMALISED_FIXTURE), false);
    assert.equal(_configsUseAgentServer(['/whatever.json'], null), false);
  });
});

describe('bin/ad-evals smoke — T15 gated E2E', () => {
  test(
    'E2E: smoke command boots agent-server, runs promptfoo, and tears the daemon down',
    { skip: process.env.OPENHANDS_E2E !== '1', timeout: 180_000 },
    () => {
      const repoRoot = path.resolve(__dirname, '..');
      const evalRoot = path.join(repoRoot, 'examples', 'harness-smoke-agent-server');

      const result = spawnSync('node', ['./bin/ad-evals.js', 'smoke'], {
        cwd: repoRoot,
        env: { ...process.env, AD_EVALS_ROOT: evalRoot },
        encoding: 'utf8',
      });

      const combined = `${result.stdout || ''}${result.stderr || ''}`;
      assert.equal(result.status, 0, `smoke failed: ${combined}`);
      assert.match(combined, /\[ad-evals\] agent-server ready on http:\/\/127\.0\.0\.1:/);

      const ps = execSync('pgrep -f "agent-server.*--port" || true').toString();
      assert.equal(ps.trim(), '', 'no orphan agent-server process should remain');
    },
  );
});
