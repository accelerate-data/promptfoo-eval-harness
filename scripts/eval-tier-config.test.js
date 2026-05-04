const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CONFIG_PATH,
  loadEvalTierConfig,
  resolveEvalTier,
} = require('./framework/eval-tier-config');

const AGENT_PERMISSION = {
  read: 'allow',
  write: 'allow',
  edit: 'allow',
  bash: 'allow',
  grep: 'allow',
  glob: 'allow',
  list: 'allow',
  webfetch: 'deny',
};

test('loadEvalTierConfig returns required suite tiers and OpenCode agents', () => {
  const config = loadEvalTierConfig();

  assert.equal(config.runtime.providerId, 'file://scripts/framework/opencode-cli-provider.js');
  assert.equal(config.runtime.opencodeConfig, path.resolve(path.dirname(CONFIG_PATH), '..', 'opencode.json'));
  assert.equal(config.runtime.projectDir, path.resolve(path.dirname(CONFIG_PATH), '..', '..', '..'));
  assert.equal(config.runtime.format, 'default');
  assert.equal(config.runtime.logLevel, 'ERROR');
  assert.equal(config.runtime.printLogs, false);
  assert.equal(config.runtime.emptyOutputRetries, 1);
  assert.deepEqual(
    Object.keys(config.tiers).sort(),
    ['high', 'light', 'standard', 'x_high'],
  );
  assert.deepEqual(config.tiers.light, { agent: 'eval_light' });
  assert.deepEqual(config.tiers.standard, { agent: 'eval_standard' });
  assert.equal(config.agents.eval_light.model, 'opencode-go/minimax-m2.7');
  assert.equal(config.agents.eval_light.temperature, 0.1);
  assert.equal(config.agents.eval_light.steps, 60);
  assert.deepEqual(config.agents.eval_light.permission, AGENT_PERMISSION);
});

test('resolveEvalTier returns the expected OpenCode agent', () => {
  const config = loadEvalTierConfig();

  assert.equal(resolveEvalTier(config, 'light').agent, 'eval_light');
  assert.equal(resolveEvalTier(config, 'standard').agent, 'eval_standard');
  assert.equal(resolveEvalTier(config, 'high').agent, 'eval_high');
  assert.equal(resolveEvalTier(config, 'x_high').agent, 'eval_x_high');
});

test('resolveEvalTier rejects unknown tiers', () => {
  const config = loadEvalTierConfig();

  assert.throws(() => resolveEvalTier(config, 'missing'), /Unknown eval tier: missing/);
});

