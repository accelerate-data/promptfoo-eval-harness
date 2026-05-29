const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolveHarnessPaths } = require('./paths');

test('resolveHarnessPaths keeps shared state under git common dir', () => {
  const calls = [];
  const paths = resolveHarnessPaths({
    cwd: '/repo/worktree/tests/evals',
    env: {},
    execFileSync: (command, args) => {
      calls.push([command, args]);
      if (args.includes('--show-toplevel')) {
        return '/repo/worktree\n';
      }
      if (args.includes('--git-common-dir')) {
        return '/repo/source/.git\n';
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  assert.deepEqual(calls, [
    ['git', ['rev-parse', '--show-toplevel']],
    ['git', ['rev-parse', '--git-common-dir']],
  ]);
  assert.equal(paths.repoRoot, '/repo/worktree');
  assert.equal(paths.gitCommonDir, '/repo/source/.git');
  assert.equal(paths.evalRoot, path.join('/repo/worktree', 'tests', 'evals'));
  assert.equal(paths.sharedPromptfooDir, path.join('/repo/source/.git', 'ad-evals', 'promptfoo'));
  assert.equal(paths.sharedOpenCodeStateDir, path.join('/repo/source/.git', 'ad-evals', 'opencode-state'));
  assert.equal(paths.promptfooCachePath, path.join('/repo/worktree', 'tests', 'evals', '.cache', 'promptfoo'));
  assert.equal(paths.promptfooLogDir, path.join('/repo/worktree', 'tests', 'evals', 'results', 'logs'));
  assert.equal(paths.promptfooMediaPath, path.join('/repo/worktree', 'tests', 'evals', 'output', 'media'));
  assert.equal(paths.tmpDir, path.join('/repo/worktree', 'tests', 'evals', '.tmp'));
});

test('resolveHarnessPaths resolves relative git common dir from repo root', () => {
  const paths = resolveHarnessPaths({
    cwd: '/repo/worktree/tests/evals',
    env: {},
    execFileSync: (_command, args) => {
      if (args.includes('--show-toplevel')) {
        return '/repo/worktree\n';
      }
      if (args.includes('--git-common-dir')) {
        return '../source/.git\n';
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  const expectedGitCommonDir = path.resolve('/repo/worktree', '../source/.git');
  assert.equal(paths.gitCommonDir, expectedGitCommonDir);
  assert.equal(paths.sharedPromptfooDir, path.join(expectedGitCommonDir, 'ad-evals', 'promptfoo'));
});

test('resolveHarnessPaths honors AD_EVALS_ROOT env override for evalRoot-derived paths', () => {
  // Regression guard: paths.js used to ignore AD_EVALS_ROOT, while roots.js
  // honored it. The split caused discoverPackageConfigs to look under
  // <git-root>/tests/evals while promptfoo (cwd=AD_EVALS_ROOT) ran in the
  // overridden directory — a silent "no configs found" failure mode.
  const paths = resolveHarnessPaths({
    cwd: '/repo/worktree',
    env: { AD_EVALS_ROOT: '/elsewhere/example-eval-root' },
    execFileSync: (_command, args) => {
      if (args.includes('--show-toplevel')) return '/repo/worktree\n';
      if (args.includes('--git-common-dir')) return '/repo/worktree/.git\n';
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  assert.equal(paths.evalRoot, '/elsewhere/example-eval-root');
  // Shared state still keyed off the git common dir — the override only
  // moves evalRoot-derived paths, not git-derived ones.
  assert.equal(paths.gitCommonDir, '/repo/worktree/.git');
  assert.equal(paths.sharedPromptfooDir, path.join('/repo/worktree/.git', 'ad-evals', 'promptfoo'));
  assert.equal(paths.promptfooCachePath, path.join('/elsewhere/example-eval-root', '.cache', 'promptfoo'));
  assert.equal(paths.tmpDir, path.join('/elsewhere/example-eval-root', '.tmp'));
});

test('resolveHarnessPaths resolves a relative AD_EVALS_ROOT against process cwd', () => {
  const cwdSaved = process.cwd();
  // Resolve from a stable directory so the test result is deterministic.
  process.chdir(path.sep === '/' ? '/tmp' : path.parse(cwdSaved).root);
  try {
    const paths = resolveHarnessPaths({
      cwd: '/repo/worktree',
      env: { AD_EVALS_ROOT: 'relative/eval/root' },
      execFileSync: (_command, args) => {
        if (args.includes('--show-toplevel')) return '/repo/worktree\n';
        if (args.includes('--git-common-dir')) return '/repo/worktree/.git\n';
        throw new Error(`unexpected args: ${args.join(' ')}`);
      },
    });
    assert.equal(paths.evalRoot, path.resolve(process.cwd(), 'relative/eval/root'));
  } finally {
    process.chdir(cwdSaved);
  }
});
