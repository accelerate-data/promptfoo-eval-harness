#!/usr/bin/env node
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

bootstrapEvalRoot();

const { buildHarnessEnv } = require('../scripts/framework/environment');
const { discoverPackageConfigs } = require('../scripts/framework/package-discovery');
const { resolveHarnessPaths } = require('../scripts/framework/paths');
const { main: runPromptfooWithGuard } = require('../scripts/framework/run-promptfoo-with-guard');
const { validate } = require('../scripts/framework/validate-package-config');
const makeBridge = require('../scripts/framework/_node_bridge.js');

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
      throw new Error('Usage: ad-evals run <config-path> [promptfoo args]');
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
  const [command = 'help', ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  const paths = resolvePaths();
  prepareEnvironment(paths, { fsImpl, env });

  if (command === 'doctor') {
    console.log(JSON.stringify(paths, null, 2));
    return 0;
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
    '  run <config-path> [promptfoo args]',
    '  view',
    '  doctor',
    '  promptfoo -- <raw promptfoo args>',
  ].join('\n'));
}

if (require.main === module) {
  ensureDepsInstalled();
  try {
    process.exitCode = run();
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
};
