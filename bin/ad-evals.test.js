'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const { _anyTierUsesAgentServer } = require('./ad-evals');

describe('_anyTierUsesAgentServer — T14 unit helper', () => {
  test('returns true when any tier has provider_kind = openhands_agent_server', () => {
    const normalised = {
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
    assert.equal(_anyTierUsesAgentServer(normalised), true);
  });

  test('returns false when no tier uses openhands_agent_server', () => {
    const normalised = {
      tiers: {
        light: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-haiku-4-5' },
            { provider_kind: 'openhands_sdk', model: 'anthropic/claude-haiku-4-5' },
          ],
        },
      },
    };
    assert.equal(_anyTierUsesAgentServer(normalised), false);
  });

  test('returns false on null (no tier config file)', () => {
    assert.equal(_anyTierUsesAgentServer(null), false);
  });

  test('returns false when tiers key is missing or malformed', () => {
    assert.equal(_anyTierUsesAgentServer({}), false);
    assert.equal(_anyTierUsesAgentServer({ tiers: null }), false);
    assert.equal(_anyTierUsesAgentServer({ tiers: { light: {} } }), false);
    assert.equal(_anyTierUsesAgentServer({ tiers: { light: { providers: null } } }), false);
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
