'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const makeClaudeAgentSdkProvider = require('./claude-agent-sdk-provider');
const {
  TRANSPORT_NAME,
  PROVIDER_ID,
  DEFAULT_AUTO_REPLY_TEXT,
  DEFAULT_MAX_AUTO_REPLIES,
  DEFAULT_IDLE_TURN_STOP,
  extractWorkspace,
  resolveTierConfig,
  buildSdkRunMetadata,
  buildPlugins,
  resolveWorkspace,
} = makeClaudeAgentSdkProvider.__private;

test('factory returns provider with id/label/callApi and stable id', () => {
  const provider = makeClaudeAgentSdkProvider({ config: { agent: 'eval_light' } });
  assert.equal(typeof provider.id, 'function');
  assert.equal(provider.id(), PROVIDER_ID);
  assert.equal(typeof provider.label, 'string');
  assert.match(provider.label, /^claude_agent_sdk_node\/eval_light$/);
  assert.equal(typeof provider.callApi, 'function');
});

test('label includes agent_id when set', () => {
  const provider = makeClaudeAgentSdkProvider({
    config: {
      agent: 'eval_high',
      agent_id: 'vibedata-data-engineering:data-engineer',
    },
  });
  assert.equal(
    provider.label,
    'claude_agent_sdk_node/vibedata-data-engineering:data-engineer/eval_high',
  );
});

test('transport name is the unambiguous claude_agent_sdk_node string', () => {
  assert.equal(TRANSPORT_NAME, 'claude_agent_sdk_node');
});

test('defaults match consumer behavior (auto_reply_text, caps)', () => {
  assert.match(DEFAULT_AUTO_REPLY_TEXT, /Approved/);
  assert.equal(DEFAULT_MAX_AUTO_REPLIES, 5);
  assert.equal(DEFAULT_IDLE_TURN_STOP, 2);
});

test('extractWorkspace handles Workspace: / operating in workspace markers', () => {
  assert.equal(extractWorkspace('Workspace: /tmp/foo'), '/tmp/foo');
  assert.equal(extractWorkspace('operating in workspace /tmp/abc.'), '/tmp/abc');
  assert.equal(extractWorkspace('no marker'), null);
  assert.equal(extractWorkspace(null), null);
});

test('resolveWorkspace prefers vars.workspace over extractWorkspace and project_dir', () => {
  const projectDir = '/tmp/project';
  assert.equal(
    resolveWorkspace({}, { vars: { workspace: '/tmp/vars-win' } }, 'Workspace: /tmp/marker-lose', projectDir),
    '/tmp/vars-win',
  );
  assert.equal(
    resolveWorkspace({}, {}, 'Workspace: /tmp/marker-win', projectDir),
    '/tmp/marker-win',
  );
  assert.equal(resolveWorkspace({}, {}, 'no marker', projectDir), projectDir);
});

test('resolveTierConfig returns {} when args missing or unreadable', () => {
  assert.deepEqual(resolveTierConfig({}), {});
  assert.deepEqual(resolveTierConfig({ agent: 'eval_light' }), {});
  assert.deepEqual(
    resolveTierConfig({
      agent: 'eval_light',
      opencode_config: 'does-not-exist.json',
    }),
    {},
  );
});

test('buildSdkRunMetadata emits transport=claude_agent_sdk_node and required keys', () => {
  const meta = buildSdkRunMetadata({
    providerId: PROVIDER_ID,
    cfg: {
      agent: 'eval_light',
      agent_id: 'plugin:agent',
      agent_entrypoint_file: 'plugins/x/agent.md',
      opencode_config: 'codex-agent.json',
    },
    projectDir: '/tmp/project',
    plugins: [{ type: 'local', path: '/tmp/project/plugins/x' }],
  });
  assert.equal(meta.transport, TRANSPORT_NAME);
  assert.equal(meta.agent, 'plugin:agent');
  assert.equal(meta.agent_tier, 'eval_light');
  assert.equal(meta.agent_entrypoint_identity, 'plugin:agent');
  assert.equal(meta.agent_entrypoint_file, 'plugins/x/agent.md');
  assert.equal(meta.plugin_runtime_loaded, true);
  assert.deepEqual(meta.plugins, ['plugins/x']);
  assert.equal(meta.opencode_config, 'codex-agent.json');
});

test('buildSdkRunMetadata sets plugin_runtime_loaded false when no plugins', () => {
  const meta = buildSdkRunMetadata({
    providerId: PROVIDER_ID,
    cfg: { agent: 'eval_light' },
    projectDir: '/tmp/project',
    plugins: [],
  });
  assert.equal(meta.plugin_runtime_loaded, false);
  assert.equal(meta.agent, null);
  assert.equal(meta.agent_entrypoint_file, null);
  assert.deepEqual(meta.plugins, []);
});

test('buildPlugins resolves under projectDir and skips missing subdirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-plugins-'));
  const existing = path.join(tmp, 'present');
  fs.mkdirSync(existing, { recursive: true });
  const out = buildPlugins(
    { plugin_subdirs: ['present', 'missing'] },
    tmp,
  );
  assert.deepEqual(
    out.map((p) => p.path),
    [existing],
  );
});

test('buildPlugins returns [] when plugin_subdirs unset or not an array', () => {
  assert.deepEqual(buildPlugins({}, '/tmp'), []);
  assert.deepEqual(buildPlugins({ plugin_subdirs: null }, '/tmp'), []);
  assert.deepEqual(buildPlugins({ plugin_subdirs: 'not-array' }, '/tmp'), []);
});
