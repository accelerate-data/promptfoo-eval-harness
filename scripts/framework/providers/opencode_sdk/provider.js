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
 *
 * Response shape (SDK v1.15.10): every `client.session.*` call returns
 * `{data, request, response}` on success or `{error, request, response}` on
 * failure. The id from session.create is at `data.id`; prompt parts are at
 * `data.parts`; finalize fields (cost/tokens/title) are at `data` directly.
 * `session.prompt` requires `body.model` to be an object
 * `{providerID, modelID}` — harness config carries it as a "p/m" string and
 * the provider splits on the first `/` before sending. (v1.3.2 hotfix.)
 *
 * Guaranteed cleanup (v1.3.3): every successful `init()` registers the
 * spawned `opencode serve` child in a module-scoped `_activeServers`
 * registry. `_stopServer()` removes the entry after `server.close()` runs.
 * A one-shot signal hook installed on first `init()` drains the registry
 * on `exit` / `SIGINT` / `SIGTERM` / `uncaughtException`, so the child is
 * never orphaned even if the harness process is killed mid-run or the
 * per-case `finally` block does not get a chance to call `shutdown()`.
 */

const STARTUP_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const SUPPORTED_AGENTS = new Set(['build', 'plan', 'general']);

// ---------------------------------------------------------------------------
// Process-level cleanup registry (v1.3.3)
//
// Every `init()` boots a fresh `opencode serve` child process via
// `@opencode-ai/sdk`. The per-case `finally` block in `_node_bridge.js`
// already calls `shutdown(session)` which closes that child — verified
// end-to-end. The registry below covers the remaining gap: if the harness
// process is killed mid-run (SIGINT / SIGTERM) or crashes via
// `uncaughtException` before the per-case `finally` block fires, the child
// would otherwise be orphaned and the dynamic port would stay bound until
// the OS reaps it.
//
// On every successful `init()`, the new server is added to `_activeServers`.
// On every `_stopServer()` call, the entry is removed. A one-shot signal +
// exit hook drains the registry by calling `server.close()` on each entry
// (synchronous; the SDK's `close()` only invokes `child_process.kill()`).
// ---------------------------------------------------------------------------
const _activeServers = new Set();
let _signalHooksInstalled = false;

function _portFromUrl(url) {
  const m = typeof url === 'string' ? url.match(/:(\d+)(?:\/|$)/) : null;
  return m ? Number(m[1]) : null;
}

function _drainActiveServers() {
  for (const entry of [..._activeServers]) {
    try {
      if (entry && entry.server && typeof entry.server.close === 'function') {
        entry.server.close();
      }
    } catch (_) { /* best-effort */ }
    _activeServers.delete(entry);
  }
}

function _installSignalHooks() {
  if (_signalHooksInstalled) return;
  _signalHooksInstalled = true;
  // `exit` is the last synchronous chance to clean up — server.close() is
  // synchronous in the SDK so this is safe.
  process.on('exit', _drainActiveServers);
  // Drain then re-raise the signal so default behaviour (exit code 128+N)
  // still applies. `once()` ensures our handler does not loop on the
  // re-raised signal.
  const reRaise = (signal) => {
    _drainActiveServers();
    try { process.kill(process.pid, signal); } catch (_) { process.exit(signal === 'SIGINT' ? 130 : 143); }
  };
  process.once('SIGINT', () => reRaise('SIGINT'));
  process.once('SIGTERM', () => reRaise('SIGTERM'));
  process.once('uncaughtException', (err) => {
    _drainActiveServers();
    // eslint-disable-next-line no-console
    console.error('[opencode_sdk] uncaughtException, drained active servers:', err && err.stack || err);
    process.exit(1);
  });
}

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

/**
 * Parse the harness `model` field into the {providerID, modelID} shape
 * required by `@opencode-ai/sdk@1.15.10` session.prompt. Accepts either an
 * already-parsed object or a "providerID/modelID" string. Returns undefined
 * when no model is configured so the SDK can apply its default.
 */
function _parseModel(m) {
  if (!m) return undefined;
  if (typeof m === 'object' && m.providerID && m.modelID) return m;
  if (typeof m !== 'string') {
    throw _err('validation', `opencode_sdk model must be a "<providerID>/<modelID>" string or {providerID,modelID} object; got ${typeof m}`, false);
  }
  const slash = m.indexOf('/');
  if (slash <= 0 || slash === m.length - 1) {
    throw _err('validation', `opencode_sdk model ${JSON.stringify(m)} missing "/" separator; expected "<providerID>/<modelID>"`, false);
  }
  return { providerID: m.slice(0, slash), modelID: m.slice(slash + 1) };
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
  if (!server || typeof server.close !== 'function') {
    // Still deregister whatever entry references this server, if any.
    for (const entry of [..._activeServers]) {
      if (entry && entry.server === server) _activeServers.delete(entry);
    }
    return;
  }
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => server.close()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('shutdown_timeout')), timeoutMs); }),
    ]).catch(() => { /* force-close best-effort */ });
  } finally {
    if (timer) clearTimeout(timer);
    // Deregister regardless of close() outcome — if the SDK swallowed the
    // close, the process-level drain handler is no longer responsible for
    // this entry (calling close() twice on the same proc is a no-op anyway).
    for (const entry of [..._activeServers]) {
      if (entry && entry.server === server) _activeServers.delete(entry);
    }
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

      // Register for process-level cleanup. Re-arms the signal/exit hooks
      // on every init() — first call installs them, subsequent calls are
      // no-ops via `_signalHooksInstalled` guard.
      _installSignalHooks();
      const port = _portFromUrl(server.url);
      const serverEntry = { server, port, url: server.url };
      _activeServers.add(serverEntry);

      return {
        server,
        client,
        baseUrl: server.url,
        agent,
        model: cfg.model || null,
        sessionId: null,
        workspaceDir: cfg.workspace_root || (cfg.workspace && cfg.workspace.dir) || null,
        finalState: null,
        _serverEntry: serverEntry,
      };
    },

    async turn(session, input) {
      try {
        if (!session.sessionId) {
          const createResp = await session.client.session.create({
            body: { title: 'harness-session' },
            query: session.workspaceDir ? { directory: session.workspaceDir } : {},
          });
          const id = createResp && (createResp.data?.id || createResp.info?.id || createResp.id);
          if (!id) throw _err('sdk_error', 'opencode session.create returned no id', false);
          session.sessionId = id;
        }

        const modelPayload = _parseModel(session.model);
        const resp = await session.client.session.prompt({
          path: { id: session.sessionId },
          body: {
            agent: session.agent,
            ...(modelPayload ? { model: modelPayload } : {}),
            parts: [{ type: 'text', text: input }],
          },
        });

        if (resp && resp.error) {
          const sdkErr = resp.error;
          throw _err(
            'sdk_error',
            `opencode session.prompt failed: ${(sdkErr.data && sdkErr.data.message) || sdkErr.name || 'unknown'}`,
            false,
          );
        }

        const parts = (resp && (resp.data?.parts || resp.parts || (resp.info && resp.info.parts))) || [];
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
        // SDK v1.15.10 returns {data: {cost, tokens, title, ...}, request, response}.
        // Mock <=v1.3.1 still returns {info: {...}} — keep both readable.
        const info = (final && (final.data || final.info)) || final || {};
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

module.exports = {
  create,
  // Exposed for tests + external observability — NOT a stable public surface.
  _activeServers,
  _drainActiveServers,
  _activeServerCount: () => _activeServers.size,
};
