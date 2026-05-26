const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const {
  TMP_ROOT,
  resolveConfigFile,
  resolveProviderId,
  writeResolvedConfig,
} = require('./framework/resolve-promptfoo-config');

test('resolveConfigFile materializes an opencode provider from metadata.eval_tier', () => {
  const resolved = resolveConfigFile('packages/harness-smoke/promptfooconfig.json');

  assert.equal(
    resolved.providers[0].id,
    `file://${path.join(path.dirname(TMP_ROOT), '..', 'scripts', 'framework', 'opencode-cli-provider.js')}`,
  );
  assert.equal(resolved.providers[0].config.agent, 'eval_light');
  assert.equal(resolved.providers[0].config.format, 'default');
  assert.equal(resolved.providers[0].config.log_level, 'ERROR');
  assert.equal(resolved.providers[0].config.print_logs, false);
  assert.equal(resolved.providers[0].config.empty_output_retries, 1);
  assert.match(resolved.providers[0].config.opencode_config, /opencode\.json$/);
  assert.equal(resolved.providers[0].config.project_dir, path.resolve(__dirname, '..', '..', '..'));
  assert.equal('max_turns' in resolved.providers[0].config, false);
  assert.equal('provider_id' in resolved.providers[0].config, false);
  assert.equal('tools' in resolved.providers[0].config, false);
  assert.equal(resolved.providers[0].config.model, undefined);
  assert.equal(resolved.providers[0].config.bootstrap_prompt, undefined);
  assert.equal(resolved.providers[0].config.capture_on_failure, undefined);
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
  assert.match(calls[2][2], /file:\/\/.*\/scripts\/framework\/opencode-cli-provider\.js/);
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
