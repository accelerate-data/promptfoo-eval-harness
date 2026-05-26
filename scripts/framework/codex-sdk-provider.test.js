'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const makeCodexSdkProvider = require('./codex-sdk-provider');
const { extractWorkspace, resolveTierConfig } = makeCodexSdkProvider.__private;

test('makeCodexSdkProvider returns Promptfoo-shaped provider with id/label/callApi', () => {
  const provider = makeCodexSdkProvider({ config: { agent: 'eval_light' } });
  assert.equal(typeof provider.id, 'function');
  assert.equal(provider.id(), 'framework://codex-sdk-provider.js');
  assert.equal(typeof provider.label, 'string');
  assert.match(provider.label, /codex_sdk\/eval_light/);
  assert.equal(typeof provider.callApi, 'function');
});

test('label includes agent_id when provided', () => {
  const provider = makeCodexSdkProvider({
    config: { agent: 'eval_high', agent_id: 'vibedata-data-engineering:data-engineer' },
  });
  assert.equal(provider.label, 'codex_sdk/vibedata-data-engineering:data-engineer/eval_high');
});

test('extractWorkspace handles Workspace: marker, operating in workspace, and trailing dot', () => {
  assert.equal(extractWorkspace('Workspace: /tmp/fixture'), '/tmp/fixture');
  assert.equal(extractWorkspace('operating in workspace /tmp/abc'), '/tmp/abc');
  assert.equal(extractWorkspace('Workspace: /tmp/with-dot.'), '/tmp/with-dot');
  assert.equal(extractWorkspace('no marker here'), null);
  assert.equal(extractWorkspace(null), null);
  assert.equal(extractWorkspace(undefined), null);
});

test('resolveTierConfig returns {} when args missing or file unreadable', () => {
  assert.deepEqual(resolveTierConfig(null, 'eval_light'), {});
  assert.deepEqual(resolveTierConfig('codex-agent.json', null), {});
  assert.deepEqual(resolveTierConfig('does-not-exist.json', 'eval_light'), {});
});

test('callApi resolves workspace_root from prompt marker over project_dir fallback', async () => {
  const captured = [];
  const fakeBridge = {
    id: () => 'fake-bridge-id',
    label: 'fake-bridge-label',
    async callApi(prompt, _ctx, _opts) {
      captured.push({ prompt });
      return { output: 'ok' };
    },
  };

  const originalBridgePath = require.resolve('./_node_bridge.js');
  const cached = require.cache[originalBridgePath];
  require.cache[originalBridgePath] = {
    id: originalBridgePath,
    filename: originalBridgePath,
    loaded: true,
    exports: (opts) => {
      captured.push({ config: opts.config });
      return fakeBridge;
    },
  };

  try {
    delete require.cache[require.resolve('./codex-sdk-provider')];
    const stubbedMaker = require('./codex-sdk-provider');
    const provider = stubbedMaker({
      config: {
        agent: 'eval_light',
        bootstrap_prompt: 'BOOTSTRAP',
        project_dir: '.',
      },
    });

    await provider.callApi('Workspace: /tmp/fixture-x\nDo X');

    const cfgEntry = captured.find((c) => c.config);
    assert.equal(cfgEntry.config.provider_kind, 'codex_sdk');
    assert.equal(cfgEntry.config.workspace_root, path.resolve('/tmp/fixture-x'));
    assert.equal(cfgEntry.config.extra.sandbox_mode, 'danger-full-access');
    assert.equal(cfgEntry.config.extra.reasoning_effort, 'medium');
    assert.equal(cfgEntry.config.extra.approval_policy, 'never');

    const promptEntry = captured.find((c) => c.prompt);
    assert.equal(promptEntry.prompt, 'BOOTSTRAP\n\nWorkspace: /tmp/fixture-x\nDo X');
  } finally {
    if (cached) {
      require.cache[originalBridgePath] = cached;
    } else {
      delete require.cache[originalBridgePath];
    }
    delete require.cache[require.resolve('./codex-sdk-provider')];
  }
});

test('callApi omits workspace_root when no marker and no project_dir', async () => {
  const captured = [];
  const originalBridgePath = require.resolve('./_node_bridge.js');
  const cached = require.cache[originalBridgePath];
  require.cache[originalBridgePath] = {
    id: originalBridgePath,
    filename: originalBridgePath,
    loaded: true,
    exports: (opts) => {
      captured.push({ config: opts.config });
      return {
        id: () => 'x',
        label: 'x',
        async callApi() {
          return { output: '' };
        },
      };
    },
  };

  try {
    delete require.cache[require.resolve('./codex-sdk-provider')];
    const stubbedMaker = require('./codex-sdk-provider');
    const provider = stubbedMaker({ config: { agent: 'eval_light' } });
    await provider.callApi('Just a plain prompt');
    assert.equal('workspace_root' in captured[0].config, false);
  } finally {
    if (cached) {
      require.cache[originalBridgePath] = cached;
    } else {
      delete require.cache[originalBridgePath];
    }
    delete require.cache[require.resolve('./codex-sdk-provider')];
  }
});
