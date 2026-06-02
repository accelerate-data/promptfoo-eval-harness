'use strict';

/**
 * OpenCode CLI provider (spec §1.2, §7.4).
 *
 * Implements the four-method lifecycle contract (init/turn/finalize/shutdown)
 * while preserving the existing callApi() façade for backward compatibility
 * with _node_bridge.js inproc dispatch.
 *
 * §7.4 five preserved behaviors — keyed to line numbers below:
 *   B1: env passthrough     — callWithEmptyOutputRetries() env block (~L97)
 *   B2: argv shape          — args array assembly (~L79)
 *   B3: exit-code mapping   — runOpenCode() close handler (~L158)
 *   B4: mock-mode bypass    — turn() OPENCODE_MOCK_MODE check (~L48)
 *   B5: redaction-friendly  — error messages never echo env values (~L165)
 *
 * Metadata stamping, transcript shaping, and vars.turns validation are NOT
 * done here — they belong to _node_bridge.js per spec §1.5 + §2.6 + §7.4.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const { EVAL_ROOT } = require('./roots');
const DEFAULT_STATE_HOME = path.join(EVAL_ROOT, '.tmp', 'opencode-state');

// ---------------------------------------------------------------------------
// Lifecycle API (spec §1.2)
// ---------------------------------------------------------------------------

/**
 * Construct and return a new session.
 *
 * Session shape: { config, runner }
 * The config may carry a _runner override (injected by tests).
 *
 * @param {object} cfg — provider config block from _node_bridge.js
 * @returns {Promise<{ config: object, runner: Function, _turnCount: number }>}
 */
async function init(cfg) {
  const runner = cfg._runner || runOpenCode;
  return { config: cfg, runner, _turnCount: 0 };
}

/**
 * Execute one conversation turn.
 *
 * B4 (mock-mode bypass): if OPENCODE_MOCK_MODE=1 is set in the environment,
 * return a canned response without spawning the opencode binary. This allows
 * CI / scenario tests to run without a live OpenCode installation or API key.
 *
 * @param {{ config: object, runner: Function, _turnCount: number }} session
 * @param {string} input — the prompt string for this turn
 * @returns {Promise<{ output: string } | { error: string }>}
 */
