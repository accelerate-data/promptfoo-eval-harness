'use strict';

/**
 * dir-walk.js — outer p-limit fan-out for scenario directories (spec §5.3, G.28).
 *
 * Outer (dir-walk) limit caps Promptfoo children; inner (bridge) limit caps
 * per-child case concurrency.  Total subprocess pressure ≈ outer × inner.
 * Default outer = os.cpus().length (AD_EVALS_OUTER_CONCURRENCY), inner = 4
 * (AD_EVALS_MAX_CONCURRENCY).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { getOuterLimit } = require('./concurrency');
const {
  writeResolvedConfig: defaultWriteResolvedConfig,
} = require('./resolve-promptfoo-config');
const { EVAL_ROOT } = require('./roots');

// ---------------------------------------------------------------------------
// Scenario enumeration
// ---------------------------------------------------------------------------

/**
 * Yield each immediate subdirectory of `rootDir` that contains a
 * `promptfooconfig.json` file.  Non-recursive (one level deep only).
 *
 * @param {string} rootDir - Directory to scan.
 * @yields {string} Absolute path to each matching scenario directory.
 */
function* walkScenarios(rootDir) {
  const absRoot = path.resolve(rootDir);
  let entries;
  try {
    entries = fs.readdirSync(absRoot, { withFileTypes: true });
  } catch (err) {
    throw new Error(`dir-walk: cannot read directory ${absRoot}: ${err.message}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const scenarioDir = path.join(absRoot, entry.name);
    const configFile = path.join(scenarioDir, 'promptfooconfig.json');
    if (fs.existsSync(configFile)) {
      yield scenarioDir;
    }
  }
}

// ---------------------------------------------------------------------------
// Single scenario subprocess
// ---------------------------------------------------------------------------

/**
 * Spawn Promptfoo directly for one scenario directory.
 *
 * Two modes:
 *  - Default (`injectProviders=false`): the scenario config is self-contained
 *    (providers already wired in promptfooconfig.json), so spawn Promptfoo
 *    against it directly. This is the harness-owned scenarios path
 *    (`tests/harness-scenarios/`) — they live outside EVAL_ROOT and bypass
 *    both the guard and tier-driven provider injection.
 *  - Consumer-injection (`injectProviders=true`): the scenario config lives
 *    inside EVAL_ROOT and only declares `metadata.eval_tier` — its providers
 *    come from `config/eval-tiers.toml`. Run `writeResolvedConfig` once before
 *    spawn so the materialized config under `.tmp/resolved-configs/...` carries
 *    the resolved provider block. Mirrors what `run-promptfoo-with-guard.main`
 *    does for the single-config flow, just per-scenario for the fan-out tree.
 *
 * @param {string} scenarioDir - Absolute path to the scenario directory.
 * @param {NodeJS.ProcessEnv} env - Environment to pass to the child process.
 * @param {string} harnessRoot - Repo root (used to locate node_modules/promptfoo).
 * @param {object} [options]
 * @param {boolean} [options.injectProviders=false] - Materialize tier providers.
 * @param {string[]} [options.extraArgs=[]] - Trailing Promptfoo args appended
 *   after `-c <config>` (e.g. `--max-concurrency`, `--filter-pattern`). In
 *   fan-out mode these apply per-package — total in-flight ≈ OUTER × inner.
 * @param {Function} [options.writeResolvedConfig] - Override for tests.
 * @param {Function} [options.spawn] - child_process.spawn override for tests.
 * @returns {Promise<{name: string, exitCode: number, stdout: string, stderr: string, durationMs: number}>}
 */
function spawnScenario(scenarioDir, env, harnessRoot, options = {}) {
  const {
    injectProviders = false,
    extraArgs = [],
    writeResolvedConfig: writeResolved = defaultWriteResolvedConfig,
    spawn: spawnImpl = spawn,
  } = options;
  const name = path.basename(scenarioDir);
  let configPath = path.join(scenarioDir, 'promptfooconfig.json');

  if (injectProviders) {
    const relConfig = path.relative(EVAL_ROOT, configPath);
    const materializedRel = writeResolved(relConfig);
    configPath = path.join(EVAL_ROOT, materializedRel);
  }
  // Invoke Promptfoo entrypoint directly — scenarios are self-contained and
  // live outside EVAL_ROOT, so they do not go through run-promptfoo-with-guard.
  const promptfooEntrypoint = path.join(
    harnessRoot, 'node_modules', 'promptfoo', 'dist', 'src', 'entrypoint.js',
  );
  const startMs = Date.now();

  // Isolate Promptfoo's SQLite state DB per-scenario so parallel runs don't race
  // on shared `~/.promptfoo/promptfoo.db` schema init. Each scenario gets its
  // own PROMPTFOO_CONFIG_DIR; cleaned up best-effort after the child exits.
  const promptfooConfigDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `ad-evals-promptfoo-${name}-`),
  );
  const childEnv = { ...env, PROMPTFOO_CONFIG_DIR: promptfooConfigDir };

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawnImpl(process.execPath, [promptfooEntrypoint, 'eval', '--no-cache', '-c', configPath, ...extraArgs], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      cwd: harnessRoot,
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const settle = (result) => {
      try {
        fs.rmSync(promptfooConfigDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      resolve(result);
    };

    child.on('close', (code, signal) => {
      const exitCode = code !== null ? code : (signal ? 1 : 1);
      settle({
        name,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startMs,
      });
    });

    child.on('error', (err) => {
      settle({
        name,
        exitCode: 1,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        durationMs: Date.now() - startMs,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all scenarios under `rootDir` in parallel, capped by the OUTER limit.
 *
 * @param {string} rootDir - Directory containing scenario subdirectories.
 * @param {object} [opts]
 * @param {number|string} [opts.concurrency] - Override for outer concurrency cap.
 * @param {NodeJS.ProcessEnv} [opts.env] - Environment for child processes.
 * @param {string} [opts.harnessRoot] - Harness repo root (default: process.cwd()).
 * @param {boolean} [opts.injectProviders=false] - Materialize tier providers
 *   for each scenario before spawn. Set when `rootDir` lives inside EVAL_ROOT
 *   (consumer-owned scenarios that rely on `config/eval-tiers.toml`).
 * @param {string[]} [opts.extraArgs=[]] - Trailing Promptfoo args forwarded to
 *   each scenario child (applied per-package; total in-flight ≈ OUTER × inner).
 * @param {Function} [opts.writeResolvedConfig] - Override for tests.
 * @param {Function} [opts.spawn] - child_process.spawn override for tests.
 * @returns {Promise<{results: Array, totalDurationMs: number, aggregatedExitCode: number}>}
 */
async function runScenarios(
  rootDir,
  { concurrency, env, harnessRoot, injectProviders = false, extraArgs = [], writeResolvedConfig: writeResolved, spawn: spawnImpl } = {},
) {
  const scenarioDirs = [...walkScenarios(rootDir)];

  if (scenarioDirs.length === 0) {
    return { results: [], totalDurationMs: 0, aggregatedExitCode: 0 };
  }

  const resolvedRoot = harnessRoot || process.cwd();

  // Determine concurrency cap (env override > arg > AD_EVALS_OUTER_CONCURRENCY > os.cpus().length).
  let limit;
  if (concurrency !== undefined && concurrency !== null) {
    const cap = Number(concurrency);
    const pLimit = require('p-limit');
    limit = pLimit(cap);
  } else {
    limit = getOuterLimit();
  }

  const childEnv = env ? { ...process.env, ...env } : process.env;

  const spawnOptions = { injectProviders, extraArgs };
  if (writeResolved) spawnOptions.writeResolvedConfig = writeResolved;
  if (spawnImpl) spawnOptions.spawn = spawnImpl;

  const startMs = Date.now();
  const results = await Promise.all(
    scenarioDirs.map((scenarioDir) =>
      limit(() => spawnScenario(scenarioDir, childEnv, resolvedRoot, spawnOptions)),
    ),
  );

  const totalDurationMs = Date.now() - startMs;
  const aggregatedExitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;

  return { results, totalDurationMs, aggregatedExitCode };
}

module.exports = { walkScenarios, runScenarios, spawnScenario };
