'use strict';

/**
 * Phase 12 — codex_sdk in-process Node provider (VD-2174-11).
 *
 * Drives `@openai/codex-sdk` (ESM, Node ≥ 18 dynamic import) against a
 * per-case ephemeral workspace. The bridge's generic `_dispatchInproc`
 * (Phase 9.5) loads this module once per run, calls `create()` to get a
 * provider instance, and drives the `init → turn[*] → finalize → shutdown`
 * lifecycle.
 *
 * Per-case isolation strategy (Skeptic #9 + Architect #4):
 *   - `init(cfg)` reserves a per-session HOME directory (mkdtempSync) so
 *     concurrent codex_sdk cases never share auth/config files. The Codex
 *     SDK reads HOME from `opts.env.HOME` (we forward `process.env` with
 *     `HOME` overridden).
 *   - First `turn` lazily mkdtemps a per-case workspace inside the run's
 *     workspace root, runs `git init -q --initial-branch=main` and
 *     `git commit --allow-empty -q -m init` with inline
 *     `-c user.email/-c user.name` so codex's `skipGitRepoCheck=false`
 *     accepts the workdir without depending on global git config.
 *   - `shutdown` best-effort removes the per-case workspace AND the
 *     per-session HOME directory.
 *
 * SDK loading: `await import('@openai/codex-sdk')` lazily inside init() —
 * the real package is ESM-only (`"type": "module"` with `import`-only
 * exports), so CJS `require()` raises `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 * Tests inject a mock via an ESM Module.register loader hook installed by
 * `tests/_mock_codex_sdk/register.mjs` (NODE_OPTIONS=--import ...).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function _err(code, message, retryable) {
  const e = new Error(message);
  e.code = code;
  e.retryable = !!retryable;
  return e;
}

function _resolveWorkspaceRoot(cfg) {
  return (cfg && cfg.workspace_root) ||
    (cfg && cfg.workspace && cfg.workspace.dir) ||
    os.tmpdir();
}

function _ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function _gitInit(workDir) {
  const opts = { cwd: workDir, stdio: 'ignore' };
  const author = ['-c', 'user.email=ad-evals@local', '-c', 'user.name=AD Evals'];
  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main'], opts);
  } catch (_) {
    execFileSync('git', ['init', '-q'], opts);
  }
  try {
    execFileSync('git', [...author, 'commit', '--allow-empty', '-q', '-m', 'init'], opts);
  } catch (e) {
    throw _err('WORKSPACE_SETUP', `git init/commit failed in ${workDir}: ${(e && e.message) || e}`, false);
  }
}

function _extract(items) {
  const list = Array.isArray(items) ? items : [];
  const text = list
    .filter((i) => i && i.type === 'agent_message')
    .map((i) => (typeof i.text === 'string' ? i.text : ''))
    .join('\n');
  const toolCalls = [];
  for (const item of list) {
    if (!item || !item.type) continue;
    if (item.type === 'command_execution') {
      toolCalls.push({
        name: 'terminal',
        arguments: { command: item.command },
        result_truncated: typeof item.aggregated_output === 'string' ? item.aggregated_output.slice(0, 1024) : '',
        error: item.status === 'failed' ? `exit ${item.exit_code != null ? item.exit_code : ''}`.trim() : null,
      });
    } else if (item.type === 'file_change') {
      toolCalls.push({
        name: 'file_editor',
        arguments: { changes: item.changes || [] },
        result_truncated: item.status === 'completed' ? 'OK' : 'FAILED',
        error: item.status === 'failed' ? 'Patch failed' : null,
      });
    } else if (item.type === 'mcp_tool_call') {
      toolCalls.push({
        name: item.tool || '',
        arguments: item.arguments || {},
        result_truncated: item.result ? JSON.stringify(item.result).slice(0, 1024) : '',
        error: (item.error && item.error.message) || null,
      });
    } else if (item.type === 'web_search') {
      toolCalls.push({
        name: 'web_search',
        arguments: { query: item.query || '' },
        result_truncated: 'OK',
        error: null,
      });
    }
  }
  return { text, toolCalls };
}

function _mapError(e) {
  if (e && typeof e === 'object' && e.code && Object.prototype.hasOwnProperty.call(e, 'retryable')) {
    return { code: e.code, message: e.message, retryable: !!e.retryable };
  }
  const msg = (e && e.message) || String(e);
  const status = (e && (e.status || (e.response && e.response.status))) || 0;
  if (e && e.code === 'UNSUPPORTED_MODEL') return { code: 'UNSUPPORTED_MODEL', message: msg, retryable: false };
  if (status === 400) return { code: 'validation', message: msg, retryable: false };
  if (status === 401 || status === 403 || /auth/i.test(msg)) return { code: 'AUTH', message: msg, retryable: false };
  if (status === 429) return { code: 'rate_limit', message: msg, retryable: true };
  if (status >= 500) return { code: 'sdk_error', message: msg, retryable: true };
  return { code: 'sdk_error', message: msg, retryable: false };
}

async function _bestEffortRm(dir) {
  if (!dir) return;
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

function create() {
  let _sdk = null;

  async function _loadSdk() {
    if (_sdk) return _sdk;
    _sdk = await import('@openai/codex-sdk');
    return _sdk;
  }

  return {
    async init(cfg) {
      const sdk = await _loadSdk();
      const workspaceRoot = _resolveWorkspaceRoot(cfg);
      _ensureDir(workspaceRoot);

      let homeDir;
      try {
        const prefix = path.join(workspaceRoot, `.codex-home-${cfg.case_id || 'case'}-`);
        homeDir = fs.mkdtempSync(prefix);
      } catch (e) {
        throw _err('WORKSPACE_SETUP', `mkdtemp HOME failed: ${(e && e.message) || e}`, false);
      }

      return {
        sdk,
        workspaceRoot,
        homeDir,
        caseId: cfg.case_id || 'case',
        model: cfg.model || null,
        sandboxMode: (cfg.extra && cfg.extra.sandbox_mode) || 'workspace-write',
        reasoningEffort: (cfg.extra && cfg.extra.reasoning_effort) || 'medium',
        caseWorkDir: null,
        codex: null,
        thread: null,
        lastUsage: null,
      };
    },

    async turn(session, input) {
      try {
        if (!session.thread) {
          let workDir;
          try {
            const prefix = path.join(session.workspaceRoot, `.codex-case-${session.caseId}-`);
            workDir = fs.mkdtempSync(prefix);
          } catch (e) {
            throw _err('WORKSPACE_SETUP', `mkdtemp workspace failed: ${(e && e.message) || e}`, false);
          }
          _gitInit(workDir);
          session.caseWorkDir = workDir;

          const codex = new session.sdk.Codex({
            apiKey: process.env.OPENAI_API_KEY,
            baseUrl: process.env.OPENAI_BASE_URL || undefined,
            env: { ...process.env, HOME: session.homeDir },
          });
          session.codex = codex;
          session.thread = codex.startThread({
            workingDirectory: workDir,
            skipGitRepoCheck: false,
            model: session.model || undefined,
            sandboxMode: session.sandboxMode,
            modelReasoningEffort: session.reasoningEffort,
          });
        }

        const turn = await session.thread.run(input);
        const items = (turn && turn.items) || [];
        if (turn && turn.usage) session.lastUsage = turn.usage;
        const { text, toolCalls } = _extract(items);
        return { output: text, tool_calls: toolCalls };
      } catch (e) {
        return { output: '', tool_calls: [], error: _mapError(e) };
      }
    },

    async finalize(session) {
      const usage = session && session.lastUsage;
      const input = (usage && usage.input_tokens) || 0;
      const output = (usage && usage.output_tokens) || 0;
      return {
        metadata: {
          cost_usd: null,
          tokens: usage ? { input, output, total: input + output } : {},
          transcript_summary: '',
        },
      };
    },

    async shutdown(session) {
      if (!session) return;
      await _bestEffortRm(session.caseWorkDir);
      await _bestEffortRm(session.homeDir);
      session.codex = null;
      session.thread = null;
      session.caseWorkDir = null;
      session.homeDir = null;
    },
  };
}

module.exports = { create };
