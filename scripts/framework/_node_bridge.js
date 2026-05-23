'use strict';

/**
 * Node bridge — the SINGLE Promptfoo provider face (spec §2.2).
 *
 * Exported as a constructor function that Promptfoo's file:// loader calls
 * with the per-provider config block:
 *
 *   module.exports = function makeBridge(options) { return { id, label, callApi }; }
 *
 * Promptfoo passes the per-provider config: block to the constructor as
 * options (spike A.0.B verified). Runtime signals (abortSignal) arrive only
 * in callApi's third arg — ignored here.
 *
 * Dispatch table (KIND_REGISTRY):
 *   opencode_cli  → in-process, existing OpenCodeCliProvider module
 *   openhands_sdk → subprocess via _python_adapter.py + NDJSON IPC (spec §2.3)
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadSdkPins } = require('./sdk-pins');
const { getGlobalLimit, makeConcurrencyGate } = require('./concurrency');
const { redact } = require('./secret_redactor');

// ---------------------------------------------------------------------------
// Workspace helpers (spec §7.3)
// ---------------------------------------------------------------------------

/**
 * Resolve the per-case workspace directory path.
 * Base: tests/evals/.tmp/workspaces/<run_id>/<case_id>/
 */
function _workspacePath(runId, caseId) {
  return path.join('tests', 'evals', '.tmp', 'workspaces', runId || '_default', caseId || '_default');
}

/**
 * Create the per-case workspace directory (mkdirSync, recursive).
 * No-op when AD_EVALS_KEEP_WORKSPACE is set (dir may already exist from a prior run).
 */