async function turn(session, input) {
  // B4: mock-mode bypass — no spawn, no env read, no key exposure
  if (process.env.OPENCODE_MOCK_MODE === '1') {
    session._turnCount += 1;
    return { output: `[mock] turn ${session._turnCount}: ${input}` };
  }

  const { config, runner } = session;

  // Validate required fields — returns { error } without throwing
  const missingField = ['agent', 'opencode_config', 'project_dir', 'format', 'log_level']
    .find((field) => typeof config[field] !== 'string' || config[field].trim() === '');
  if (missingField) {
    return { error: 'OpenCode CLI provider requires agent, opencode_config, project_dir, format, and log_level' };
  }

  try {
    const output = await callWithEmptyOutputRetries(input, config, runner, {});
    session._turnCount += 1;
    return { output };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Summarize the session after all turns complete.
 *
 * @param {{ config: object, runner: Function, _turnCount: number }} session
 * @returns {Promise<{ final_text: string, turns_completed: number, tool_calls: [], metadata: {} }>}
 */
async function finalize(session) {
  return {
    final_text: '',
    turns_completed: session._turnCount,
    tool_calls: [],
    metadata: {},
  };
}

/**
 * Tear down the session. Idempotent — second call is a no-op.
 *
 * @param {{ config: object, runner: Function, _turnCount: number }} session
 * @returns {Promise<void>}
 */
async function shutdown(session) {
  // No persistent resources to release for the CLI provider.
  // Mark as shut down so a second call is a safe no-op.
  session._shutdown = true;
}

// ---------------------------------------------------------------------------
// callApi façade — backward compat for _node_bridge.js inproc dispatch
// ---------------------------------------------------------------------------

class OpenCodeCliProvider {
  constructor(options = {}) {
    this.config = options.config || {};
    this.providerId = options.id || 'opencode:cli';
    this.runner = options.runner || runOpenCode;
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, _context, callOptions = {}) {
    // B4: mock-mode bypass
    if (process.env.OPENCODE_MOCK_MODE === '1') {
      return { output: `[mock] ${prompt}` };
    }

    const missingField = ['agent', 'opencode_config', 'project_dir', 'format', 'log_level']
      .find((field) => typeof this.config[field] !== 'string' || this.config[field].trim() === '');
    if (missingField) {
      return { error: 'OpenCode CLI provider requires agent, opencode_config, project_dir, format, and log_level' };
    }

    try {
      const output = await callWithEmptyOutputRetries(prompt, this.config, this.runner, callOptions);
      return { output };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (shared between lifecycle API and callApi façade)
// ---------------------------------------------------------------------------

/**
 * Build the CLI args array and invoke the runner with empty-output retry.
 *
 * B1: env passthrough — spreads process.env, then overlays OPENCODE_CONFIG
 *     and XDG_STATE_HOME. The caller's full environment (including
 *     ANTHROPIC_API_KEY) reaches the child process via the spread.
 * B2: argv shape — fixed positional form documented in §7.4.
 *
 * @param {string} prompt
 * @param {object} config
 * @param {Function} runner
 * @param {{ abortSignal?: AbortSignal }} callOptions
 * @returns {Promise<string>}
 */
async function callWithEmptyOutputRetries(prompt, config, runner, callOptions) {
  const maxAttempts = 1 + normalizeRetryCount(config.empty_output_retries);
  let attempt = 0;
  const opencodeConfig = path.resolve(EVAL_ROOT, config.opencode_config);
  const projectDir = path.resolve(EVAL_ROOT, config.project_dir);

  // B2: argv shape — must be preserved byte-for-byte (§7.4)
  // OPENCODE_MODEL (consumer .env) overrides the per-agent model pinned in
  // opencode.json for this run; opencode validates the static config model at
  // load time regardless, so the override only swaps the run model, not the
  // config-load floor. Omitted when unset so the opencode.json default applies.
  const modelOverride = process.env.OPENCODE_MODEL;
  const args = [
    'run',
    ...(modelOverride ? ['--model', modelOverride] : []),
    '--agent',
    config.agent,
    '--dir',
    projectDir,
    '--format',
    config.format,
    '--log-level',
    config.log_level,
  ];
  if (config.print_logs) {
    args.push('--print-logs');
  }

  while (attempt < maxAttempts) {
    attempt += 1;
    // B1: env passthrough — process.env spread ensures ANTHROPIC_API_KEY et al. reach the child
    const output = await runner([...args, prompt], {
      cwd: EVAL_ROOT,
      env: {
        ...process.env,
        OPENCODE_CONFIG: opencodeConfig,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME || DEFAULT_STATE_HOME,
      },
      signal: callOptions.abortSignal,
    });
    const trimmedOutput = output.trim();
    if (trimmedOutput) {
      return trimmedOutput;
    }
  }

  throw new Error(`OpenCode CLI returned empty output after ${maxAttempts} attempt(s)`);
}

function normalizeRetryCount(value) {
  if (value === undefined) {
    return 0;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error('OpenCode CLI provider requires empty_output_retries to be a non-negative integer');
  }

  return value;
}

/**
 * Spawn the opencode binary and collect stdout/stderr.
 *
 * B3: exit-code mapping — code 0 resolves with stdout; non-zero rejects
 *     with stderr text or a generic "exited with code N" message.
 * B5: redaction-friendly — the rejection message is the raw stderr string
 *     from opencode (which should not contain secrets). The provider never
 *     injects env var values into error messages.
 *
 * @param {string[]} args
 * @param {{ cwd: string, env: object, stdio?: any, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
function runOpenCode(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', args, {
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
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (options.signal) {
        options.signal.removeEventListener('abort', abort);
      }

      const output = Buffer.concat(stdout).toString('utf8');
      // B5: errorOutput comes from the opencode binary's stderr — not from env values
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) {
        resolve(output);
        return;
      }

      // B3: non-zero exit → reject with stderr tail or generic message
      reject(new Error(errorOutput || `opencode exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// Lifecycle API (spec §1.2)
module.exports.init = init;
module.exports.turn = turn;
module.exports.finalize = finalize;
module.exports.shutdown = shutdown;

// Backward-compat: class constructor used by _node_bridge.js callApi inproc path
module.exports = OpenCodeCliProvider;
module.exports.init = init;
module.exports.turn = turn;
module.exports.finalize = finalize;
module.exports.shutdown = shutdown;
module.exports.runOpenCode = runOpenCode;
