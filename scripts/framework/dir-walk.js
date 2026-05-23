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
 * Spawn `node bin/ad-evals.js run <configPath>` for one scenario directory.
 *
 * @param {string} scenarioDir - Absolute path to the scenario directory.
 * @param {NodeJS.ProcessEnv} env - Environment to pass to the child process.
 * @param {string} harnessRoot - Repo root (used to resolve bin/ad-evals.js).
 * @returns {Promise<{name: string, exitCode: number, stdout: string, stderr: string, durationMs: number}>}
 */
function spawnScenario(scenarioDir, env, harnessRoot) {
  const name = path.basename(scenarioDir);
  const configPath = path.join(scenarioDir, 'promptfooconfig.json');
  const adEvalsBin = path.join(harnessRoot, 'bin', 'ad-evals.js');
  const startMs = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn(process.execPath, [adEvalsBin, 'run', configPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: harnessRoot,
    });

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      const exitCode = code !== null ? code : (signal ? 1 : 1);
      resolve({
        name,
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startMs,
      });
    });

    child.on('error', (err) => {
      resolve({
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
 * @returns {Promise<{results: Array, totalDurationMs: number, aggregatedExitCode: number}>}
 */
async function runScenarios(rootDir, { concurrency, env, harnessRoot } = {}) {
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

  const startMs = Date.now();
  const results = await Promise.all(
    scenarioDirs.map((scenarioDir) =>
      limit(() => spawnScenario(scenarioDir, childEnv, resolvedRoot)),
    ),
  );

  const totalDurationMs = Date.now() - startMs;
  const aggregatedExitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;

  return { results, totalDurationMs, aggregatedExitCode };
}

module.exports = { walkScenarios, runScenarios, spawnScenario };