function _ensureWorkspace(runId, caseId) {
  const dir = _workspacePath(runId, caseId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove the per-case workspace directory.
 * Skipped when AD_EVALS_KEEP_WORKSPACE=1 (debug escape hatch, spec §7.3).
 */
function _cleanWorkspace(runId, caseId) {
  if (process.env.AD_EVALS_KEEP_WORKSPACE === '1' || process.env.AD_EVALS_KEEP_WORKSPACE === 'true') {
    return;
  }
  const dir = _workspacePath(runId, caseId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Spawn injection point — tests can override _spawnImpl to stub child processes
// without patching native built-ins (Node 24 native module cache is read-only).
// ---------------------------------------------------------------------------
let _spawnImpl = null;
function _getSpawn() {
  return _spawnImpl || require('node:child_process').spawn;
}

// ---------------------------------------------------------------------------
// KIND_REGISTRY — maps provider_kind → dispatch strategy.
// Exactly two entries in v1.0.0. The test asserts this count so adding
// Claude Agent SDK in Phase 2 forces a deliberate edit.
// ---------------------------------------------------------------------------
const _ADAPTER_PATH = path.resolve(__dirname, 'providers', '_python_adapter.py');

const KIND_REGISTRY = {
  opencode_cli: {
    mode: 'inproc',
    module: path.resolve(__dirname, 'opencode-cli-provider.js'),
  },
  openhands_sdk: {
    mode: 'subprocess',
    // adapter: kept for backward-compat with existing tests that verify the path.
    adapter: _ADAPTER_PATH,
    // spawn: full uv argv — version sourced dynamically from sdk-pins.toml (loadSdkPins).
    // Computed as a getter so test overrides to sdk-pins path propagate correctly.
    get spawn() {
      const version = loadSdkPins().openhands_sdk.version;
      return [
        'uv', 'run', '--python', '3.12',
        '--with', `openhands-sdk==${version}`,
        'python', '-m', 'scripts.framework.providers._python_adapter',
        '--kind=openhands_sdk',
      ];
    },
  },
};

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

/**
 * Parse and validate provider config from the constructor options object.
 * Strips Promptfoo-injected keys (basePath) before returning.
 *
 * @param {object} raw
 * @returns {{ provider_kind: string, provider_label: string, model: string, [key: string]: any }}
 * @throws if provider_kind is missing
 */
function parseProviderConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    throw Object.assign(new Error('provider config must be an object'), { code: 'BAD_CONFIG' });
  }
  if (!raw.provider_kind || typeof raw.provider_kind !== 'string') {
    throw Object.assign(new Error('provider config missing required field: provider_kind'), { code: 'BAD_CONFIG' });
  }
  // Strip Promptfoo-injected keys that are not provider concerns (spec §2.2 callout).
  // eslint-disable-next-line no-unused-vars
  const { basePath: _basePath, ...cfg } = raw;
  return cfg;
}

/**
 * Parse vars.turns into a string array per spec §3.2 precedence rules.
 *
 * Promptfoo's test-matrix engine expands YAML array vars into separate rows
 * (spike A.0.B verified) — context.vars.turns is NEVER a JS Array at callApi
 * time. Multi-turn sequences must be JSON-encoded strings.
 *
 * Precedence:
 *   1. vars.turns is a non-empty JSON-encoded string → decode + use
 *   2. vars.turns is a non-empty plain string → single-turn
 *   3. promptFallback is a non-empty string → single-turn
 *   4. null (caller must treat as missing input)
 *
 * Legacy: if rawTurns happens to be a JS Array (defensive compat), use it.
 *
 * @param {any} rawTurns
 * @param {string|undefined} promptFallback
 * @returns {string[]|null}
 */
function parseTurns(rawTurns, promptFallback) {
  // Legacy/defensive: already an array
  if (Array.isArray(rawTurns) && rawTurns.length > 0) return rawTurns;

  if (rawTurns && typeof rawTurns === 'string' && rawTurns.trim()) {
    try {
      const parsed = JSON.parse(rawTurns);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (_) {
      /* not JSON-encoded — treat as single-turn string */
    }
    return [rawTurns];
  }
  if (promptFallback && typeof promptFallback === 'string' && promptFallback.trim()) {
    return [promptFallback];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Metadata helpers (spec §1.5)
// ---------------------------------------------------------------------------

function baseMetadata(cfg, extra) {
  return {
    provider_kind: cfg.provider_kind,
    provider_label: cfg.provider_label || '',
    model: cfg.model || null,
    sdk_version: cfg.sdk_version || null,
    adapter_version: require('../../package.json').version,
    run_id: process.env.AD_EVALS_RUN_ID || null,
    case_id: cfg.case_id || null,
    ...extra,
  };
}

function normalizeErr(e) {
  if (e && typeof e === 'object' && e.code && e.message) {
    return { code: e.code, message: redact(e.message), retryable: !!e.retryable };
  }
  if (typeof e === 'string') {
    return { code: 'provider_error', message: redact(e), retryable: false };
  }
  return { code: 'bridge_error', message: redact(e?.message || String(e)), retryable: false };
}

function errorReturn(cfg, err, transcript, turnOutputs, latencyPerTurn, turnsCompleted, startedAt) {
  return {
    output: turnOutputs.join('\n---\n'),
    error: err.message,
    metadata: baseMetadata(cfg, {
      provider_error: err,
      turns_completed: turnsCompleted,
      final_turn_output: turnOutputs[turnOutputs.length - 1] || '',
      transcript,
      latency_ms_per_turn: latencyPerTurn,
      latency_ms_total: Date.now() - startedAt,
    }),
  };
}

function pushTurn(transcript, turn_index, input, output, latency_ms, tool_calls, error) {
  const entry = { turn_index, input, output: output || '', latency_ms, tool_calls: tool_calls || [] };
  if (error) entry.error = error;
  transcript.push(entry);
}

// ---------------------------------------------------------------------------
// subprocess spawn helper
// ---------------------------------------------------------------------------

/**
 * Build the uv spawn command for a subprocess-backed kind.
 * Reads pin version from sdk-pins.toml via loadSdkPins().
 *
 * @param {string} kind
 * @param {string} adapterPath
 * @returns {{ cmd: string, args: string[], env: NodeJS.ProcessEnv }}
 */
function _buildSpawnSpec(kind, adapterPath) {
  const pins = loadSdkPins();
  const kindPins = pins[kind];

  // Build a minimal env: only PATH, HOME, TMPDIR + kind's env_allowlist keys.
  // PYTHONPATH is always forwarded when set so test-time mock SDK monkey-patching works.
  const allowlist = (kindPins && Array.isArray(kindPins.env_allowlist) ? kindPins.env_allowlist : []);
  const minEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'PYTHONPATH', ...allowlist]) {
    if (process.env[key] !== undefined) {
      minEnv[key] = process.env[key];
    }
  }
  // Normalize PYTHONPATH to absolute paths so sitecustomize.py's _THIS_DIR check
  // succeeds regardless of whether the caller passed a relative path (e.g.
  // PYTHONPATH=tests/_mock_openhands_sdk from the repo root).
  if (minEnv.PYTHONPATH) {
    minEnv.PYTHONPATH = minEnv.PYTHONPATH
      .split(path.delimiter)
      .map((p) => path.resolve(p))
      .join(path.delimiter);
  }
  // Always suppress banners
  minEnv.OPENHANDS_SUPPRESS_BANNER = '1';

  // Use the registry spawn array when available (module-invocation form).
  // Fall back to legacy path-based invocation for future kinds without a spawn spec.
  const registry = KIND_REGISTRY[kind];
  let cmd, args;
  if (registry && registry.spawn) {
    const spawnArgv = registry.spawn; // getter — re-reads sdk-pins each call
    cmd = spawnArgv[0];
    args = spawnArgv.slice(1);
  } else if (kind === 'openhands_sdk') {
    const version = kindPins.version;
    cmd = 'uv';
    args = ['run', '--python', '3.12', '--with', `openhands-sdk==${version}`, 'python', adapterPath, `--kind=${kind}`];
  } else {
    // Generic subprocess kind (future)
    cmd = 'uv';
    args = ['run', '--python', '3.12', 'python', adapterPath, `--kind=${kind}`];
  }

  return { cmd, args, env: minEnv };
}

// ---------------------------------------------------------------------------
// NDJSON IPC helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to a subprocess over its stdin and read back one NDJSON line.
 * Respects an optional timeoutMs.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {object} msg
 * @param {{ timeoutMs?: number }} opts
 * @returns {Promise<object>}
 */
function _ipcSend(child, msg, opts = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs || 0;
    let timer = null;
    let settled = false;

    function settle(fn, val) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(val);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        settle(reject, Object.assign(new Error(`IPC timeout after ${timeoutMs}ms`), { code: 'SUBPROCESS_TIMEOUT', retryable: true }));
      }, timeoutMs);
    }

    // Listen for one line of stdout
    function onData(chunk) {
      const line = chunk.toString().split('\n')[0];
      if (!line.trim()) return;
      child.stdout.removeListener('data', onData);
      child.stdout.removeListener('end', onEnd);
      try {
        settle(resolve, JSON.parse(line));
      } catch (e) {
        settle(reject, Object.assign(new Error(`Malformed NDJSON from subprocess: ${line}`), { code: 'SUBPROCESS_CRASH', retryable: true }));
      }
    }

    function onEnd() {
      settle(reject, Object.assign(new Error('subprocess stdout closed unexpectedly'), { code: 'SUBPROCESS_CRASH', retryable: true }));
    }

    child.stdout.on('data', onData);
    child.stdout.on('end', onEnd);

    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      settle(reject, Object.assign(new Error(`Failed to write to subprocess stdin: ${e.message}`), { code: 'SUBPROCESS_CRASH', retryable: true }));
    }
  });
}

