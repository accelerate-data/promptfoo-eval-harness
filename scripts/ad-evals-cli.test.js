const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildPromptfooArgs, run } = require('../bin/ad-evals');

test('smoke command discovers packages and adds smoke filter', () => {
  const args = buildPromptfooArgs({
    command: 'smoke',
    packageConfigs: ['packages/a/config.yaml', 'packages/b/config.json'],
  });

  assert.deepEqual(args, [
    'eval',
    '--no-cache',
    '--filter-pattern',
    '^\\[smoke\\]',
    '-c',
    'packages/a/config.yaml',
    '-c',
    'packages/b/config.json',
  ]);
});

test('regression command discovers every package config', () => {
  const args = buildPromptfooArgs({
    command: 'regression',
    packageConfigs: ['packages/a/config.yaml', 'packages/b/config.json'],
  });

  assert.deepEqual(args, [
    'eval',
    '--no-cache',
    '-c',
    'packages/a/config.yaml',
    '-c',
    'packages/b/config.json',
  ]);
});

test('run command targets one package config', () => {
  const args = buildPromptfooArgs({
    command: 'run',
    rest: ['packages/a/config.yaml', '--filter-pattern', 'case'],
    packageConfigs: [],
  });

  assert.deepEqual(args, [
    'eval',
    '--no-cache',
    '-c',
    'packages/a/config.yaml',
    '--filter-pattern',
    'case',
  ]);
});

test('promptfoo command passes raw args through after separator', () => {
  assert.deepEqual(
    buildPromptfooArgs({
      command: 'promptfoo',
      rest: ['--', 'eval', '-c', 'packages/a/config.yaml'],
      packageConfigs: [],
    }),
    ['eval', '-c', 'packages/a/config.yaml'],
  );
});

test('run prepares runtime env, creates state dirs, discovers packages, and delegates smoke to guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-cli-'));
  try {
    const paths = {
      repoRoot: path.join(root, 'repo'),
      gitCommonDir: path.join(root, '.git'),
      evalRoot: path.join(root, 'repo', 'tests', 'evals'),
      sharedPromptfooDir: path.join(root, '.git', 'ad-evals', 'promptfoo'),
      sharedOpenCodeStateDir: path.join(root, '.git', 'ad-evals', 'opencode-state'),
      promptfooCachePath: path.join(root, 'repo', 'tests', 'evals', '.cache', 'promptfoo'),
      promptfooLogDir: path.join(root, 'repo', 'tests', 'evals', 'results', 'logs'),
      promptfooMediaPath: path.join(root, 'repo', 'tests', 'evals', 'output', 'media'),
      tmpDir: path.join(root, 'repo', 'tests', 'evals', '.tmp'),
    };
    const env = { PATH: '/bin' };
    let discoveredRoot;
    let delegatedArgs;

    const status = run(['smoke'], {
      resolvePaths: () => paths,
      discoverConfigs: (evalRoot) => {
        discoveredRoot = evalRoot;
        return ['packages/a/promptfooconfig.json'];
      },
      runPromptfoo: (args) => {
        delegatedArgs = args;
        return 0;
      },
      env,
    });

    assert.equal(status, 0);
    assert.equal(discoveredRoot, paths.evalRoot);
    assert.deepEqual(delegatedArgs, [
      'eval',
      '--no-cache',
      '--filter-pattern',
      '^\\[smoke\\]',
      '-c',
      'packages/a/promptfooconfig.json',
    ]);
    assert.equal(env.PROMPTFOO_CONFIG_DIR, paths.sharedPromptfooDir);
    assert.equal(env.XDG_STATE_HOME, paths.sharedOpenCodeStateDir);
    assert.equal(env.PROMPTFOO_CACHE_PATH, paths.promptfooCachePath);
    assert.equal(env.PROMPTFOO_LOG_DIR, paths.promptfooLogDir);
    assert.equal(env.PROMPTFOO_MEDIA_PATH, paths.promptfooMediaPath);
    assert.equal(env.TMPDIR, paths.tmpDir);

    for (const dir of [
      paths.sharedPromptfooDir,
      paths.sharedOpenCodeStateDir,
      paths.promptfooCachePath,
      paths.promptfooLogDir,
      paths.promptfooMediaPath,
      paths.tmpDir,
    ]) {
      assert.equal(fs.statSync(dir).isDirectory(), true, `${dir} should be created`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test command fails when the child test process is terminated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-test-signal-'));
  try {
    const paths = {
      repoRoot: path.join(root, 'repo'),
      gitCommonDir: path.join(root, '.git'),
      evalRoot: path.join(root, 'repo', 'tests', 'evals'),
      sharedPromptfooDir: path.join(root, '.git', 'ad-evals', 'promptfoo'),
      sharedOpenCodeStateDir: path.join(root, '.git', 'ad-evals', 'opencode-state'),
      promptfooCachePath: path.join(root, 'repo', 'tests', 'evals', '.cache', 'promptfoo'),
      promptfooLogDir: path.join(root, 'repo', 'tests', 'evals', 'results', 'logs'),
      promptfooMediaPath: path.join(root, 'repo', 'tests', 'evals', 'output', 'media'),
      tmpDir: path.join(root, 'repo', 'tests', 'evals', '.tmp'),
    };

    const status = run(['test'], {
      resolvePaths: () => paths,
      spawn: () => ({ status: null, signal: 'SIGTERM' }),
      env: { PATH: '/bin' },
      logger: { error: () => {} },
    });

    assert.equal(status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test command fails when the child test process cannot start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-test-error-'));
  try {
    const paths = {
      repoRoot: path.join(root, 'repo'),
      gitCommonDir: path.join(root, '.git'),
      evalRoot: path.join(root, 'repo', 'tests', 'evals'),
      sharedPromptfooDir: path.join(root, '.git', 'ad-evals', 'promptfoo'),
      sharedOpenCodeStateDir: path.join(root, '.git', 'ad-evals', 'opencode-state'),
      promptfooCachePath: path.join(root, 'repo', 'tests', 'evals', '.cache', 'promptfoo'),
      promptfooLogDir: path.join(root, 'repo', 'tests', 'evals', 'results', 'logs'),
      promptfooMediaPath: path.join(root, 'repo', 'tests', 'evals', 'output', 'media'),
      tmpDir: path.join(root, 'repo', 'tests', 'evals', '.tmp'),
    };

    const status = run(['test'], {
      resolvePaths: () => paths,
      spawn: () => ({ error: new Error('spawn failed'), status: null, signal: null }),
      env: { PATH: '/bin' },
      logger: { error: () => {} },
    });

    assert.equal(status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
