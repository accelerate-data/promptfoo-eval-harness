#!/usr/bin/env node
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

bootstrapEvalRoot();

const { buildHarnessEnv } = require('../scripts/framework/environment');
const { discoverPackageConfigs } = require('../scripts/framework/package-discovery');
const { resolveHarnessPaths } = require('../scripts/framework/paths');
const { main: runPromptfooWithGuard } = require('../scripts/framework/run-promptfoo-with-guard');
const { validate } = require('../scripts/framework/validate-package-config');
const makeBridge = require('../scripts/framework/_node_bridge.js');
const { runScenarios, spawnScenario } = require('../scripts/framework/dir-walk');

function bootstrapEvalRoot() {
  if (process.env.AD_EVALS_ROOT) {
    return;
  }
  try {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (repoRoot) {
      process.env.AD_EVALS_ROOT = path.join(repoRoot, 'tests', 'evals');
    }
  } catch {
    // No git context. Framework modules fall back to __dirname-based resolution.
  }
}

function ensureDepsInstalled() {
  const evalRoot = process.env.AD_EVALS_ROOT;
  if (!evalRoot) return;
  if (!fs.existsSync(path.join(evalRoot, 'package.json'))) return;

  const lockfile = path.join(evalRoot, 'package-lock.json');
  const stamp = path.join(evalRoot, 'node_modules', '.install-stamp');

  if (fs.existsSync(lockfile) && fs.existsSync(stamp)) {
    const lockHash = crypto.createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex');
    if (fs.readFileSync(stamp, 'utf8').trim() === lockHash) return;
  }

  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: evalRoot,
    stdio: 'inherit',
  });

  if (fs.existsSync(lockfile)) {
    const lockHash = crypto.createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex');
    fs.writeFileSync(stamp, lockHash);
  }
}

/**
 * Commands that trigger Promptfoo evaluation and therefore require
 * tier config validation before dispatch.
 */
const EVAL_COMMANDS = new Set(['smoke', 'regression', 'run']);

/**
 * Print a validation error table to stderr and return exit code 2.
 *
 * @param {Array<{path, expected, received, message}>} errors
 * @param {object} logger
 * @returns {number} exit code 2
 */
function printValidationErrors(errors, logger) {
  logger.error('Package config validation failed:\n');
  const colPath = Math.max(4, ...errors.map((e) => e.path.length));
  const header = `  ${'PATH'.padEnd(colPath)}  MESSAGE`;
  logger.error(header);
  logger.error('  ' + '-'.repeat(header.length - 2));
  for (const e of errors) {
    logger.error(`  ${e.path.padEnd(colPath)}  ${e.message}`);
  }
  logger.error('');
  return 2;
}

/**
 * Attempt to load and validate the tier config from evalRoot.
 * Returns null if no config found (graceful skip for new/empty repos).
 * Returns exit code 2 on validation failure, 0 on success.
 *
 * @param {string} evalRoot
 * @param {object} logger
 * @returns {number|null} exit code or null to continue
 */
function runTierConfigValidation(evalRoot, logger) {
  const { parseTierConfig } = require('../scripts/framework/eval-tier-config');
  const { parse } = require('smol-toml');

  const configPath = path.join(evalRoot, 'config', 'eval-tiers.toml');
  if (!fs.existsSync(configPath)) {
    return null; // no config to validate — graceful skip
  }

  let raw;
  try {
    raw = parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    logger.error(`Failed to parse eval-tiers.toml: ${e.message}`);
    return 2;
  }

  let normalized;
  try {
    normalized = parseTierConfig(raw, configPath);
  } catch (e) {
    logger.error(`Tier config shape error: ${e.message}`);
    return 2;
  }

  const kindRegistry = makeBridge._KIND_REGISTRY;
  const result = validate(normalized, { kindRegistry });
  if (!result.ok) {
    return printValidationErrors(result.errors, logger);
  }
  return null; // validation passed — continue
}

function buildPromptfooArgs({ command, rest = [], packageConfigs = [] }) {
  if (command === 'smoke') {
    return [
      'eval',
      '--no-cache',
      '--filter-pattern',
      '^\\[smoke\\]',
      ...packageConfigs.flatMap((configPath) => ['-c', configPath]),
    ];
  }
  if (command === 'regression') {
    return [
      'eval',
      '--no-cache',
      ...packageConfigs.flatMap((configPath) => ['-c', configPath]),
    ];
  }
  if (command === 'run') {
    const [configPath, ...extraArgs] = rest;
    if (!configPath) {
      throw new Error('Usage: ad-evals run <config-path-or-dir> [promptfoo args]');
    }
    return ['eval', '--no-cache', '-c', configPath, ...extraArgs];
  }
  if (command === 'view') {
    return ['view', ...rest];
  }
  if (command === 'promptfoo') {
    return rest[0] === '--' ? rest.slice(1) : rest;
  }

  throw new Error(`Unknown ad-evals command: ${command}`);
}

