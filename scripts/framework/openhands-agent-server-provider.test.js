'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const OpenhandsAgentServerProvider = require('./openhands-agent-server-provider');
const { __private } = OpenhandsAgentServerProvider;

const SAMPLE_OPENHANDS_CONFIG = {
  openhands_version: '1.21.1',
  openhands_server_url: 'http://127.0.0.1:18745',
  openhands_server_startup_timeout_ms: 30000,
  litellm_provider: 'anthropic',
  adapter: {
    agent_id: 'test-plugin:test-agent',
    agent_entrypoint_file: null,
    microagent_install_path: '.openhands/microagents/repo.md',
    agent_semantics: 'test-adapter semantics',
  },
  agent: {
    eval_light: { model: 'anthropic/claude-haiku-4-5-20251001', steps: 60 },
    eval_standard: { model: 'anthropic/claude-sonnet-4-6', steps: 100 },
  },
};

function makeSuite() {
  const evalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openhands-provider-test-'));
  // The provider resolves openhands.json relative to EVAL_ROOT (the harness's
  // own root for in-package tests). Symlink workspace path so the provider
  // finds the JSON file when it dereferences config.opencode_config.
  const evalLinkPath = path.resolve(__dirname, '..', '..', '.tmp', 'openhands-provider-test', path.basename(evalRoot));
  fs.mkdirSync(path.dirname(evalLinkPath), { recursive: true });
  try { fs.unlinkSync(evalLinkPath); } catch {}
  fs.symlinkSync(evalRoot, evalLinkPath);
  return {
    evalRoot,
    cleanup() {
      try { fs.unlinkSync(evalLinkPath); } catch {}
      fs.rmSync(evalRoot, { recursive: true, force: true });
    },
    relConfig: path.relative(path.resolve(__dirname, '..', '..'), path.join(evalLinkPath, 'openhands.json')),
    workspace: fs.mkdtempSync(path.join(evalRoot, 'ws-')),
    writeConfig(extra = {}) {
      const cfg = { ...SAMPLE_OPENHANDS_CONFIG, ...extra };
      fs.writeFileSync(path.join(evalLinkPath, 'openhands.json'), JSON.stringify(cfg, null, 2));
    },
  };
}

function fakeFinishStream(text) {
  return {
    connect() {
      return (async function* () {
        yield { kind: 'MessageEvent', source: 'agent', llm_message: { content: [{ type: 'text', text }] } };
        yield { kind: 'ConversationStateUpdateEvent', key: 'execution_status', value: 'finished' };
      })();
    },
  };
}

test('OpenhandsAgentServerProvider posts the documented OpenHands 1.21.1 REST payload shape', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  const calls = [];
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: {
        agent: 'eval_light',
        opencode_config: suite.relConfig,
        empty_output_retries: 0,
      },
      httpClient: {
        async post(url, body) {
          calls.push({ url, body });
          return { status: 200, json: { id: 'conv-uuid-123' } };
        },
      },
      wsClient: fakeFinishStream('hello world'),
    });

    const result = await provider.callApi(`Workspace: ${suite.workspace}\nrun status`);
    assert.deepEqual(result, { output: 'hello world' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:18745/api/conversations');
    assert.deepEqual(calls[0].body.workspace, { kind: 'LocalWorkspace', working_dir: suite.workspace });
    assert.equal(calls[0].body.agent.kind, 'Agent');
    assert.equal(calls[0].body.agent.llm.model, 'anthropic/claude-haiku-4-5-20251001');
    assert.equal(calls[0].body.initial_message.role, 'user');
    assert.equal(calls[0].body.initial_message.run, true);
    assert.equal(calls[0].body.initial_message.content[0].type, 'text');
    assert.match(calls[0].body.initial_message.content[0].text, /run status$/);
    assert.match(calls[0].body.initial_message.content[0].text, /^This is an automated eval run\./);
    assert.equal(calls[0].body.max_iterations, 60);
  } finally {
    suite.cleanup();
  }
});

