const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { writeResolvedConfig } = require('./resolve-promptfoo-config');
const { EVAL_ROOT, REPO_ROOT } = require('./roots');

const PROMPTFOO_ENTRYPOINT = path.join(
  EVAL_ROOT,
  'node_modules',
  'promptfoo',
  'dist',
  'src',
  'entrypoint.js',
);

const ALLOWED_ARTIFACT_PREFIXES = [
  'tests/evals/.cache/',
  'tests/evals/.tmp/',
  'tests/evals/output/',
  'tests/evals/results/',
];
const PROMPTFOO_EVAL_RESULT_FAILURE_STATUS = 100;

function runGitLines(args) {
  const output = execFileSync(
    'git',
    ['-C', REPO_ROOT, ...args],
    { encoding: 'utf8' },
  );

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hashRepoFile(filePath) {
  const absolutePath = path.join(REPO_ROOT, filePath);
  if (!fs.existsSync(absolutePath)) {
    return 'missing';
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    return `non-file:${stat.mode}`;
  }

  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(absolutePath))
    .digest('hex');
}

function hashPaths(paths) {
  return new Map([...paths].map((filePath) => [filePath, hashRepoFile(filePath)]));
}

function collectGitSnapshot() {
  const tracked = new Set(
    runGitLines(['diff', '--name-only', 'HEAD', '--', 'tests/evals']),
  );
  const untracked = new Set(
    runGitLines(['ls-files', '--others', '--exclude-standard', '--', 'tests/evals']),
  );

  return {
    tracked,
    untracked,
    trackedHashes: hashPaths(tracked),
    untrackedHashes: hashPaths(untracked),
  };
}

function isAllowedArtifactPath(filePath) {
  return ALLOWED_ARTIFACT_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function collectNewPaths(beforeSet, afterSet) {
  return [...afterSet].filter((filePath) => !beforeSet.has(filePath));
}

function collectChangedPreexistingPaths(beforeSet, afterSet, beforeHashes, afterHashes) {
  if (!beforeHashes || !afterHashes) {
    return [];
  }

  return [...afterSet].filter((filePath) => (
    beforeSet.has(filePath) && beforeHashes.get(filePath) !== afterHashes.get(filePath)
  ));
}

function detectCleanupViolations(before, after) {
  const newTracked = collectNewPaths(before.tracked, after.tracked);
  const newUntracked = collectNewPaths(before.untracked, after.untracked);
  const changedTracked = collectChangedPreexistingPaths(
    before.tracked,
    after.tracked,
    before.trackedHashes,
    after.trackedHashes,
  );
  const changedUntracked = collectChangedPreexistingPaths(
    before.untracked,
    after.untracked,
    before.untrackedHashes,
    after.untrackedHashes,
  );

  return [...newTracked, ...newUntracked, ...changedTracked, ...changedUntracked]
    .filter((filePath) => !isAllowedArtifactPath(filePath))
    .sort();
}

function formatViolationMessage(paths) {
  return [
    'Eval run dirtied files outside approved artifact directories:',
    ...paths.map((filePath) => `- ${filePath}`),
    'Allowed artifact roots: tests/evals/.cache/, tests/evals/.tmp/, tests/evals/output/, tests/evals/results/',
  ].join('\n');
}

function resolveRepoPath(filePath, repoRoot = REPO_ROOT) {
  const resolved = path.resolve(repoRoot, filePath);
  const repoRootWithSeparator = `${repoRoot}${path.sep}`;
  if (resolved !== repoRoot && !resolved.startsWith(repoRootWithSeparator)) {
    throw new Error(`Refusing to restore path outside repository: ${filePath}`);
  }
  return resolved;
}

function restoreCleanupViolations(
  paths,
  {
    execFileSync: execFile = execFileSync,
    repoRoot = REPO_ROOT,
    resolveRepoPath: resolvePath = (filePath) => resolveRepoPath(filePath, repoRoot),
    rmSync = fs.rmSync,
    runGitLines: gitLines = runGitLines,
  } = {},
) {
  if (paths.length === 0) {
    return;
  }

  const trackedPaths = new Set(gitLines(['ls-files', '--', ...paths]));
  const trackedViolations = paths.filter((filePath) => trackedPaths.has(filePath));
  const untrackedViolations = paths.filter((filePath) => !trackedPaths.has(filePath));

  for (const filePath of untrackedViolations) {
    rmSync(resolvePath(filePath), { force: true, recursive: true });
  }

  if (trackedViolations.length > 0) {
    execFile(
      'git',
      ['-C', repoRoot, 'checkout', '--', ...trackedViolations],
      { stdio: 'ignore' },
    );
  }
}

function splitPromptfooInvocations(argv) {
  const sharedArgs = [];
  const configArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-c') {
      const configPath = argv[index + 1];
      if (!configPath) {
        throw new Error('Missing config path after -c');
      }

      configArgs.push(configPath);
      index += 1;
      continue;
    }

    sharedArgs.push(token);
  }

  if (configArgs.length === 0) {
    return [sharedArgs];
  }

  return configArgs.map((configPath) => [...sharedArgs, '-c', configPath]);
}

