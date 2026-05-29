const { execFileSync } = require('node:child_process');
const path = require('node:path');

function gitOutput(args, cwd, execFile = execFileSync) {
  return execFile('git', args, { cwd, encoding: 'utf8' }).trim();
}

function resolveHarnessPaths({
  cwd = process.cwd(),
  execFileSync: execFile = execFileSync,
  env = process.env,
} = {}) {
  const repoRoot = gitOutput(['rev-parse', '--show-toplevel'], cwd, execFile);
  const rawGitCommonDir = gitOutput(['rev-parse', '--git-common-dir'], repoRoot, execFile);
  const gitCommonDir = path.resolve(repoRoot, rawGitCommonDir);
  // Honor AD_EVALS_ROOT so callers (CLI bootstrap, examples, custom layouts)
  // can drive the harness against any directory. roots.js already honors this
  // env var; paths.js used to silently ignore it, leaving discoverPackageConfigs
  // pointed at <git-root>/tests/evals while promptfoo ran in the overridden cwd.
  const evalRoot = env && env.AD_EVALS_ROOT
    ? path.resolve(env.AD_EVALS_ROOT)
    : path.join(repoRoot, 'tests', 'evals');
  const sharedRoot = path.join(gitCommonDir, 'ad-evals');

  return {
    repoRoot,
    gitCommonDir,
    evalRoot,
    sharedPromptfooDir: path.join(sharedRoot, 'promptfoo'),
    sharedOpenCodeStateDir: path.join(sharedRoot, 'opencode-state'),
    promptfooCachePath: path.join(evalRoot, '.cache', 'promptfoo'),
    promptfooLogDir: path.join(evalRoot, 'results', 'logs'),
    promptfooMediaPath: path.join(evalRoot, 'output', 'media'),
    tmpDir: path.join(evalRoot, '.tmp'),
  };
}

module.exports = { resolveHarnessPaths };