test('OpenhandsAgentServerProvider writes provider.json + trajectory.json with adapter identity', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_standard', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 200, json: { id: 'c1' } }; } },
      wsClient: fakeFinishStream('done'),
    });
    await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);

    const provJson = JSON.parse(fs.readFileSync(path.join(suite.workspace, '.eval-run', 'provider.json'), 'utf8'));
    assert.equal(provJson.transport, 'openhands-rest+ws');
    assert.equal(provJson.agent, 'test-plugin:test-agent');
    assert.equal(provJson.agent_tier, 'eval_standard');
    assert.equal(provJson.agent_runtime, 'openhands-agent-server');
    assert.equal(provJson.agent_semantics, 'test-adapter semantics');
    assert.equal(provJson.plugin_runtime_loaded, false);
    assert.equal(provJson.workspace_kind, 'local');
    assert.equal(provJson.microagent_installed_path, null); // no entrypoint file → no install
    assert.equal(provJson.model, 'anthropic/claude-sonnet-4-6');
    assert.equal(provJson.litellm_provider, 'anthropic');
    assert.equal(provJson.openhands_version, '1.21.1');

    const traj = JSON.parse(fs.readFileSync(path.join(suite.workspace, '.eval-run', 'trajectory.json'), 'utf8'));
    assert.equal(traj.length, 2);
    assert.equal(traj[0].kind, 'MessageEvent');
    assert.equal(traj[1].kind, 'ConversationStateUpdateEvent');
  } finally {
    suite.cleanup();
  }
});

test('OpenhandsAgentServerProvider drains FinishAction text when MessageEvent is absent', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 200, json: { id: 'c1' } }; } },
      wsClient: {
        connect() {
          return (async function* () {
            yield { kind: 'ActionEvent', action: { kind: 'FinishAction', message: 'final answer via finish tool' } };
            yield { kind: 'ConversationStateUpdateEvent', key: 'execution_status', value: 'finished' };
          })();
        },
      },
    });

    const result = await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);
    assert.deepEqual(result, { output: 'final answer via finish tool' });
  } finally {
    suite.cleanup();
  }
});

test('OpenhandsAgentServerProvider surfaces ConversationErrorEvent as a provider error', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 200, json: { id: 'c1' } }; } },
      wsClient: {
        connect() {
          return (async function* () {
            yield { kind: 'ConversationErrorEvent', code: 'LLMError', detail: 'upstream rate limit' };
          })();
        },
      },
    });

    const result = await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);
    assert.deepEqual(result, { error: 'OpenHands LLMError: upstream rate limit' });
  } finally {
    suite.cleanup();
  }
});

test('OpenhandsAgentServerProvider surfaces non-2xx REST status as a provider error', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 500, json: { detail: 'bad request' } }; } },
      wsClient: fakeFinishStream('unreachable'),
    });

    const result = await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);
    assert.match(result.error, /OpenHands POST \/api\/conversations failed: status 500/);
  } finally {
    suite.cleanup();
  }
});

test('OpenhandsAgentServerProvider rejects adapter config missing agent_id', async () => {
  const suite = makeSuite();
  suite.writeConfig({ adapter: {} });
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post() { return { status: 200, json: { id: 'c1' } }; } },
      wsClient: fakeFinishStream('x'),
    });
    const result = await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);
    assert.match(result.error, /adapter\.agent_id/);
  } finally {
    suite.cleanup();
  }
});

test('OpenhandsAgentServerProvider rejects missing config.agent', async () => {
  const provider = new OpenhandsAgentServerProvider({ config: {} });
  const result = await provider.callApi('prompt');
  assert.deepEqual(result, { error: 'OpenHands provider requires the agent tier name in config.agent' });
});

test('OPENHANDS_MODEL_OVERRIDE wins over the tier model', async () => {
  const suite = makeSuite();
  suite.writeConfig();
  const previous = process.env.OPENHANDS_MODEL_OVERRIDE;
  const previousKey = process.env.OPENCODE_API_KEY;
  process.env.OPENHANDS_MODEL_OVERRIDE = 'opencode-go/qwen3.5-plus';
  process.env.OPENCODE_API_KEY = 'test-key';
  try {
    const calls = [];
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
      httpClient: { async post(_url, body) { calls.push(body); return { status: 200, json: { id: 'c1' } }; } },
      wsClient: fakeFinishStream('done'),
    });
    await provider.callApi(`Workspace: ${suite.workspace}\nprompt`);

    assert.equal(calls[0].agent.llm.model, 'openai/qwen3.5-plus');
    assert.equal(calls[0].agent.llm.api_key, 'test-key');
    assert.equal(calls[0].agent.llm.base_url, 'https://opencode.ai/zen/v1');
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_MODEL_OVERRIDE;
    else process.env.OPENHANDS_MODEL_OVERRIDE = previous;
    if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousKey;
    suite.cleanup();
  }
});

