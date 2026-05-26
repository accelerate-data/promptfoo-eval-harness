'use strict';

// OpenCode CLI plugin-aware SIBLING provider (Shape B / wrapper factory).
//
// IMPORTANT: this is a SIBLING of `opencode-cli-provider.js`, not a replacement.
// The base file is STRICTLY BYTE-IDENTICAL — this sibling adds plugin-native
// behavior (bootstrap_prompt, plugin-link detection, capture-on-failure runner,
// parser hook, run-metadata + trajectory dump, local-env loader) and is
// selected by consumers via `framework://opencode-cli-plugin-provider.js`.
//
// Shape A (subclass) is INFEASIBLE: the base's `callApi` delegates to a
// module-local helper (`callWithEmptyOutputRetries` at opencode-cli-provider.js
// :123-141 / :162) that cannot be overridden by `extends`. The sibling
// therefore owns its own `callApi` and re-implements the ~8-line empty-output
// retry loop inline. The base instance is retained ONLY for `id()` parity and
// for consuming the sole base export `runOpenCode`. Every other helper
// (`runOpenCodeCaptureAll`, `loadLocalEnv`, `splitCommand`,
// `buildOpenCodeInvocation`, `parseEnvLine`, `loadEnvFile`) is duplicated/
// ported into this file.
//
// Opt-in tier-config keys (all in phase-01 allowlist):
//   bootstrap_prompt          — string prepended to every prompt
//   opencode_plugin_link_path — relative-to-workspace path; if it exists,
//                               metadata stamps plugin_runtime_loaded=true
//   opencode_runner_command   — override binary path
//                               (env OPENCODE_RUNNER_COMMAND wins over this)
//   capture_on_failure        — switch runner to capture-stdout-on-non-zero
//   write_run_metadata        — emit <workspace>/.eval-run/provider.json
//   load_local_env            — read EVAL_ROOT/.env and REPO_ROOT/.env
//                               (never overwrites existing process.env keys)
//   opencode_parser_module    — require-path resolved under EVAL_ROOT, must
//                               export a function or { parseOpenCodeJsonStream }
//
// Transport name (run metadata `transport` field): `opencode_cli_plugin`.
// Concurrency: acquires `opencode_cli_plugin` kind (separate slot pool from
// the base `opencode_cli` transport).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OpenCodeCliProvider = require('./opencode-cli-provider');
const { runOpenCode } = OpenCodeCliProvider;
const { EVAL_ROOT } = require('./roots');
const { writeProviderRunMetadata, writeTrajectory } = require('./provider-run-metadata');
const { acquire } = require('./concurrency');

const TRANSPORT_NAME = 'opencode_cli_plugin';
const PROVIDER_ID = 'framework://opencode-cli-plugin-provider.js';
const DEFAULT_OPENCODE_COMMAND = 'opencode';
const DEFAULT_STATE_HOME = path.join(EVAL_ROOT, '.tmp', 'opencode-state');
const FALLBACK_WORKSPACE_PREFIX = path.join(
  EVAL_ROOT, '.workspaces', 'provider-runs', 'opencode-',
);
const WORKSPACE_REGEX = /(?:Workspace:|operating in workspace)\s*(\S+)/i;
const DEFAULT_IDENTITY_PARSER = (rawOutput) => ({ text: String(rawOutput || '').trim() });

function extractWorkspace(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(WORKSPACE_REGEX);
  return m ? m[1].replace(/\.$/, '') : null;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [match[1], value];
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function loadLocalEnv() {
  loadEnvFile(path.resolve(EVAL_ROOT, '..', '..', '.env'));
  loadEnvFile(path.resolve(EVAL_ROOT, '.env'));
}

function splitCommand(command) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error(`Unclosed quote in OPENCODE_RUNNER_COMMAND: ${command}`);
  if (current) tokens.push(current);
  return tokens;
}

