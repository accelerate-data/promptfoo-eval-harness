// OpenHands Agent Server provider for Promptfoo.
//
// Canonical URL: framework://openhands-agent-server-provider.js
//   (resolved by scripts/framework/resolve-promptfoo-config.js into a
//   file:// URL under FRAMEWORK_ROOT — see roots.js)
//
// Daemon lifecycle: the harness CLI (bin/ad-evals.js) auto-spawns an
// openhands-agent-server child on a dynamic 127.0.0.1 port BEFORE invoking
// promptfoo, and exports OPENHANDS_SERVER_URL into the promptfoo subprocess
// env. This provider reads that env var inside _readOpenhandsConfig() and
// overrides cfg.openhands_server_url at runtime. If the env var is unset or
// empty, the provider falls back to openhands.json's openhands_server_url
// (manual-debug path: point at an externally-running daemon).
//
// LiteLLM lives inside the server, so API keys and base_url are threaded
// through the REST payload — env vars in this process are not visible to
// the server's LiteLLM stack.
//
// Adapter identity (agent_id, entrypoint file, microagent install path) is
// fully driven by the consumer's openhands.json under the `adapter` block.

const fs = require('node:fs');
const path = require('node:path');

const { EVAL_ROOT, REPO_ROOT } = require('./roots');

const DEFAULT_MICROAGENT_REL_PATH = '.openhands/microagents/repo.md';
const DEFAULT_AGENT_SEMANTICS = 'openhands-microagent with skill-via-bash loading';
const DEFAULT_EVAL_MODE_PREAMBLE = [
  'This is an automated eval run.',
  'Auto-proceed at every gate without pausing for user confirmation.',
  'Select the first/recommended option at every decision point.',
].join(' ');

// Idle/stall watchdog: if no WS stream event arrives for this many ms,
// conclude the turn with whatever partial output has been collected so far
// instead of hanging until the outer promptfoo timeout. Mirrors the
// STREAM_IDLE_TIMEOUT_MS floor rationale in the legacy scripts/openhands-provider.js
// this provider replaces — a cold Fabric/dbt build on a Spark session can be
// silent 5-10 min, so the floor must clear that. env-tunable via
// OPENHANDS_STREAM_IDLE_TIMEOUT_MS — same var name as the legacy provider, so
// one setting covers both providers during the -oh migration.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 900_000;

// Note: 0 is treated as "unset" here (falls through to env/default), not as
// "disable the watchdog" — nothing in this codebase needs disable semantics
// today. If that's ever needed, this precedence chain needs an explicit
// `options.idleTimeoutMs === 0` check before it, since `0 || fallback` would
// otherwise silently discard an intentional 0.
function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// LiteLLM has no native opencode-go provider; the upstream Zen subscription is
// OpenAI-wire-compatible at this base URL, so we remap `opencode-go/<model>`
// to `openai/<model>` and forward api_key + base_url.
const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/v1';

function extractWorkspace(prompt) {
  const m = prompt.match(/(?:Workspace:|operating in workspace)\s*(\S+)/i);
  return m ? m[1].replace(/\.$/, '') : null;
}

function allocateFallbackWorkspace() {
  const root = path.join(EVAL_ROOT, '.workspaces', 'provider-runs');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'openhands-'));
}

function writeProviderRunMetadata(workspace, metadata) {
  const runDir = path.join(workspace, '.eval-run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'provider.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
}

function defaultHttpClient() {
  const http = require('node:http');
  return {
    async post(url, body) {
      const parsed = new URL(url);
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
            catch { resolve({ status: res.statusCode, json: null, text }); }
          });
        });
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
      });
    },
  };
}