test('buildLlmPayload threads api_key for LiteLLM-native providers', () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const payload = __private.buildLlmPayload('anthropic/claude-haiku-4-5-20251001');
    assert.equal(payload.model, 'anthropic/claude-haiku-4-5-20251001');
    assert.equal(payload.api_key, 'sk-test');
    assert.equal(payload.base_url, undefined);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('extractWorkspace parses both prompt conventions', () => {
  assert.equal(__private.extractWorkspace('Workspace: /tmp/ws-1\nrun status'), '/tmp/ws-1');
  assert.equal(__private.extractWorkspace('You are operating in workspace /tmp/ws-2. Do X.'), '/tmp/ws-2');
  assert.equal(__private.extractWorkspace('no workspace mentioned'), null);
});

// ---------------------------------------------------------------------------
// Phase 07 — T11/T11b/T12: OPENHANDS_SERVER_URL + model precedence
// ---------------------------------------------------------------------------

test('T11 — OPENHANDS_SERVER_URL env (non-empty) overrides openhands.json url', () => {
  const suite = makeSuite();
  suite.writeConfig();
  const previous = process.env.OPENHANDS_SERVER_URL;
  process.env.OPENHANDS_SERVER_URL = 'http://127.0.0.1:19999';
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
    });
    const cfg = provider._readOpenhandsConfig();
    assert.equal(cfg.openhands_server_url, 'http://127.0.0.1:19999');
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_SERVER_URL;
    else process.env.OPENHANDS_SERVER_URL = previous;
    suite.cleanup();
  }
});

test('T12 — OPENHANDS_SERVER_URL="" (empty) does NOT override; JSON value is used', () => {
  const suite = makeSuite();
  suite.writeConfig();
  const previous = process.env.OPENHANDS_SERVER_URL;
  process.env.OPENHANDS_SERVER_URL = '';
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', opencode_config: suite.relConfig },
    });
    const cfg = provider._readOpenhandsConfig();
    assert.equal(cfg.openhands_server_url, SAMPLE_OPENHANDS_CONFIG.openhands_server_url);
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_SERVER_URL;
    else process.env.OPENHANDS_SERVER_URL = previous;
    suite.cleanup();
  }
});

test('T11b/1 — _resolveTierConfig: openhands.json fallback when no env and no config.model', () => {
  const previous = process.env.OPENHANDS_MODEL_OVERRIDE;
  delete process.env.OPENHANDS_MODEL_OVERRIDE;
  try {
    const provider = new OpenhandsAgentServerProvider({ config: { agent: 'eval_light' } });
    const cfg = { agent: { eval_light: { model: 'anthropic/claude-haiku-4-5-20251001' } } };
    assert.equal(provider._resolveTierConfig(cfg).model, 'anthropic/claude-haiku-4-5-20251001');
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_MODEL_OVERRIDE;
    else process.env.OPENHANDS_MODEL_OVERRIDE = previous;
  }
});

test('T11b/2 — _resolveTierConfig: config.model wins over openhands.json fallback', () => {
  const previous = process.env.OPENHANDS_MODEL_OVERRIDE;
  delete process.env.OPENHANDS_MODEL_OVERRIDE;
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', model: 'openai/gpt-4o-mini' },
    });
    const cfg = { agent: { eval_light: { model: 'anthropic/claude-haiku-4-5-20251001' } } };
    assert.equal(provider._resolveTierConfig(cfg).model, 'openai/gpt-4o-mini');
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_MODEL_OVERRIDE;
    else process.env.OPENHANDS_MODEL_OVERRIDE = previous;
  }
});

test('T11b/3 — _resolveTierConfig: env OPENHANDS_MODEL_OVERRIDE wins over config.model', () => {
  const previous = process.env.OPENHANDS_MODEL_OVERRIDE;
  process.env.OPENHANDS_MODEL_OVERRIDE = 'anthropic/claude-sonnet-4-6';
  try {
    const provider = new OpenhandsAgentServerProvider({
      config: { agent: 'eval_light', model: 'openai/gpt-4o-mini' },
    });
    const cfg = { agent: { eval_light: { model: 'anthropic/claude-haiku-4-5-20251001' } } };
    assert.equal(provider._resolveTierConfig(cfg).model, 'anthropic/claude-sonnet-4-6');
  } finally {
    if (previous === undefined) delete process.env.OPENHANDS_MODEL_OVERRIDE;
    else process.env.OPENHANDS_MODEL_OVERRIDE = previous;
  }
});
