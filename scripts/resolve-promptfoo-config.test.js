const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const {
  TMP_ROOT,
  BRIDGE_FILE_URL,
  resolveConfigFile,
  resolveProviderId,
  writeResolvedConfig,
} = require('./framework/resolve-promptfoo-config');

test('resolveConfigFile materializes the default openhands_sdk bridge provider from metadata.eval_tier', () => {
  const resolved = resolveConfigFile('packages/harness-smoke/promptfooconfig.json');

  // The shipped config/eval-tiers.toml is v1 and defaults every tier to
  // openhands_sdk, so the resolver emits a single bridge provider (not the
  // legacy opencode_cli block). See config/eval-tiers.toml.
  assert.equal(resolved.providers[0].id, BRIDGE_FILE_URL);
  assert.equal(resolved.providers[0].label, 'openhands-sdk/gpt-4o-mini');
  assert.equal(resolved.providers[0].config.provider_kind, 'openhands_sdk');
  assert.equal(resolved.providers[0].config.model, 'openai/gpt-4o-mini');
  assert.equal(resolved.providers[0].config.provider_label, 'openhands-sdk/gpt-4o-mini');
  assert.equal(typeof resolved.providers[0].config.run_id, 'string');
  assert.match(resolved.providers[0].config.case_id, /:light:p0:s0$/);
  assert.equal('agent' in resolved.providers[0].config, false);
  assert.equal('opencode_config' in resolved.providers[0].config, false);
  assert.match(resolved.prompts[0], /harness-smoke/);
});

test('resolveConfigFile rejects configs missing metadata.eval_tier', () => {
  const relativePath = 'scripts/fixtures/missing-eval-tier.json';

  assert.throws(
    () => resolveConfigFile(relativePath),
    new RegExp(`${relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is missing metadata\\.eval_tier`),
  );
});

test('resolveConfigFile rejects traversal outside the eval root', () => {
  assert.throws(
    () => resolveConfigFile('packages/../../foo.yaml'),
    /Refusing to access config outside eval root: packages\/\.\.\/\.\.\/foo\.yaml/,
  );
});

test('writeResolvedConfig writes suite-owned resolved configs only under .tmp', () => {
  const calls = [];
  const relativePath = writeResolvedConfig(
    'packages/harness-smoke/promptfooconfig.json',
    {
      fsImpl: {
        mkdirSync: (targetPath, options) => {
          calls.push(['mkdir', targetPath, options]);
        },
        writeFileSync: (targetPath, contents, encoding) => {
          calls.push(['write', targetPath, contents, encoding]);
        },
      },
    },
  );

  assert.match(relativePath, /^\.tmp\/resolved-configs\/packages\/harness-smoke\/promptfooconfig\.json$/);
  assert.deepEqual(calls[0], ['mkdir', TMP_ROOT, { recursive: true }]);
  assert.deepEqual(calls[1], [
    'mkdir',
    path.join(TMP_ROOT, 'packages', 'harness-smoke'),
    { recursive: true },
  ]);
  assert.equal(calls[2][0], 'write');
  assert.equal(calls[2][1], path.join(TMP_ROOT, 'packages', 'harness-smoke', 'promptfooconfig.json'));
  assert.match(calls[2][2], /file:\/\/.*\/scripts\/framework\/_node_bridge\.js/);
  assert.match(calls[2][2], /provider_kind: openhands_sdk/);
  assert.equal(calls[2][3], 'utf8');
});

test('resolveProviderId makes local file providers stable from materialized configs', () => {
  assert.equal(
    resolveProviderId('file://scripts/framework/opencode-cli-provider.js'),
    `file://${path.join(path.dirname(TMP_ROOT), '..', 'scripts', 'framework', 'opencode-cli-provider.js')}`,
  );
  assert.equal(resolveProviderId('custom:provider'), 'custom:provider');
});

test('writeResolvedConfig rejects traversal outside the resolved-config output root', () => {
  assert.throws(
    () => writeResolvedConfig(
      'packages/harness-smoke/promptfooconfig.json',
      {
        fsImpl: {
          mkdirSync: () => {
            throw new Error('should not mkdir');
          },
          writeFileSync: () => {
            throw new Error('should not write');
          },
        },
        outputRoot: path.join(TMP_ROOT, '..'),
      },
    ),
    /Refusing to write resolved configs outside \.tmp\/resolved-configs/,
  );
});