function defaultWsClient() {
  let WebSocket;
  return {
    // Returns { events, close }. Callers MUST invoke close() in a finally
    // block after iterating `events`; without it, the underlying socket
    // stays open after a terminal event (execution_status=finished) and
    // keeps the Node event loop alive until the server closes the
    // connection or an outer timeout fires.
    connect(url) {
      if (!WebSocket) WebSocket = require('ws');
      const sock = new WebSocket(url);
      const queue = [];
      let waiter = null;
      let closed = false;
      sock.on('message', (data) => {
        let parsed;
        try { parsed = JSON.parse(data.toString('utf8')); }
        catch { parsed = { kind: 'raw', text: data.toString('utf8') }; }
        if (waiter) { const w = waiter; waiter = null; w(parsed); }
        else queue.push(parsed);
      });
      sock.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(null); } });
      sock.on('error', () => {
        closed = true;
        if (waiter) { const w = waiter; waiter = null; w(null); }
      });
      const events = (async function* events() {
        while (true) {
          if (queue.length) {
            const ev = queue.shift();
            yield ev;
            if (ev.kind === 'result') return;
            continue;
          }
          if (closed) return;
          const next = await new Promise((resolve) => { waiter = resolve; });
          if (next === null) return;
          yield next;
          if (next.kind === 'result') return;
        }
      })();
      const close = () => {
        if (closed) return;
        try { sock.close(); } catch { /* ignore */ }
        try { sock.terminate(); } catch { /* ignore */ }
      };
      return { events, close };
    },
  };
}

function deriveLitellmProvider(model) {
  if (!model || typeof model !== 'string') return null;
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(0, slash);
}

function buildLlmPayload(model) {
  if (!model || typeof model !== 'string') return { model };
  const provider = deriveLitellmProvider(model);
  const rest = model.slice(model.indexOf('/') + 1);
  if (provider === 'opencode-go') {
    const apiKey = process.env.OPENCODE_API_KEY;
    if (!apiKey) {
      throw new Error('OPENCODE_API_KEY is required for opencode-go/* models');
    }
    return { model: `openai/${rest}`, api_key: apiKey, base_url: OPENCODE_GO_BASE_URL };
  }
  const apiKey = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    groq: process.env.GROQ_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
  }[provider];
  const payload = { model };
  if (apiKey) payload.api_key = apiKey;
  return payload;
}

function resolveAdapter(cfg) {
  const adapter = (cfg && typeof cfg.adapter === 'object' && cfg.adapter !== null) ? cfg.adapter : {};
  if (typeof adapter.agent_id !== 'string' || adapter.agent_id.trim() === '') {
    throw new Error('OpenHands provider requires adapter.agent_id in openhands.json');
  }
  return {
    agentId: adapter.agent_id,
    agentEntrypointFile: typeof adapter.agent_entrypoint_file === 'string' && adapter.agent_entrypoint_file.trim()
      ? adapter.agent_entrypoint_file
      : null,
    microagentRelPath: typeof adapter.microagent_install_path === 'string' && adapter.microagent_install_path.trim()
      ? adapter.microagent_install_path
      : DEFAULT_MICROAGENT_REL_PATH,
    agentSemantics: typeof adapter.agent_semantics === 'string' && adapter.agent_semantics.trim()
      ? adapter.agent_semantics
      : DEFAULT_AGENT_SEMANTICS,
    evalModePreamble: typeof adapter.eval_mode_preamble === 'string' && adapter.eval_mode_preamble.trim()
      ? adapter.eval_mode_preamble
      : DEFAULT_EVAL_MODE_PREAMBLE,
  };
}