function buildOpenCodeInvocation(args, env, override) {
  const command = (override || env.OPENCODE_RUNNER_COMMAND || DEFAULT_OPENCODE_COMMAND).trim();
  const parts = splitCommand(command);
  if (parts.length === 0) throw new Error('OPENCODE_RUNNER_COMMAND cannot be empty');
  return {
    command: parts[0],
    args: [...parts.slice(1), ...args],
    runnerCommand: command,
  };
}

function runOpenCodeCaptureAll(args, options) {
  return new Promise((resolve, reject) => {
    const invocation = buildOpenCodeInvocation(
      args, options.env || process.env, options.opencodeRunnerCommand,
    );
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('OpenCode CLI call aborted'));
    };
    if (options.signal) {
      if (options.signal.aborted) { abort(); return; }
      options.signal.addEventListener('abort', abort, { once: true });
    }
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (options.signal) options.signal.removeEventListener('abort', abort);
      const output = Buffer.concat(stdout).toString('utf8');
      const stderrOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (output.trim()) { resolve(output); return; }
      if (stderrOutput) { reject(new Error(stderrOutput)); return; }
      if (code === 0) { resolve(output); return; }
      reject(new Error(`opencode exited with code ${code} (no output)`));
    });
  });
}

function _allocateFallbackWorkspace(fallbackPrefix) {
  fs.mkdirSync(path.dirname(fallbackPrefix), { recursive: true });
  return fs.mkdtempSync(fallbackPrefix);
}

function _resolveWorkspace(prompt, _ctx, cfg, fallbackPrefix) {
  const extracted = extractWorkspace(prompt);
  if (extracted) return path.resolve(extracted);
  if (cfg.project_dir) return path.resolve(EVAL_ROOT, cfg.project_dir);
  return _allocateFallbackWorkspace(fallbackPrefix);
}

function _resolvePluginLink(workspace, pluginLinkPath) {
  if (!pluginLinkPath) return { linked: false, path: null };
  const abs = path.join(workspace, pluginLinkPath);
  if (!fs.existsSync(abs)) return { linked: false, path: null };
  try {
    return { linked: true, path: path.relative(workspace, fs.realpathSync(abs)) };
  } catch (_) {
    return { linked: false, path: null };
  }
}

