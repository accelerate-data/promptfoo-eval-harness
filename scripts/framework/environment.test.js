const assert = require('node:assert/strict');
const test = require('node:test');

const { buildHarnessEnv } = require('./environment');

test('buildHarnessEnv exports shared Promptfoo state and worktree-local artifacts', () => {
  const env = buildHarnessEnv({
    baseEnv: { PATH: '/bin' },
    paths: {
      repoRoot: '/repo/worktree',
      sharedPromptfooDir: '/repo/.git/ad-evals/promptfoo',
      sharedOpenCodeStateDir: '/repo/.git/ad-evals/opencode-state',
      promptfooCachePath: '/repo/worktree/tests/evals/.cache/promptfoo',
      promptfooLogDir: '/repo/worktree/tests/evals/results/logs',
      promptfooMediaPath: '/repo/worktree/tests/evals/output/media',
      tmpDir: '/repo/worktree/tests/evals/.tmp',
    },
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.PROMPTFOO_CONFIG_DIR, '/repo/.git/ad-evals/promptfoo');
  assert.equal(env.XDG_STATE_HOME, '/repo/.git/ad-evals/opencode-state');
  assert.equal(env.PROMPTFOO_CACHE_PATH, '/repo/worktree/tests/evals/.cache/promptfoo');
  assert.equal(env.PROMPTFOO_LOG_DIR, '/repo/worktree/tests/evals/results/logs');
  assert.equal(env.PROMPTFOO_MEDIA_PATH, '/repo/worktree/tests/evals/output/media');
  assert.equal(env.CLAUDE_PLUGIN_ROOT, '/repo/worktree');
  assert.equal(env.TMPDIR, '/repo/worktree/tests/evals/.tmp');
  assert.equal(env.TMP, '/repo/worktree/tests/evals/.tmp');
  assert.equal(env.TEMP, '/repo/worktree/tests/evals/.tmp');
});

test('buildHarnessEnv preserves caller timeout overrides', () => {
  const env = buildHarnessEnv({
    baseEnv: {
      PROMPTFOO_EVAL_TIMEOUT_MS: '120000',
      PROMPTFOO_SCHEDULER_QUEUE_TIMEOUT_MS: '130000',
    },
    paths: {
      repoRoot: '/repo/worktree',
      sharedPromptfooDir: '/repo/.git/ad-evals/promptfoo',
      sharedOpenCodeStateDir: '/repo/.git/ad-evals/opencode-state',
      promptfooCachePath: '/repo/worktree/tests/evals/.cache/promptfoo',
      promptfooLogDir: '/repo/worktree/tests/evals/results/logs',
      promptfooMediaPath: '/repo/worktree/tests/evals/output/media',
      tmpDir: '/repo/worktree/tests/evals/.tmp',
    },
  });

  assert.equal(env.PROMPTFOO_EVAL_TIMEOUT_MS, '120000');
  assert.equal(env.PROMPTFOO_SCHEDULER_QUEUE_TIMEOUT_MS, '130000');
});