function installMicroagent(workspace, adapter) {
  if (!adapter.agentEntrypointFile) return null;
  const sourcePath = path.resolve(REPO_ROOT, adapter.agentEntrypointFile);
  const destPath = path.join(workspace, adapter.microagentRelPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
  return destPath;
}

function buildOpenhandsRunMetadata({
  providerId,
  tier,
  model,
  openhandsServerUrl,
  openhandsVersion,
  adapter,
}) {
  return {
    provider_id: providerId,
    transport: 'openhands-rest+ws',
    agent: adapter.agentId,
    agent_tier: tier,
    agent_runtime: 'openhands-agent-server',
    agent_identity_source: 'openhands.json adapter block + agent key',
    agent_entrypoint_identity: adapter.agentId,
    agent_entrypoint_file: adapter.agentEntrypointFile,
    agent_semantics: adapter.agentSemantics,
    plugin_runtime_loaded: false,
    workspace_kind: 'local',
    microagent_installed_path: adapter.agentEntrypointFile ? adapter.microagentRelPath : null,
    model,
    openhands_server_url: openhandsServerUrl,
    openhands_version: openhandsVersion,
    litellm_provider: deriveLitellmProvider(model),
  };
}

class OpenhandsAgentServerProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = options.id || 'openhands-agent-server';
    this.httpClient = options.httpClient || defaultHttpClient();
    this.wsClient = options.wsClient || defaultWsClient();
    this.idleTimeoutMs =
      positiveInteger(options.idleTimeoutMs) ||
      positiveInteger(process.env.OPENHANDS_STREAM_IDLE_TIMEOUT_MS) ||
      DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  id() {
    return this.providerId;
  }

  _readOpenhandsConfig() {
    // Prefer explicit openhands_config; fall back to opencode_config so the
    // standard harness tier-config TOML can keep the OpenCode field name.
    const rel = this.config.openhands_config || this.config.opencode_config || 'openhands.json';
    const cfgPath = path.resolve(EVAL_ROOT, rel);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // CLI-injected daemon URL takes precedence over openhands.json. Empty
    // string treated as unset to match the OPENHANDS_MODEL_OVERRIDE semantic.
    const envUrl = process.env.OPENHANDS_SERVER_URL;
    if (typeof envUrl === 'string' && envUrl.trim() !== '') {
      cfg.openhands_server_url = envUrl;
    }
    return cfg;
  }

  _resolveTierConfig(cfg) {
    // Model precedence (highest → lowest):
    //   1. OPENHANDS_MODEL_OVERRIDE env (per-run manual debug)
    //   2. this.config.model (resolver branch — v1 tier providers[].model)
    //   3. cfg.agent[agent].model (openhands.json tier default)
    const tierCfg = { ...(cfg.agent?.[this.config.agent] || {}) };
    const cfgModel = this.config.model;
    if (typeof cfgModel === 'string' && cfgModel.trim() !== '') {
      tierCfg.model = cfgModel.trim();
    }
    const override = process.env.OPENHANDS_MODEL_OVERRIDE;
    if (typeof override === 'string' && override.trim()) {
      tierCfg.model = override.trim();
    }
    return tierCfg;
  }

  async callApi(prompt, _context, callOptions = {}) {
    if (typeof this.config.agent !== 'string' || this.config.agent.trim() === '') {
      return { error: 'OpenHands provider requires the agent tier name in config.agent' };
    }
    try {
      const output = await this._callWithRetries(prompt, callOptions);
      return { output };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async _callWithRetries(prompt, callOptions) {
    const cfg = this._readOpenhandsConfig();
    const tierCfg = this._resolveTierConfig(cfg);
    const maxAttempts = 1 + Math.max(0, this.config.empty_output_retries || 0);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const output = await this._runOnce(prompt, cfg, tierCfg, callOptions);
      if (output && output.trim()) return output;
      lastError = `OpenHands returned empty output (attempt ${attempt}/${maxAttempts})`;
    }
    throw new Error(lastError || `OpenHands returned empty output after ${maxAttempts} attempt(s)`);
  }

  async _runOnce(prompt, cfg, tierCfg, _callOptions) {
    const adapter = resolveAdapter(cfg);
    const workspace = extractWorkspace(prompt) || allocateFallbackWorkspace();
    const evalPrompt = `${adapter.evalModePreamble}\n\n${prompt}`;

    installMicroagent(workspace, adapter);

    writeProviderRunMetadata(workspace, buildOpenhandsRunMetadata({
      providerId: this.providerId,
      tier: this.config.agent,
      model: tierCfg.model,
      openhandsServerUrl: cfg.openhands_server_url,
      openhandsVersion: cfg.openhands_version,
      adapter,
    }));

    // LOCKSTEP NOTE: schema verified against live OpenHands 1.23.1 /openapi.json
    // (pair-bumped from 1.21.1 on 2026-05-26 — the HTTP shape we rely on is
    // byte-identical between the two).
    // StartConversationRequest: workspace (LocalWorkspace, Pydantic class name —
    // lowercased slugs like 'local' are rejected), agent { kind: 'Agent', llm },
    // initial_message, max_iterations at top level. Response field is `id`
    // (UUID), not `conversation_id`. WS path is `/sockets/events/{id}`.
    const llmPayload = buildLlmPayload(tierCfg.model);
    const createResp = await this.httpClient.post(
      `${cfg.openhands_server_url}/api/conversations`,
      {
        workspace: { kind: 'LocalWorkspace', working_dir: workspace },
        agent: { kind: 'Agent', llm: llmPayload },
        initial_message: {
          role: 'user',
          content: [{ type: 'text', text: evalPrompt }],
          run: true,
        },
        max_iterations: tierCfg.steps,
      },
    );
    if (createResp.status < 200 || createResp.status >= 300) {
      throw new Error(`OpenHands POST /api/conversations failed: status ${createResp.status} body ${JSON.stringify(createResp.json || createResp.text)}`);
    }
    const conversationId = createResp.json?.id;
    if (!conversationId) {
      throw new Error(`OpenHands POST /api/conversations returned no id field; body=${JSON.stringify(createResp.json)}`);
    }

    const wsUrl = `${cfg.openhands_server_url.replace(/^http/, 'ws')}/sockets/events/${conversationId}`;
    const wsHandle = this.wsClient.connect(wsUrl);
    // Back-compat: a wsClient stub that still returns a bare async iterable
    // (older tests / external embedders) is wrapped into the new shape so we
    // can call close() unconditionally below.
    const events = (wsHandle && typeof wsHandle[Symbol.asyncIterator] === 'function')
      ? wsHandle
      : wsHandle.events;
    const closeWs = (wsHandle && typeof wsHandle.close === 'function')
      ? () => wsHandle.close()
      : () => {};
    const textParts = [];
    const trajectory = [];
    let terminalError = null;

    const runDir = path.join(workspace, '.eval-run');
    try {
      // LOCKSTEP NOTE: real OpenHands 1.23.1 (pair-bumped from 1.21.1 on
      // 2026-05-26 — event kinds preserved across the bump) event kinds:
      // SystemPromptEvent, MessageEvent, ActionEvent, ObservationEvent,
      // ConversationStateUpdateEvent, ConversationErrorEvent. Final answers
      // ride on MessageEvent.llm_message.content (free-form assistant text)
      // OR ActionEvent with action.kind === 'FinishAction'. Terminal:
      // ConversationErrorEvent OR ConversationStateUpdateEvent with
      // key=execution_status and value in {error, finished, paused}.
      for await (const event of events) {
        trajectory.push(event);
        if (event.kind === 'MessageEvent' && event.source === 'agent') {
          const content = event.llm_message?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && typeof part.text === 'string') textParts.push(part.text);
            }
          }
        }
        if (event.kind === 'ActionEvent' && event.action?.kind === 'FinishAction') {
          const msg = event.action?.message;
          if (typeof msg === 'string' && msg.length > 0) textParts.push(msg);
        }
        if (event.kind === 'ConversationErrorEvent') {
          const code = event.code || 'OpenHandsError';
          const detail = event.detail || '';
          terminalError = `OpenHands ${code}: ${detail}`.trim();
          break;
        }
        if (event.kind === 'ConversationStateUpdateEvent' && event.key === 'execution_status') {
          if (event.value === 'finished' || event.value === 'paused') break;
          if (event.value === 'error') {
            if (!terminalError) terminalError = 'OpenHands execution_status=error (no ConversationErrorEvent)';
            break;
          }
        }
      }
    } finally {
      // Close the WS unconditionally — without this the live socket can keep
      // the Promptfoo Node process alive past the eval's result and stall
      // until the outer timeout fires.
      closeWs();
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'trajectory.json'),
        `${JSON.stringify(trajectory, null, 2)}\n`,
        'utf8',
      );
    }

    if (terminalError) throw new Error(terminalError);
    return textParts.join('');
  }
}

module.exports = OpenhandsAgentServerProvider;
module.exports.__private = {
  DEFAULT_MICROAGENT_REL_PATH,
  DEFAULT_AGENT_SEMANTICS,
  DEFAULT_EVAL_MODE_PREAMBLE,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  OPENCODE_GO_BASE_URL,
  buildOpenhandsRunMetadata,
  buildLlmPayload,
  deriveLitellmProvider,
  extractWorkspace,
  installMicroagent,
  positiveInteger,
  resolveAdapter,
  writeProviderRunMetadata,
};