/**
 * Gracefully shut down a subprocess (SIGTERM → 5s grace → SIGKILL).
 */
async function _shutdownChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    await _ipcSend(child, { type: 'shutdown', id: 'bridge-shutdown', session_id: '' }, { timeoutMs: 5000 });
  } catch (_) {
    /* ignore — fall through to SIGKILL */
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      // Wait up to 5s for process to exit after SIGTERM, but poll every 100ms
      // to avoid waiting the full grace period when it exits quickly.
      const GRACE_MS = 5000;
      const POLL_MS = 100;
      let waited = 0;
      while (child.exitCode === null && waited < GRACE_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        waited += POLL_MS;
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

// ---------------------------------------------------------------------------
// Bridge class
// ---------------------------------------------------------------------------

class HarnessBridgeProvider {
  /**
   * @param {object} options - Per-provider config block from Promptfoo constructor call.
   */
  constructor(options = {}) {
    this.options = options;
  }

  id() {
    const label = this.options.config?.provider_label || this.options.provider_label || 'unknown';
    return `harness:${label}`;
  }

  get label() {
    return this.options.config?.provider_label || this.options.provider_label || 'unknown';
  }

  async callApi(prompt, context /*, _callOptions — only { abortSignal }, ignored */) {
    let cfg;
    try {
      cfg = parseProviderConfig(this.options.config || this.options);
    } catch (e) {
      const err = normalizeErr(e);
      return {
        output: '',
        error: err.message,
        metadata: baseMetadata({ provider_kind: 'unknown', provider_label: 'unknown' }, {
          provider_error: err,
          turns_completed: 0,
          final_turn_output: '',
          transcript: [],
          latency_ms_per_turn: [],
          latency_ms_total: 0,
        }),
      };
    }

    const kind = cfg.provider_kind;
    if (!KIND_REGISTRY[kind]) {
      const err = { code: 'UNSUPPORTED_KIND', message: `provider_kind ${JSON.stringify(kind)} is not in KIND_REGISTRY`, retryable: false };
      return {
        output: undefined,
        error: { code: err.code, message: err.message, retryable: err.retryable },
      };
    }

    // Acquire INNER global gate — caps ALL callApi invocations (opencode_cli +
    // SDK kinds) regardless of provider_kind (spec §4.2, B.10).
    const globalGate = getGlobalLimit();
    return globalGate(() => this._dispatch(prompt, context, cfg));
  }

  async _dispatch(prompt, context, cfg) {
    const startedAt = Date.now();
    const transcript = [];
    const turnOutputs = [];
    const latencyPerTurn = [];
    const kind = cfg.provider_kind;

    // -----------------------------------------------------------------------
    // opencode_cli — in-process dispatch
    // -----------------------------------------------------------------------
    if (kind === 'opencode_cli') {
      const turns = parseTurns(context?.vars?.turns, prompt);
      const noUsableTurn =
        !turns ||
        turns.length === 0 ||
        (turns.length === 1 && (turns[0] === undefined || turns[0] === null || turns[0] === ''));

      if (noUsableTurn) {
        const err = {
          code: 'validation',
          retryable: false,
          message: 'no turns to send: vars.turns is empty and prompt is missing/empty',
        };
        return {
          output: '',
          error: err.message,
          metadata: baseMetadata(cfg, {
            provider_error: err,
            turns_completed: 0,
            final_turn_output: '',
            transcript,
            latency_ms_per_turn: latencyPerTurn,
            latency_ms_total: Date.now() - startedAt,
          }),
        };
      }

      if (turns.length > 1) {
        const err = {
          code: 'validation',
          retryable: false,
          message: 'multi-turn not supported by opencode_cli in v1.0.0',
        };
        for (let i = 0; i < turns.length; i++) {
          pushTurn(transcript, i, turns[i], '', 0, [], err);
        }
        return {
          output: '',
          error: err.message,
          metadata: baseMetadata(cfg, {
            provider_error: err,
            turns_completed: 0,
            final_turn_output: '',
            transcript,
            latency_ms_per_turn: latencyPerTurn,
            latency_ms_total: Date.now() - startedAt,
          }),
        };
      }

      const turnStart = Date.now();
      let res;
      try {
        // Instantiate the existing provider — DO NOT refactor (phase 05 owns it).
        const OpenCodeCliProvider = require('./opencode-cli-provider.js');
        const provider = new OpenCodeCliProvider({ config: cfg });
        res = await provider.callApi(turns[0], context);
      } catch (e) {
        const err = normalizeErr(e);
        const turnLatency = Date.now() - turnStart;
        pushTurn(transcript, 0, turns[0], '', turnLatency, [], err);
        latencyPerTurn.push(turnLatency);
        return errorReturn(cfg, err, transcript, turnOutputs, latencyPerTurn, 0, startedAt);
      }

      const turnLatency = Date.now() - turnStart;
      latencyPerTurn.push(turnLatency);

      if (res.error) {
        const err = normalizeErr(res.error);
        pushTurn(transcript, 0, turns[0], res.output || '', turnLatency, res.metadata?.tool_calls, err);
        return {
          output: res.output || '',
          error: err.message,
          metadata: baseMetadata(cfg, {
            ...(res.metadata || {}),
            provider_error: err,
            turns_completed: 0,
            final_turn_output: res.output || '',
            transcript,
            latency_ms_per_turn: latencyPerTurn,
            latency_ms_total: Date.now() - startedAt,
          }),
        };
      }

      pushTurn(transcript, 0, turns[0], res.output || '', turnLatency, res.metadata?.tool_calls);
      turnOutputs.push(res.output || '');
      return {
        output: res.output,
        metadata: baseMetadata(cfg, {
          ...(res.metadata || {}),
          turns_completed: 1,
          final_turn_output: res.output || '',
          transcript,
          latency_ms_per_turn: latencyPerTurn,
          latency_ms_total: Date.now() - startedAt,
        }),
      };
    }

    // -----------------------------------------------------------------------
    // SDK kinds — subprocess + NDJSON IPC
    // -----------------------------------------------------------------------
    const turns = parseTurns(context?.vars?.turns, prompt);
    const sdkNoUsableTurn =
      !turns ||
      turns.length === 0 ||
      (turns.length === 1 && (turns[0] === undefined || turns[0] === null || turns[0] === ''));

    if (sdkNoUsableTurn) {
      const err = { code: 'validation', retryable: false, message: 'vars.turns is empty' };
      return {
        output: '',
        error: err.message,
        metadata: baseMetadata(cfg, {
          provider_error: err,
          turns_completed: 0,
          final_turn_output: '',
          transcript,
          latency_ms_per_turn: latencyPerTurn,
          latency_ms_total: Date.now() - startedAt,
        }),
      };
    }

    const registry = KIND_REGISTRY[kind];
    const { cmd, args, env } = _buildSpawnSpec(kind, registry.adapter);

    // INNER semaphore: cap=1 per subprocess (Phase 1 single-session, spec §4.1).
    const innerLimit = makeConcurrencyGate(`inner:${kind}`, 1);
    const subprocessTimeoutMs = parseInt(process.env.AD_EVALS_SUBPROCESS_TIMEOUT_MS, 10) || 120000;

    let child = null;
    let attemptedIndex = -1;
    let attemptedStart = 0;
    let attemptedInput = '';

    // Create per-case workspace and forward its path in cfg.options.workspace_dir (spec §7.3).
    const runId = process.env.AD_EVALS_RUN_ID || '';
    const caseId = cfg.case_id || context?.vars?.case_id || '';
    const workspaceDir = _ensureWorkspace(runId, caseId);
    const cfgWithWorkspace = { ...cfg, workspace_root: workspaceDir };

    try {
      child = _getSpawn()(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });

      // Collect stderr (capped at 64KB, spec §2.4)
      let stderrBuf = '';
      const STDERR_MAX = 64 * 1024;
      child.stderr.on('data', (chunk) => {
        if (stderrBuf.length < STDERR_MAX) {
          stderrBuf += chunk.toString();
          if (stderrBuf.length > STDERR_MAX) {
            stderrBuf = stderrBuf.slice(0, STDERR_MAX) + '\n[stderr truncated]';
          }
        }
      });

      // Init handshake — include workspace_dir in config so the adapter can pass it to the SDK.
      const initResp = await innerLimit(() =>
        _ipcSend(child, { type: 'init', id: 'bridge-init', config: cfgWithWorkspace }, { timeoutMs: subprocessTimeoutMs }),
      );
      if (initResp.type === 'error') {
        const err = normalizeErr(initResp.error);
        return errorReturn(cfg, err, transcript, turnOutputs, latencyPerTurn, 0, startedAt);
      }
      const sessionId = initResp.session_id;

      let lastResult = null;
      for (let i = 0; i < turns.length; i++) {
        attemptedIndex = i;
        attemptedInput = turns[i];
        attemptedStart = Date.now();

        const resp = await innerLimit(() =>
          _ipcSend(
            child,
            { type: 'turn', id: `bridge-turn-${i}`, session_id: sessionId, message: turns[i] },
            { timeoutMs: subprocessTimeoutMs },
          ),
        );

        const turnLatency = Date.now() - attemptedStart;
        latencyPerTurn.push(turnLatency);
        attemptedIndex = -1;

        if (resp.type === 'error' || resp.error) {
          const err = normalizeErr(resp.error || resp.result?.error);
          const partialOutput = resp.text || resp.result?.text || '';
          pushTurn(transcript, i, turns[i], partialOutput, turnLatency, resp.tool_calls || resp.result?.tool_calls, err);
          return {
            output: turnOutputs.concat(partialOutput).join('\n---\n'),
            error: err.message,
            metadata: baseMetadata(cfg, {
              provider_error: err,
              turns_completed: i,
              final_turn_output: partialOutput,
              transcript,
              latency_ms_per_turn: latencyPerTurn,
              latency_ms_total: Date.now() - startedAt,
            }),
          };
        }

        const text = resp.text || '';
        const toolCalls = resp.tool_calls || [];
        turnOutputs.push(text);
        pushTurn(transcript, i, turns[i], text, turnLatency, toolCalls);
        lastResult = resp;
      }

      // Finalize
      const finalResp = await innerLimit(() =>
        _ipcSend(child, { type: 'finalize', id: 'bridge-final', session_id: sessionId }, { timeoutMs: subprocessTimeoutMs }),
      );

      return {
        output: turnOutputs.join('\n---\n'),
        metadata: baseMetadata(cfg, {
          cost_usd: finalResp.cost_usd || null,
          tokens: finalResp.tokens || {},
          transcript_summary: finalResp.transcript_summary || '',
          turns_completed: turns.length,
          final_turn_output: lastResult?.text || '',
          transcript,
          latency_ms_per_turn: latencyPerTurn,
          latency_ms_total: Date.now() - startedAt,
        }),
      };
    } catch (e) {
      const err = normalizeErr(e);
      if (attemptedIndex >= 0) {
        const turnLatency = Date.now() - attemptedStart;
        latencyPerTurn.push(turnLatency);
        pushTurn(transcript, attemptedIndex, attemptedInput, '', turnLatency, [], err);
      }
      return errorReturn(cfg, err, transcript, turnOutputs, latencyPerTurn, turnOutputs.length, startedAt);
    } finally {
      if (child) {
        try {
          await _shutdownChild(child);
        } catch (_) {
          /* best-effort */
        }
      }
      // Clean up per-case workspace after shutdown (success and error paths).
      // Skipped when AD_EVALS_KEEP_WORKSPACE=1 (debug mode, spec §7.3).
      _cleanWorkspace(runId, caseId);
    }
  }
}

// ---------------------------------------------------------------------------
// Promptfoo file:// entry point — constructor function pattern
// ---------------------------------------------------------------------------

/**
 * Factory function called by Promptfoo when it loads this file via file://.
 * Returns a Promptfoo-compatible provider object.
 *
 * `label` is a plain string property (not a function) because Promptfoo 0.121.x
 * accesses `provider.label` as a string and calls `.toLowerCase()` on it.
 * The HarnessBridgeProvider class exposes `label` as a getter for the same reason.
 *
 * @param {object} options - Per-provider config from the tier config block.
 * @returns {{ id: () => string, label: string, callApi: Function }}
 */
function makeBridge(options) {
  const bridge = new HarnessBridgeProvider(options);
  return {
    id: () => bridge.id(),
    label: bridge.label,   // string property — satisfies Promptfoo telemetry (.toLowerCase())
    callApi: bridge.callApi.bind(bridge),
  };
}

// Expose internals for testing
makeBridge._HarnessBridgeProvider = HarnessBridgeProvider;
makeBridge._KIND_REGISTRY = KIND_REGISTRY;
makeBridge._parseProviderConfig = parseProviderConfig;
makeBridge._parseTurns = parseTurns;
makeBridge._normalizeErr = normalizeErr;
makeBridge._workspacePath = _workspacePath;
makeBridge._cleanWorkspace = _cleanWorkspace;
// Spawn injection for tests (avoids native module cache issues in Node 24)
makeBridge._setSpawnImpl = (fn) => { _spawnImpl = fn; };
makeBridge._clearSpawnImpl = () => { _spawnImpl = null; };

module.exports = makeBridge;
