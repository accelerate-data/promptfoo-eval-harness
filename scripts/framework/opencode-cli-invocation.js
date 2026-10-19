'use strict';

// Generation-aware OpenCode CLI invocation (VD-7010).
//
// OpenCode v1 and v2 do not accept the same argv for a non-interactive run:
//
//   v1  run --agent <a> --dir <projectDir> --format <f> --log-level <l> <prompt>
//   v2  run --standalone --agent <a> --format <f> --log-level <l> <prompt>
//
// Three measured v2 differences drive the split:
//
//   - `run --dir` was removed. The working directory is the project, so
//     `project_dir` moves from the argv onto the spawn cwd.
//   - `OPENCODE_CONFIG` is honoured only alongside `--standalone`. Without it
//     the agents defined in the tier's `opencode_config` are not found, which
//     is what lets an out-of-cwd config resolve when the cwd is `project_dir`.
//   - `--log-level` accepts lowercase choices only; `ERROR` is rejected
//     outright by the CLI.
//
// The v1 argv shape is the locked §7.4 / B2 contract, so detection falls back
// to v1 whenever v2 cannot be proven. Nothing here spawns a model call: the
// only probe is `<runner> --version`.

const { spawn } = require('node:child_process');

const GENERATION_ENV_VAR = 'OPENCODE_CLI_MAJOR';
const DEFAULT_MAJOR = 1;
const V1 = 1;
const V2 = 2;
const VERSION_FLAG = '--version';
const PROBE_TIMEOUT_MS = 10000;

// Memoised per runner command: the probe is a process-lifetime fact, not a
// per-turn one. A failed or unparseable probe is cached as v1 as well, so a
// misconfigured runner cannot turn every conversation turn into a spawn.
const majorCache = new Map();

/**
 * Tokenise a runner command string into argv parts, honouring single and
 * double quotes. Ported from the sibling provider (which used it to resolve
 * `OPENCODE_RUNNER_COMMAND`) so generation detection runs the exact binary the
 * invocation will run, including any prefix args.
 *
 * @param {string} command
 * @returns {string[]}
 */
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

/**
 * Normalise an explicit major-version input. v2-or-later maps to the v2 shape:
 * the argv split is a generation boundary (v1 vs the current CLI), and a future
 * major is far more likely to still speak the v2 shape than to revert to
 * `--dir`. Anything unparseable returns null so the caller can apply the v1
 * default.
 *
 * @param {unknown} value
 * @returns {1|2|null}
 */
function normalizeMajor(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed >= V2 ? V2 : V1;
}

/**
 * Parse `<runner> --version` output. Accepts the observed `opencode v2.0.32`
 * shape and tolerates a missing `v`.
 *
 * @param {unknown} versionOutput
 * @returns {1|2|null}
 */
function parseMajor(versionOutput) {
  const match = /v?(\d+)\.\d+/.exec(String(versionOutput || ''));
  if (!match) return null;
  return normalizeMajor(match[1]);
}

/**
 * Run `<runner> --version` and resolve to its raw stdout. Never throws and
 * never rejects — an absent or unresponsive binary resolves to null, which the
 * caller turns into the v1 default. Returning the output rather than a parsed
 * major keeps the probe seam (see `resolveMajor`) a plain "ask the binary"
 * function.
 *
 * @param {string} runnerCommand
 * @param {object} env
 * @returns {Promise<string|null>}
 */
