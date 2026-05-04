const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolveHarnessPaths } = require('./paths');

test('resolveHarnessPaths keeps shared state under git common dir', () => {
  const calls = [];
  const paths = resolveHarnessPaths({
    cwd: '/repo/worktree/tests/evals',
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