function _resolveParser(parserModulePath) {
  if (!parserModulePath) return DEFAULT_IDENTITY_PARSER;
  const abs = path.resolve(EVAL_ROOT, parserModulePath);
  if (!abs.startsWith(EVAL_ROOT)) {
    throw new Error(
      `opencode_parser_module ${parserModulePath} must resolve under EVAL_ROOT`,
    );
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const mod = require(abs);
  const fn = typeof mod === 'function' ? mod : (mod && mod.parseOpenCodeJsonStream);
  if (typeof fn !== 'function') {
    throw new Error(
      `opencode_parser_module ${parserModulePath} must export a function or { parseOpenCodeJsonStream }`,
    );
  }
  return fn;
}

function makeOpenCodeCliPluginProvider(options = {}) {
  const cfg = (options && options.config) || {};
  const base = new OpenCodeCliProvider(options);

  const settings = {
    bootstrapPrompt: typeof cfg.bootstrap_prompt === 'string' ? cfg.bootstrap_prompt : '',
    pluginLinkPath: typeof cfg.opencode_plugin_link_path === 'string'
      ? cfg.opencode_plugin_link_path : null,
    opencodeRunnerCommand: typeof cfg.opencode_runner_command === 'string'
      ? cfg.opencode_runner_command : null,
    captureOnFailure: !!cfg.capture_on_failure,
    writeRunMetadata: !!cfg.write_run_metadata,
    loadLocalEnv: !!cfg.load_local_env,
    fallbackWorkspacePrefix: options.fallbackWorkspaceRoot
      ? path.join(options.fallbackWorkspaceRoot, 'opencode-')
      : FALLBACK_WORKSPACE_PREFIX,
    runner: options.runner
      || (cfg.capture_on_failure ? runOpenCodeCaptureAll : runOpenCode),
    parser: _resolveParser(cfg.opencode_parser_module),
  };

  if (settings.loadLocalEnv) loadLocalEnv();

  const label = `${TRANSPORT_NAME}/${cfg.agent_id || cfg.agent || 'default'}`;

  return {
    id: () => base.id(),
    label,
    async callApi(prompt, ctx, opts = {}) {
      const slot = await acquire(TRANSPORT_NAME);
      try {
        const workspace = _resolveWorkspace(prompt, ctx, cfg, settings.fallbackWorkspacePrefix);
        const finalPrompt = settings.bootstrapPrompt
          ? `${settings.bootstrapPrompt}\n\n${prompt}`
          : prompt;
        const plugin = _resolvePluginLink(workspace, settings.pluginLinkPath);
        const opencodeConfigAbs = cfg.opencode_config
          ? path.resolve(EVAL_ROOT, cfg.opencode_config)
          : null;

        if (settings.writeRunMetadata) {
          writeProviderRunMetadata(workspace, {
            transport: TRANSPORT_NAME,
            plugin_runtime_loaded: plugin.linked,
            plugin_path: plugin.path,
            opencode_config: opencodeConfigAbs
              ? path.relative(EVAL_ROOT, opencodeConfigAbs)
              : null,
            opencode_runner_command: settings.opencodeRunnerCommand
              || process.env.OPENCODE_RUNNER_COMMAND
              || DEFAULT_OPENCODE_COMMAND,
            agent: cfg.agent_id || null,
            agent_runtime: 'opencode-cli plugin agent',
            agent_entrypoint_identity: cfg.agent_id || null,
            agent_entrypoint_file: cfg.agent_entrypoint_file || null,
          });
        }

        const args = ['run', '--agent', cfg.agent, '--dir', workspace];
        if (cfg.format) args.push('--format', cfg.format);
        if (cfg.log_level) args.push('--log-level', cfg.log_level);
        if (cfg.print_logs) args.push('--print-logs');

        const env = {
          ...process.env,
          ...(opencodeConfigAbs ? { OPENCODE_CONFIG: opencodeConfigAbs } : {}),
          XDG_STATE_HOME: process.env.XDG_STATE_HOME || DEFAULT_STATE_HOME,
        };

        const maxAttempts = 1 + (
          Number.isInteger(cfg.empty_output_retries) && cfg.empty_output_retries > 0
            ? cfg.empty_output_retries : 0
        );

        let lastParsed = null;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          let rawOutput;
          try {
            rawOutput = await settings.runner([...args, finalPrompt], {
              cwd: EVAL_ROOT,
              env,
              signal: opts.signal || opts.abortSignal,
              opencodeRunnerCommand: settings.opencodeRunnerCommand,
            });
          } catch (runError) {
            return {
              error: runError instanceof Error ? runError.message : String(runError),
            };
          }
          lastParsed = await settings.parser(rawOutput);
          if (lastParsed && Array.isArray(lastParsed.trajectory)) {
            writeTrajectory(workspace, lastParsed.trajectory);
          }
          if (lastParsed && typeof lastParsed.text === 'string' && lastParsed.text.trim()) {
            return { output: lastParsed.text };
          }
        }
        const errorTail = lastParsed && Array.isArray(lastParsed.errors) && lastParsed.errors.length
          ? ` Last OpenCode error: ${lastParsed.errors.at(-1)}`
          : '';
        return {
          error: `OpenCode returned empty output after ${maxAttempts} attempt(s).${errorTail}`,
        };
      } finally {
        slot.release();
      }
    },
  };
}

module.exports = makeOpenCodeCliPluginProvider;
module.exports.__private = {
  TRANSPORT_NAME,
  PROVIDER_ID,
  DEFAULT_OPENCODE_COMMAND,
  FALLBACK_WORKSPACE_PREFIX,
  extractWorkspace,
  parseEnvLine,
  loadEnvFile,
  loadLocalEnv,
  splitCommand,
  buildOpenCodeInvocation,
  runOpenCodeCaptureAll,
  _resolveWorkspace,
  _resolvePluginLink,
  _resolveParser,
};