function materializeInvocation(argv, { writeResolvedConfig: writeResolved = writeResolvedConfig } = {}) {
  const next = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '-c') {
      const configPath = argv[index + 1];
      if (!configPath) {
        throw new Error('Missing config path after -c');
      }

      next.push('-c');
      next.push(
        shouldMaterializeConfig(configPath)
          ? writeResolved(configPath)
          : configPath,
      );
      index += 1;
      continue;
    }

    next.push(token);
  }

  return next;
}

function applyDefaultEvalConcurrency(argv) {
  const hasConcurrency = argv.some(
    (token) => token === '--max-concurrency' || token.startsWith('--max-concurrency='),
  );
  if (argv[0] !== 'eval' || hasConcurrency) {
    return argv;
  }

  return ['eval', '--max-concurrency', '4', ...argv.slice(1)];
}

function shouldMaterializeConfig(configPath) {
  if (!configPath || configPath.startsWith('.tmp/resolved-configs/')) {
    return false;
  }

  return configPath.endsWith('.yaml') || configPath.endsWith('.yml') || configPath.endsWith('.json');
}

function runPromptfooInvocation(
  argv,
  {
    materializeInvocation: materialize = materializeInvocation,
    spawnSync: spawn = spawnSync,
  } = {},
) {
  const materializedArgv = applyDefaultEvalConcurrency(materialize(argv));
  const result = spawn(
    process.execPath,
    [PROMPTFOO_ENTRYPOINT, ...materializedArgv],
    {
      cwd: EVAL_ROOT,
      env: process.env,
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== null) {
    return result.status;
  }

  if (result.signal) {
    console.error(`promptfoo exited due to signal ${result.signal}`);
    return 1;
  }

  return 1;
}

function main(
  argv = process.argv.slice(2),
  {
    collectGitSnapshot: collectSnapshot = collectGitSnapshot,
    detectCleanupViolations: detectViolations = detectCleanupViolations,
    formatViolationMessage: formatViolations = formatViolationMessage,
    restoreCleanupViolations: restoreViolations = restoreCleanupViolations,
    runPromptfooInvocation: runInvocation = runPromptfooInvocation,
    splitPromptfooInvocations: splitInvocations = splitPromptfooInvocations,
  } = {},
) {
  let finalStatus = 0;

  for (const invocation of splitInvocations(argv)) {
    const before = collectSnapshot();
    const status = runInvocation(invocation);
    const after = collectSnapshot();
    const violations = detectViolations(before, after);

    if (violations.length > 0) {
      const preexistingPaths = new Set([...before.tracked, ...before.untracked]);
      restoreViolations(violations.filter((filePath) => !preexistingPaths.has(filePath)));
      console.error(formatViolations(violations));
      return 1;
    }

    if (status !== 0 && status !== PROMPTFOO_EVAL_RESULT_FAILURE_STATUS) {
      finalStatus = finalStatus || status;
    }
  }

  return finalStatus;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  ALLOWED_ARTIFACT_PREFIXES,
  PROMPTFOO_EVAL_RESULT_FAILURE_STATUS,
  collectGitSnapshot,
  detectCleanupViolations,
  formatViolationMessage,
  hashPaths,
  isAllowedArtifactPath,
  main,
  materializeInvocation,
  runPromptfooInvocation,
  applyDefaultEvalConcurrency,
  restoreCleanupViolations,
  shouldMaterializeConfig,
  splitPromptfooInvocations,
};