function probeVersion(runnerCommand, env) {
  return new Promise((resolve) => {
    let parts;
    try {
      parts = splitCommand(runnerCommand);
    } catch (_) {
      resolve(null);
      return;
    }
    if (parts.length === 0) {
      resolve(null);
      return;
    }

    let child;
    try {
      child = spawn(parts[0], [...parts.slice(1), VERSION_FLAG], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch (_) {
      resolve(null);
      return;
    }

    const stdout = [];
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    if (child.stdout) child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.on('error', () => settle(null));
    child.on('close', () => settle(Buffer.concat(stdout).toString('utf8')));
  });
}

/**
 * Resolve which CLI generation the runner command speaks.
 *
 * Order: explicit `OPENCODE_CLI_MAJOR` override, then a one-time probe, then
 * the v1 default.
 *
 * @param {{ runnerCommand?: string, env?: object,
 *           probe?: (runnerCommand: string, env: object) => Promise<string|null> }} [options]
 * @returns {Promise<1|2>}
 */
async function resolveMajor(options = {}) {
  const env = options.env || process.env;
  const runnerCommand = typeof options.runnerCommand === 'string' && options.runnerCommand.trim() !== ''
    ? options.runnerCommand.trim()
    : 'opencode';

  const override = normalizeMajor(env[GENERATION_ENV_VAR]);
  if (override) return override;

  if (majorCache.has(runnerCommand)) return majorCache.get(runnerCommand);

  const probe = typeof options.probe === 'function' ? options.probe : probeVersion;
  let detected = null;
  try {
    detected = parseMajor(await probe(runnerCommand, env));
  } catch (_) {
    detected = null;
  }
  const major = detected || DEFAULT_MAJOR;
  majorCache.set(runnerCommand, major);
  return major;
}

/**
 * Build the `run` argv for a generation.
 *
 * v1 is byte-for-byte the locked §7.4 shape. `--format` / `--log-level` are
 * emitted only when their value is a non-empty string: the sibling always
 * guarded them, while the base provider instead emitted the literal string
 * `undefined` as a bare argv word. That was unreachable through a tier config
 * (`format` and `log_level` are required runtime fields) but reachable from a
 * hand-built config; guarding drops the flag instead of sending that word.
 *
 * @param {{ major: 1|2, agent: string, format?: string, logLevel?: string,
 *           projectDir: string, modelOverride?: string|null, printLogs?: boolean }} spec
 * @returns {string[]}
 */
function buildRunArgs(spec) {
  const major = normalizeMajor(spec.major) || DEFAULT_MAJOR;
  const args = ['run'];

  if (major === V2) {
    // Required for OPENCODE_CONFIG to be honoured at all on v2.
    args.push('--standalone');
  }

  args.push('--agent', spec.agent);

  if (major === V1) {
    args.push('--dir', spec.projectDir);
  }

  if (typeof spec.format === 'string' && spec.format !== '') {
    args.push('--format', spec.format);
  }

  if (typeof spec.logLevel === 'string' && spec.logLevel !== '') {
    args.push('--log-level', major === V2 ? spec.logLevel.toLowerCase() : spec.logLevel);
  }

  if (typeof spec.modelOverride === 'string' && spec.modelOverride.trim() !== '') {
    args.push('--model', spec.modelOverride.trim());
  }

  if (spec.printLogs) {
    args.push('--print-logs');
  }

  return args;
}

/**
 * Resolve the spawn working directory for a generation.
 *
 * v1 addresses the project through `--dir` while running from the eval root, so
 * that is preserved exactly. v2 has no `--dir`, so the cwd carries
 * `project_dir`; the tier's config still resolves because the invocation
 * carries `--standalone` (+ `OPENCODE_CONFIG`).
 *
 * @param {{ major: 1|2, evalRoot: string, projectDir: string }} spec
 * @returns {string}
 */
function resolveSpawnCwd(spec) {
  const major = normalizeMajor(spec.major) || DEFAULT_MAJOR;
  return major === V2 ? spec.projectDir : spec.evalRoot;
}

/** Test seam — clears the memoised detection cache. */
function _resetMajorCache() {
  majorCache.clear();
}

module.exports = {
  GENERATION_ENV_VAR,
  DEFAULT_MAJOR,
  splitCommand,
  normalizeMajor,
  parseMajor,
  probeVersion,
  resolveMajor,
  buildRunArgs,
  resolveSpawnCwd,
  _resetMajorCache,
};
