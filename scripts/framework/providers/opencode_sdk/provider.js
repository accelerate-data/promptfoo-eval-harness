'use strict';

/**
 * Phase 11 — opencode_sdk in-process Node provider (VD-2174-10).
 *
 * Drives `@opencode-ai/sdk` against an OpenCode server owned by this harness.
 * The bridge's generic `_dispatchInproc` (Phase 9.5) loads this module once
 * per run, calls `create()` to get a provider instance, and drives the
 * `init → turn[*] → finalize → shutdown` lifecycle.
 *
 * Server lifecycle (Architect #4):
 *   - `init(cfg)` boots `createOpencodeServer({ hostname: '127.0.0.1', port: 0 })`
 *     and connects an `OpencodeClient` to the returned URL. Readiness is
 *     verified by `client.session.list({ limit: 1 })` polling.
 *   - One server per provider instance (Phase 9.5 caches the instance in
 *     `_inprocProviderCache`). Per-case isolation comes from a fresh
 *     `client.session.create()` on first `turn`.
 *   - `shutdown` closes the session then stops the server (5 s timeout).
 *
 * SDK loading: `await import('@opencode-ai/sdk')` — works under the real
 * ESM-only package OR under the test-time loader-hook mock (Module.register
 * intercepts the specifier and returns `tests/_mock_opencode_sdk/sdk.mjs`).
 * No `createOpencodeServer` fallback to `npx opencode serve` is needed on
 * SDK v1.15.10 — the helper exists in `@opencode-ai/sdk/server`.
 */

const STARTUP_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const SUPPORTED_AGENTS = new Set(['build', 'plan', 'general']);

function _err(code, message, retryable) {
  const e = new Error(message);
  e.code = code;
  e.retryable = !!retryable;
  return e;
}

function _resolveAgent(cfg) {
  const agent = (cfg && cfg.extra && cfg.extra.opencode_agent) || (cfg && cfg.agent) || 'build';
  if (!SUPPORTED_AGENTS.has(agent)) {
    throw _err('UNSUPPORTED_AGENT', `opencode_sdk agent ${JSON.stringify(agent)} not in {${[...SUPPORTED_AGENTS].join(',')}}`, false);
  }
  return agent;
}

async function _waitReady(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await client.session.list({ query: { limit: 1 } });
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw _err('STARTUP_TIMEOUT', `opencode server not ready within ${timeoutMs}ms: ${(lastErr && lastErr.message) || 'no response'}`, false);
}

async function _stopServer(server, timeoutMs) {
  if (!server || typeof server.close !== 'function') return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => server.close()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown_timeout')), timeoutMs); }),
    ]).catch(() => { /* force-close best-effort */ });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function _extract(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const text = list
    .filter((p) => p && p.type === 'text')
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('\n');
  const toolCalls = list
    .filter((p) => p && p.type === 'tool')
    .map((p) => ({
      name: p.tool || '',
      arguments: p.input || {},
      result_truncated: typeof p.output === 'string' ? p.output.slice(0, 1024) : '',
      error: p.state === 'error' ? `Tool failed: ${p.callID || ''}` : null,
    }));
  return { text, toolCalls };
}

function _mapError(e) {
  if (e && typeof e === 'object' && e.code && Object.prototype.hasOwnProperty.call(e, 'retryable')) {
    return { code: e.code, message: e.message, retryable: !!e.retryable };
  }
  const msg = (e && e.message) || String(e);
  const status = (e && (e.status || (e.response && e.response.status))) || 0;
  if (status === 400) return { code: 'validation', message: msg, retryable: false };
  if (status === 401 || status === 403 || /auth/i.test(msg)) return { code: 'AUTH', message: msg, retryable: false };
  if (status === 429) return { code: 'rate_limit', message: msg, retryable: true };
  if (status >= 500) return { code: 'sdk_error', message: msg, retryable: true };
  return { code: 'sdk_error', message: msg, retryable: false };
}

function create() {
  let _sdk = null;

  async function _loadSdk() {
    if (_sdk) return _sdk;
    _sdk = await import('@opencode-ai/sdk');
    return _sdk;
  }

  return {
    async init(cfg) {
      const sdk = await _loadSdk();
      const agent = _resolveAgent(cfg);

      let server;
      try {
        server = await sdk.createOpencodeServer({ hostname: '127.0.0.1', port: 0 });
      } catch (e) {
        throw _err('STARTUP_TIMEOUT', `createOpencodeServer failed: ${(e && e.message) || e}`, false);
      }

      let client;
      try {
        client = sdk.createOpencodeClient({ baseUrl: server.url });
      } catch (e) {
        await _stopServer(server, 1000);
        throw _err('AUTH', `createOpencodeClient failed: ${(e && e.message) || e}`, false);
      }

      try {
        await _waitReady(client, STARTUP_TIMEOUT_MS);
      } catch (e) {
        await _stopServer(server, 1000);
        throw e;
      }

      return {
        server,
        client,
        baseUrl: server.url,
        agent,
        model: cfg.model || null,
        sessionId: null,
        workspaceDir: cfg.workspace_root || (cfg.workspace && cfg.workspace.dir) || null,
        finalState: null,
      };
    },

    async turn(session, input) {
      try {
        if (!session.sessionId) {
          const createResp = await session.client.session.create({
            body: { title: 'harness-session' },
            query: session.workspaceDir ? { directory: session.workspaceDir } : {},
          });
          const id = createResp && (createResp.info?.id || createResp.id);
          if (!id) throw _err('sdk_error', 'opencode session.create returned no id', false);
          session.sessionId = id;
        }

        const resp = await session.client.session.prompt({
          path: { id: session.sessionId },
          body: {
            agent: session.agent,
            model: session.model || undefined,
            parts: [{ type: 'text', text: input }],
          },
        });

        const parts = (resp && (resp.parts || (resp.info && resp.info.parts))) || [];
        const { text, toolCalls } = _extract(parts);
        return { output: text, tool_calls: toolCalls };
      } catch (e) {
        return { output: '', tool_calls: [], error: _mapError(e) };
      }
    },

    async finalize(session) {
      if (!session.sessionId) {
        return { metadata: { cost_usd: null, tokens: {}, transcript_summary: '' } };
      }
      try {
        const final = await session.client.session.get({ path: { id: session.sessionId } });
        session.finalState = final;
        const info = (final && final.info) || final || {};
        const cost = typeof info.cost === 'number' ? info.cost : null;
        const tokens = (info.tokens && typeof info.tokens === 'object') ? info.tokens : {};
        return {
          metadata: {
            cost_usd: cost,
            tokens,
            transcript_summary: info.title || '',
          },
        };
      } catch (e) {
        return { metadata: { cost_usd: null, tokens: {}, transcript_summary: '', finalize_error: (e && e.message) || String(e) } };
      }
    },

    async shutdown(session) {
      try {
        if (session && session.sessionId && session.client && session.client.session && typeof session.client.session.delete === 'function') {
          try {
            await session.client.session.delete({ path: { id: session.sessionId } });
          } catch (_) { /* best-effort */ }
        }
      } finally {
        if (session) {
          await _stopServer(session.server, SHUTDOWN_TIMEOUT_MS);
          session.sessionId = null;
          session.server = null;
          session.client = null;
        }
      }
    },
  };
}

module.exports = { create };
