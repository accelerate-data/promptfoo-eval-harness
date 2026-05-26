'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadSdkPins } = require('./sdk-pins');

describe('sdk-pins', () => {
  test('loads sdk-pins.toml without error', () => {
    const pins = loadSdkPins();
    assert.ok(pins, 'should return an object');
  });

  describe('openhands_sdk section', () => {
    test('has required string fields', () => {
      const { openhands_sdk } = loadSdkPins();
      assert.strictEqual(typeof openhands_sdk.version, 'string', 'version must be string');
      assert.match(openhands_sdk.version, /^\d+\.\d+\.\d+$/, 'version must be semver');
      assert.strictEqual(typeof openhands_sdk.python, 'string', 'python must be string');
    });

    test('has extras as array', () => {
      const { openhands_sdk } = loadSdkPins();
      assert.ok(Array.isArray(openhands_sdk.extras), 'extras must be array');
    });

    test('has env_allowlist as non-empty array of strings', () => {
      const { openhands_sdk } = loadSdkPins();
      assert.ok(Array.isArray(openhands_sdk.env_allowlist), 'env_allowlist must be array');
      assert.ok(openhands_sdk.env_allowlist.length > 0, 'env_allowlist must not be empty');
      for (const key of openhands_sdk.env_allowlist) {
        assert.strictEqual(typeof key, 'string', `env_allowlist entry must be string, got: ${key}`);
      }
    });

    test('pins openhands-sdk at 1.22.1', () => {
      const { openhands_sdk } = loadSdkPins();
      assert.strictEqual(openhands_sdk.version, '1.22.1');
    });

    test('python constraint covers 3.12', () => {
      const { openhands_sdk } = loadSdkPins();
      assert.match(openhands_sdk.python, /3\.12/, 'python constraint must include 3.12');
    });
  });

  describe('opencode_cli section', () => {
    test('has required min_version string', () => {
      const { opencode_cli } = loadSdkPins();
      assert.strictEqual(typeof opencode_cli.min_version, 'string', 'min_version must be string');
      assert.match(opencode_cli.min_version, /^\d+\.\d+/, 'min_version must be semver-like');
    });

    test('has env_allowlist as non-empty array of strings', () => {
      const { opencode_cli } = loadSdkPins();
      assert.ok(Array.isArray(opencode_cli.env_allowlist), 'env_allowlist must be array');
      assert.ok(opencode_cli.env_allowlist.length > 0, 'env_allowlist must not be empty');
      for (const key of opencode_cli.env_allowlist) {
        assert.strictEqual(typeof key, 'string', `env_allowlist entry must be string, got: ${key}`);
      }
    });

    test('env_allowlist includes ANTHROPIC_API_KEY', () => {
      const { opencode_cli } = loadSdkPins();
      assert.ok(
        opencode_cli.env_allowlist.includes('ANTHROPIC_API_KEY'),
        'opencode_cli env_allowlist must include ANTHROPIC_API_KEY',
      );
    });
  });

  describe('claude_agent_sdk section', () => {
    test('has required string fields', () => {
      const { claude_agent_sdk } = loadSdkPins();
      assert.strictEqual(typeof claude_agent_sdk.version, 'string', 'version must be string');
      assert.match(claude_agent_sdk.version, /^\d+\.\d+\.\d+$/, 'version must be semver');
      assert.strictEqual(typeof claude_agent_sdk.python, 'string', 'python must be string');
    });

    test('has extras as array', () => {
      const { claude_agent_sdk } = loadSdkPins();
      assert.ok(Array.isArray(claude_agent_sdk.extras), 'extras must be array');
    });

    test('pins claude-agent-sdk at 0.2.85', () => {
      const { claude_agent_sdk } = loadSdkPins();
      assert.strictEqual(claude_agent_sdk.version, '0.2.85');
    });

    test('python constraint covers 3.12', () => {
      const { claude_agent_sdk } = loadSdkPins();
      assert.match(claude_agent_sdk.python, /3\.12/, 'python constraint must include 3.12');
    });

    test('env_allowlist is trimmed to ANTHROPIC_API_KEY (Minimalist #6)', () => {
      const { claude_agent_sdk } = loadSdkPins();
      assert.ok(Array.isArray(claude_agent_sdk.env_allowlist), 'env_allowlist must be array');
      assert.deepStrictEqual(
        claude_agent_sdk.env_allowlist,
        ['ANTHROPIC_API_KEY'],
        'v1.1.0 trims to ANTHROPIC_API_KEY only; Bedrock/Vertex/Foundry envs deferred',
      );
    });
  });

  describe('openhands_agent_server section', () => {
    test('has required string fields', () => {
      const { openhands_agent_server } = loadSdkPins();
      assert.strictEqual(typeof openhands_agent_server.version, 'string', 'version must be string');
      assert.match(openhands_agent_server.version, /^\d+\.\d+\.\d+$/, 'version must be semver');
      assert.strictEqual(
        typeof openhands_agent_server.tools_version,
        'string',
        'tools_version must be string',
      );
      assert.match(
        openhands_agent_server.tools_version,
        /^\d+\.\d+\.\d+$/,
        'tools_version must be semver',
      );
      assert.strictEqual(typeof openhands_agent_server.python, 'string', 'python must be string');
    });

    test('has extras as array', () => {
      const { openhands_agent_server } = loadSdkPins();
      assert.ok(Array.isArray(openhands_agent_server.extras), 'extras must be array');
    });

    test('pins openhands-agent-server and tools at 1.21.1 (source script lockstep)', () => {
      const { openhands_agent_server } = loadSdkPins();
      assert.strictEqual(openhands_agent_server.version, '1.21.1');
      assert.strictEqual(openhands_agent_server.tools_version, '1.21.1');
    });

    test('python constraint covers 3.12', () => {
      const { openhands_agent_server } = loadSdkPins();
      assert.match(openhands_agent_server.python, /3\.12/, 'python constraint must include 3.12');
    });

    test('env_allowlist is non-empty array of strings including LiteLLM provider keys', () => {
      const { openhands_agent_server } = loadSdkPins();
      assert.ok(Array.isArray(openhands_agent_server.env_allowlist), 'env_allowlist must be array');
      assert.ok(openhands_agent_server.env_allowlist.length > 0, 'env_allowlist must not be empty');
      for (const key of openhands_agent_server.env_allowlist) {
        assert.strictEqual(typeof key, 'string', `env_allowlist entry must be string, got: ${key}`);
      }
      // LiteLLM provider keys the daemon child needs to reach model APIs.
      for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENHANDS_MODEL_OVERRIDE']) {
        assert.ok(
          openhands_agent_server.env_allowlist.includes(key),
          `openhands_agent_server env_allowlist must include ${key}`,
        );
      }
      // OPENHANDS_SERVER_URL is injected on the promptfoo subprocess by the CLI;
      // it must NOT be forwarded into the daemon child env.
      assert.ok(
        !openhands_agent_server.env_allowlist.includes('OPENHANDS_SERVER_URL'),
        'OPENHANDS_SERVER_URL must NOT be in daemon-child env_allowlist',
      );
    });

    test('startup_timeout_ms is a positive number', () => {
      const { openhands_agent_server } = loadSdkPins();
      assert.strictEqual(
        typeof openhands_agent_server.startup_timeout_ms,
        'number',
        'startup_timeout_ms must be number',
      );
      assert.ok(
        openhands_agent_server.startup_timeout_ms > 0,
        'startup_timeout_ms must be positive',
      );
    });
  });

  test('throws on missing file', () => {
    assert.throws(
      () => loadSdkPins('/nonexistent/path/sdk-pins.toml'),
      /ENOENT/,
      'should throw ENOENT for missing file',
    );
  });
});