// ---------------------------------------------------------------------------
// doctor command
// ---------------------------------------------------------------------------

/**
 * Run the doctor command.
 * Without flags: prints resolved paths as JSON (original behaviour).
 * With --install-providers: pre-warms the exact runtime command the bridge uses.
 *
 * @param {string[]} flags - Remaining argv after 'doctor'.
 * @param {object} paths - Resolved harness paths.
 * @param {object} logger - Console-like logger.
 * @returns {number} exit code
 */
function runDoctor(flags, paths, logger) {
  if (flags.includes('--install-providers')) {
    return runDoctorInstallProviders(paths, logger);
  }
  logger.log(JSON.stringify(paths, null, 2));
  return 0;
}

/**
 * Pre-warm SDK providers by running the EXACT command the bridge uses.
 * Reads pinned versions from config/sdk-pins.toml.
 * Honors AD_EVALS_OFFLINE=1 to skip network and assert cache hit instead.
 *
 * @param {object} paths - Resolved harness paths.
 * @param {object} logger - Console-like logger.
 * @returns {number} exit code (0 = success, 1 = failure)
 */
function runDoctorInstallProviders(paths, logger) {
  const { loadSdkPins } = require('../scripts/framework/sdk-pins');

  let pins;
  try {
    pins = loadSdkPins();
  } catch (err) {
    logger.error(`doctor: failed to load sdk-pins.toml: ${err.message}`);
    return 1;
  }

  const offline = process.env.AD_EVALS_OFFLINE === '1' || process.env.AD_EVALS_OFFLINE === 'true';
  let overallExit = 0;

  // openhands_sdk pre-warm
  const { version: ohVersion, python: ohPythonRange } = pins.openhands_sdk;
  // Extract minimum python version from range (e.g. ">=3.12,<3.14" → "3.12").
  const pythonVersion = _extractMinPython(ohPythonRange) || '3.12';
  const uvArgs = [
    'run',
    '--python', pythonVersion,
    '--with', `openhands-sdk==${ohVersion}`,
    'python', '-c', 'import openhands.sdk',
  ];

  if (offline) {
    logger.log(`doctor --install-providers: offline mode — probing uv cache for openhands-sdk==${ohVersion}`);
    const cacheResult = _probeUvCache(ohVersion, logger);
    if (!cacheResult) {
      logger.error(
        `MISSING_CACHE: openhands-sdk==${ohVersion} not in uv cache; ` +
        `drop AD_EVALS_OFFLINE=1 or pre-populate the cache`,
      );
      overallExit = 1;
    } else {
      logger.log(`doctor --install-providers: openhands-sdk==${ohVersion} found in uv cache`);
    }
  } else {
    logger.log(`doctor --install-providers: pre-warming openhands-sdk==${ohVersion} via uv run`);
    const start = Date.now();
    const result = spawnSync('uv', uvArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const elapsed = Date.now() - start;
    if (result.error) {
      logger.error(`doctor: uv spawn error: ${result.error.message}`);
      overallExit = 1;
    } else if (result.status !== 0) {
      const stderr = result.stderr ? result.stderr.toString().trim() : '';
      logger.error(`doctor: openhands-sdk==${ohVersion} pre-warm failed (exit ${result.status})`);
      if (stderr) logger.error(stderr);
      overallExit = result.status || 1;
    } else {
      logger.log(`doctor --install-providers: openhands-sdk==${ohVersion} ready (${elapsed}ms)`);
    }
  }

  return overallExit;
}

/**
 * Extract the minimum python version from a range string like ">=3.12,<3.14".
 *
 * @param {string} range - Python version range string.
 * @returns {string|null}
 */
function _extractMinPython(range) {
  if (!range) return null;
  const m = String(range).match(/>=\s*(\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * Probe the uv cache directory for a cached openhands-sdk wheel.
 *
 * @param {string} version - Expected version string.
 * @param {object} logger - Console-like logger.
 * @returns {boolean} true if found in cache.
 */
function _probeUvCache(version, logger) {
  try {
    const result = spawnSync('uv', ['cache', 'dir'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    if (result.status !== 0 || !result.stdout) return false;
    const cacheDir = result.stdout.toString().trim();
    if (!cacheDir || !fs.existsSync(cacheDir)) return false;

    // Walk the cache for a wheel matching openhands_sdk-<version>
    const found = _globUvCache(cacheDir, version);
    return found;
  } catch {
    return false;
  }
}

/**
 * Recursively search `dir` (up to 4 levels) for any file whose name matches
 * openhands(_sdk|sdk)-<version>-*.whl or the equivalent uv cache layout
 * (archive manifest dirs named with the package slug).
 *
 * @param {string} dir - Directory to search.
 * @param {string} version - Version to match.
 * @returns {boolean}
 */
function _globUvCache(dir, version) {
  function walk(d, depth) {
    if (depth > 4) return false;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (lower.includes('openhands') && lower.includes(version)) return true;
      if (e.isDirectory() && walk(path.join(d, e.name), depth + 1)) return true;
    }
    return false;
  }
  return walk(dir, 0);
}

// ---------------------------------------------------------------------------
// dir-walk scenarios fan-out (G.28)
// ---------------------------------------------------------------------------

/**
 * Run all scenarios in a directory tree (dir-walk fan-out).
 * Emits a per-scenario PASS/FAIL summary and returns the aggregated exit code.
 *
 * When `rootDir` lives inside EVAL_ROOT (consumer-owned scenarios that declare
 * only `metadata.eval_tier`), the fan-out materializes each scenario through
 * `writeResolvedConfig` so tier providers from `config/eval-tiers.toml` are
 * injected — matching the single-config flow. Harness-owned scenarios under
 * `tests/harness-scenarios/` stay on the direct-spawn fast path.
 *
 * @param {string} rootDir - Scenarios tree root directory.
 * @param {{evalRoot: string}} paths - Resolved harness paths.
 * @param {object} logger - Console-like logger.
 * @returns {Promise<number>} exit code
 */
async function runDirScenarios(rootDir, paths, logger) {
  const harnessRoot = path.resolve(__dirname, '..');
  const evalRootResolved = path.resolve(paths.evalRoot);
  const relFromEvalRoot = path.relative(evalRootResolved, path.resolve(rootDir));
  const injectProviders = Boolean(
    relFromEvalRoot &&
      !relFromEvalRoot.startsWith('..') &&
      !path.isAbsolute(relFromEvalRoot),
  );

  const suffix = injectProviders ? ' (consumer scenarios — injecting providers from eval-tiers.toml)' : '';
  logger.log(`ad-evals run: directory mode — scanning ${rootDir}${suffix}`);

  const { results, totalDurationMs, aggregatedExitCode } = await runScenarios(rootDir, {
    harnessRoot,
    env: process.env,
    injectProviders,
  });

  if (results.length === 0) {
    logger.log('ad-evals run: no scenarios found (no promptfooconfig.json in immediate subdirs)');
    return 0;
  }

  logger.log('\n--- Scenario Results ---');
  for (const r of results) {
    const status = r.exitCode === 0 ? 'PASS' : 'FAIL';
    logger.log(`  ${status}  ${r.name}  (${r.durationMs}ms)`);
    if (r.exitCode !== 0 && r.stderr) {
      logger.error(r.stderr.trim());
    }
  }
  const passed = results.filter((r) => r.exitCode === 0).length;
  logger.log(`\n${passed}/${results.length} scenarios passed in ${totalDurationMs}ms`);

  return aggregatedExitCode;
}

function prepareEnvironment(paths, { fsImpl = fs, env = process.env } = {}) {
  for (const dir of [
    paths.sharedPromptfooDir,
    paths.sharedOpenCodeStateDir,
    paths.promptfooCachePath,
    paths.promptfooLogDir,
    paths.promptfooMediaPath,
    paths.tmpDir,
  ]) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }

  Object.assign(env, buildHarnessEnv({ baseEnv: env, paths }));
}

function run(
  argv = process.argv.slice(2),
  {
    resolvePaths = resolveHarnessPaths,
    discoverConfigs = discoverPackageConfigs,
    runPromptfoo = runPromptfooWithGuard,
    spawn = spawnSync,
    fsImpl = fs,
    env = process.env,
    logger = console,
  } = {},
) {
  const [command = 'help', ...restArgs] = argv;
  let rest = restArgs;
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  const paths = resolvePaths();
  prepareEnvironment(paths, { fsImpl, env });

  if (command === 'doctor') {
    return runDoctor(rest, paths, logger);
  }

  if (command === 'test') {
    const result = spawn(
      process.execPath,
      ['--test', 'scripts/*.test.js', 'scripts/framework/*.test.js', 'assertions/*.test.js'],
      {
        cwd: paths.evalRoot,
        env,
        stdio: 'inherit',
      },
    );
    if (result.error) {
      logger.error(result.error instanceof Error ? result.error.message : String(result.error));
      return 1;
    }
    if (result.signal) {
      logger.error(`ad-evals test was terminated by signal ${result.signal}`);
      return 1;
    }
    return result.status ?? 1;
  }

  // G.28: run <dir> — if arg is a directory WITHOUT promptfooconfig.json directly
  // inside it, treat it as a scenarios tree and fan-out with outer p-limit.
  if (command === 'run') {
    const [argPath, ...extraRunArgs] = rest;
    if (!argPath) {
      logger.error('Usage: ad-evals run <config-path-or-dir> [promptfoo args]');
      return 1;
    }
    const absArg = path.resolve(argPath);
    if (fsImpl.existsSync(absArg) && fsImpl.statSync(absArg).isDirectory()) {
      const directConfig = path.join(absArg, 'promptfooconfig.json');
      if (fsImpl.existsSync(directConfig)) {
        // Single scenario dir.  If it lives outside EVAL_ROOT (the framework
        // -owned `tests/harness-scenarios/` tree), it's a self-contained
        // scenario — invoke promptfoo directly via dir-walk's spawnScenario,
        // matching the multi-scenario fan-out bypass-guard semantics.
        // Otherwise (a consumer-repo scenario under EVAL_ROOT), fall through
        // to the guarded resolve-promptfoo-config path.
        const evalRootResolved = path.resolve(paths.evalRoot);
        const relFromEvalRoot = path.relative(evalRootResolved, absArg);
        const withinEvalRoot = relFromEvalRoot &&
          !relFromEvalRoot.startsWith('..') &&
          !path.isAbsolute(relFromEvalRoot);
        if (!withinEvalRoot) {
          const harnessRoot = path.resolve(__dirname, '..');
          return spawnScenario(absArg, process.env, harnessRoot).then((r) => {
            const status = r.exitCode === 0 ? 'PASS' : 'FAIL';
            logger.log(`${status}  ${r.name}  (${r.durationMs}ms)`);
            if (r.stdout) logger.log(r.stdout.trim());
            if (r.exitCode !== 0 && r.stderr) logger.error(r.stderr.trim());
            return r.exitCode;
          });
        }
        // Mutate rest in-place for buildPromptfooArgs below.
        rest = [directConfig, ...extraRunArgs];
      } else {
        // Scenarios tree — async fan-out via dir-walk.
        return runDirScenarios(absArg, paths, logger);
      }
    }
    // Fall through: single config file (rest already correct).
  }

  // Validate tier config before dispatching to Promptfoo (B.11).
  // Only runs for eval commands; skips passthrough and informational commands.
  if (EVAL_COMMANDS.has(command)) {
    const validationResult = runTierConfigValidation(paths.evalRoot, logger);
    if (validationResult !== null) {
      return validationResult;
    }
  }

  const promptfooArgs = buildPromptfooArgs({
    command,
    rest,
    packageConfigs: discoverConfigs(paths.evalRoot),
  });
  return runPromptfoo(promptfooArgs);
}

function printHelp() {
  console.log([
    'Usage: ad-evals <command>',
    '',
    'Commands:',
    '  test',
    '  smoke',
    '  regression',
    '  run <config-path-or-dir> [promptfoo args]',
    '    If <dir> contains promptfooconfig.json: run that single scenario.',
    '    If <dir> has no promptfooconfig.json at top level: walk subdirs and',
    '    run all scenarios in parallel (outer p-limit, AD_EVALS_OUTER_CONCURRENCY).',
    '  view',
    '  doctor [--install-providers]',
    '  promptfoo -- <raw promptfoo args>',
  ].join('\n'));
}

if (require.main === module) {
  ensureDepsInstalled();
  try {
    const result = run();
    if (result && typeof result.then === 'function') {
      // Async result from dir-walk fan-out.
      result.then(
        (code) => { process.exitCode = code; },
        (error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
        },
      );
    } else {
      process.exitCode = result;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  buildPromptfooArgs,
  prepareEnvironment,
  run,
  runTierConfigValidation,
  printValidationErrors,
  runDoctor,
  runDoctorInstallProviders,
  runDirScenarios,
};