test('loadEvalTierConfig rejects missing runtime and tier fields', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-tier-config-'));
  try {
    const writeOpenCodeConfig = (agents) => {
      const opencodePath = path.join(tempRoot, 'opencode.json');
      fs.writeFileSync(opencodePath, JSON.stringify({ agent: agents }, null, 2), 'utf8');
    };
    const validAgents = {
      eval_light: {
        description: 'Light eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        temperature: 0.1,
        steps: 60,
        permission: AGENT_PERMISSION,
      },
      eval_standard: {
        description: 'Standard eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        temperature: 0.1,
        steps: 100,
        permission: AGENT_PERMISSION,
      },
      eval_high: {
        description: 'High eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        temperature: 0.1,
        steps: 120,
        permission: AGENT_PERMISSION,
      },
      eval_x_high: {
        description: 'Extra high eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        temperature: 0.1,
        steps: 200,
        permission: AGENT_PERMISSION,
      },
    };
    writeOpenCodeConfig(validAgents);

    const validRuntime = `
[runtime]
provider_id = "file://scripts/framework/opencode-cli-provider.js"
opencode_config = "opencode.json"
project_dir = "."
format = "default"
log_level = "ERROR"
print_logs = false
empty_output_retries = 1
`.trimStart();
    const validTiers = `
[tiers.light]
agent = "eval_light"

[tiers.standard]
agent = "eval_standard"

[tiers.high]
agent = "eval_high"

[tiers.x_high]
agent = "eval_x_high"
`.trimStart();

    const missingRuntimePath = path.join(tempRoot, 'missing-runtime.toml');
    fs.writeFileSync(missingRuntimePath, `
[runtime]
provider_id = "file://scripts/framework/opencode-cli-provider.js"
project_dir = "."
format = "default"
log_level = "ERROR"
print_logs = false

${validTiers}
`.trimStart(), 'utf8');

    assert.throws(
      () => loadEvalTierConfig(missingRuntimePath),
      /Missing required eval runtime field: opencode_config/,
    );

    const missingTierPath = path.join(tempRoot, 'missing-tier.toml');
    fs.writeFileSync(missingTierPath, `
${validRuntime}
[tiers.light]
agent = "eval_light"

[tiers.standard]
agent = "eval_standard"

[tiers.high]
agent = "eval_high"
`.trimStart(), 'utf8');

    assert.throws(
      () => loadEvalTierConfig(missingTierPath),
      /Missing required eval tier: x_high/,
    );

    const invalidAgentPath = path.join(tempRoot, 'invalid-agent.toml');
    fs.writeFileSync(invalidAgentPath, `
${validRuntime}
[tiers.light]
agent = "missing_agent"

[tiers.standard]
agent = "eval_standard"

[tiers.high]
agent = "eval_high"

[tiers.x_high]
agent = "eval_x_high"
`.trimStart(), 'utf8');

    assert.throws(
      () => loadEvalTierConfig(invalidAgentPath),
      /Eval tier light references missing OpenCode agent: missing_agent/,
    );

    const malformedAgentPath = path.join(tempRoot, 'malformed-agent.toml');
    fs.writeFileSync(malformedAgentPath, `
${validRuntime}
${validTiers}
`.trimStart(), 'utf8');
    writeOpenCodeConfig({
      ...validAgents,
      eval_light: {
        description: 'Light eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        temperature: 0.1,
        steps: 'sixty',
        permission: AGENT_PERMISSION,
      },
    });

    assert.throws(
      () => loadEvalTierConfig(malformedAgentPath),
      /Invalid OpenCode eval agent field: eval_light.steps/,
    );

    writeOpenCodeConfig({
      ...validAgents,
      eval_light: {
        description: 'Light eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        steps: 60,
        permission: AGENT_PERMISSION,
      },
    });

    assert.doesNotThrow(() => loadEvalTierConfig(malformedAgentPath));

    writeOpenCodeConfig({
      ...validAgents,
      build: {
        mode: 'primary',
      },
    });
    const nonEvalAgentPath = path.join(tempRoot, 'non-eval-agent.toml');
    fs.writeFileSync(nonEvalAgentPath, `
${validRuntime}
[tiers.light]
agent = "build"

[tiers.standard]
agent = "eval_standard"

[tiers.high]
agent = "eval_high"

[tiers.x_high]
agent = "eval_x_high"
`.trimStart(), 'utf8');

    assert.throws(
      () => loadEvalTierConfig(nonEvalAgentPath),
      /Missing required OpenCode eval agent field: build.description/,
    );

    writeOpenCodeConfig({
      ...validAgents,
      eval_light: {
        description: 'Light eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        temperature: 0.1,
        steps: 60,
        permission: {
          ...AGENT_PERMISSION,
          webfetch: 'allow',
        },
      },
    });

    assert.throws(
      () => loadEvalTierConfig(malformedAgentPath),
      /Invalid OpenCode eval agent permission: eval_light.webfetch/,
    );

    writeOpenCodeConfig({
      ...validAgents,
      eval_light: {
        description: 'Light eval agent.',
        mode: 'primary',
        model: 'opencode-go/minimax-m2.7',
        temperature: 0.1,
        steps: 60,
        tools: AGENT_PERMISSION,
      },
    });

    assert.throws(
      () => loadEvalTierConfig(malformedAgentPath),
      /Missing required OpenCode eval agent field: eval_light.permission/,
    );

    writeOpenCodeConfig(validAgents);
    const deprecatedTierPath = path.join(tempRoot, 'deprecated-tier.toml');
    fs.writeFileSync(deprecatedTierPath, `
${validRuntime}
[tiers.light]
agent = "eval_light"
max_turns = 60

[tiers.standard]
agent = "eval_standard"

[tiers.high]
agent = "eval_high"

[tiers.x_high]
agent = "eval_x_high"
`.trimStart(), 'utf8');

    assert.throws(
      () => loadEvalTierConfig(deprecatedTierPath),
      /Unexpected eval tier field: light.max_turns/,
    );

    const deprecatedRuntimePath = path.join(tempRoot, 'deprecated-runtime.toml');
    fs.writeFileSync(deprecatedRuntimePath, `
${validRuntime}
model = "qwen3.6-plus"
${validTiers}
`.trimStart(), 'utf8');

    assert.throws(
      () => loadEvalTierConfig(deprecatedRuntimePath),
      /Unexpected eval runtime field: model/,
    );

    const negativeRetriesPath = path.join(tempRoot, 'negative-retries.toml');
    fs.writeFileSync(negativeRetriesPath, `
[runtime]
provider_id = "file://scripts/framework/opencode-cli-provider.js"
opencode_config = "opencode.json"
project_dir = "."
format = "default"
log_level = "ERROR"
print_logs = false
empty_output_retries = -1

${validTiers}
`.trimStart(), 'utf8');

    assert.throws(
      () => loadEvalTierConfig(negativeRetriesPath),
      /Invalid eval runtime field: empty_output_retries/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
