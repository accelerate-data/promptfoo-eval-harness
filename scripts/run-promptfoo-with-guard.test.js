const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ALLOWED_ARTIFACT_PREFIXES,
  PROMPTFOO_EVAL_RESULT_FAILURE_STATUS,
  applyDefaultEvalConcurrency,
  assertWorkspaceClean,
  detectCleanupViolations,
  main,
  materializeInvocation,
  restoreCleanupViolations,
  runPromptfooInvocation,
  shouldMaterializeConfig,
  splitPromptfooInvocations,
} = require('./framework/run-promptfoo-with-guard');

test('detectCleanupViolations ignores new files under approved eval artifact directories', () => {
  const before = {
    tracked: new Set(),
    untracked: new Set(),
  };
  const after = {
    tracked: new Set(),
    untracked: new Set([
      'tests/evals/output/runs/harness-smoke/run-1/transcript.txt',
      'tests/evals/results/logs/promptfoo.log',
      'tests/evals/.tmp/trace.json',
      'tests/evals/.cache/promptfoo/cache.db',
    ]),
  };

  const violations = detectCleanupViolations(before, after);

  assert.deepEqual(violations, []);
});

test('detectCleanupViolations reports newly dirtied tracked files outside approved artifact directories', () => {
  const before = {
    tracked: new Set(['tests/evals/package.json']),
    untracked: new Set(),
  };
  const after = {
    tracked: new Set([
      'tests/evals/package.json',
      'tests/evals/fixtures/harness-smoke/catalog.json',
      'tests/evals/package-lock.json',
    ]),
    untracked: new Set(),
  };

  const violations = detectCleanupViolations(before, after);

  assert.deepEqual(violations, [
    'tests/evals/fixtures/harness-smoke/catalog.json',
    'tests/evals/package-lock.json',
  ]);
});

test('detectCleanupViolations reports new untracked files outside approved artifact directories', () => {
  const before = {
    tracked: new Set(),
    untracked: new Set(['tests/evals/results/logs/already-there.log']),
  };
  const after = {
    tracked: new Set(),
    untracked: new Set([
      'tests/evals/results/logs/already-there.log',
      'tests/evals/eval-dimcustomer.log',
      'tests/evals/tests/evals/eval_output.log',
    ]),
  };

  const violations = detectCleanupViolations(before, after);

  assert.deepEqual(violations, [
    'tests/evals/eval-dimcustomer.log',
    'tests/evals/tests/evals/eval_output.log',
  ]);
});

test('detectCleanupViolations reports changed pre-existing tracked files outside approved artifact directories', () => {
  const before = {
    tracked: new Set(['tests/evals/fixtures/scenario/catalog.json']),
    untracked: new Set(),
    trackedHashes: new Map([
      ['tests/evals/fixtures/scenario/catalog.json', 'before'],
    ]),
    untrackedHashes: new Map(),
  };
  const after = {
    tracked: new Set(['tests/evals/fixtures/scenario/catalog.json']),
    untracked: new Set(),
    trackedHashes: new Map([
      ['tests/evals/fixtures/scenario/catalog.json', 'after'],
    ]),
    untrackedHashes: new Map(),
  };

  const violations = detectCleanupViolations(before, after);

  assert.deepEqual(violations, ['tests/evals/fixtures/scenario/catalog.json']);
});

test('detectCleanupViolations reports changed pre-existing untracked files outside approved artifact directories', () => {
  const before = {
    tracked: new Set(),
    untracked: new Set(['tests/evals/manual-debug.json']),
    trackedHashes: new Map(),
    untrackedHashes: new Map([
      ['tests/evals/manual-debug.json', 'before'],
    ]),
  };
  const after = {
    tracked: new Set(),
    untracked: new Set(['tests/evals/manual-debug.json']),
    trackedHashes: new Map(),
    untrackedHashes: new Map([
      ['tests/evals/manual-debug.json', 'after'],
    ]),
  };

  const violations = detectCleanupViolations(before, after);

  assert.deepEqual(violations, ['tests/evals/manual-debug.json']);
});

test('detectCleanupViolations ignores changed pre-existing files under approved eval artifact directories', () => {
  const before = {
    tracked: new Set(),
    untracked: new Set(['tests/evals/output/runs/eval/debug/transcript.txt']),
    trackedHashes: new Map(),
    untrackedHashes: new Map([
      ['tests/evals/output/runs/eval/debug/transcript.txt', 'before'],
    ]),
  };
  const after = {
    tracked: new Set(),
    untracked: new Set(['tests/evals/output/runs/eval/debug/transcript.txt']),
    trackedHashes: new Map(),
    untrackedHashes: new Map([
      ['tests/evals/output/runs/eval/debug/transcript.txt', 'after'],
    ]),
  };

  const violations = detectCleanupViolations(before, after);

  assert.deepEqual(violations, []);
});

test('allowed artifact prefixes stay limited to the dedicated eval output roots', () => {
  assert.deepEqual(ALLOWED_ARTIFACT_PREFIXES, [
    'tests/evals/.cache/',
    'tests/evals/.tmp/',
    'tests/evals/output/',
    'tests/evals/results/',
  ]);
});

test('splitPromptfooInvocations preserves shared args and runs each config separately', () => {
  const invocations = splitPromptfooInvocations([
    'eval',
    '--no-cache',
    '--max-concurrency',
    '1',
    '--filter-pattern',
    '^\\[smoke\\]',
    '-c',
    'packages/harness-smoke/promptfooconfig.json',
    '-c',
    'packages/harness-smoke/promptfooconfig.json',
  ]);

  assert.deepEqual(invocations, [
    [
      'eval',
      '--no-cache',
      '--max-concurrency',
      '1',
      '--filter-pattern',
      '^\\[smoke\\]',
      '-c',
      'packages/harness-smoke/promptfooconfig.json',
    ],
    [
      'eval',
      '--no-cache',
      '--max-concurrency',
      '1',
      '--filter-pattern',
      '^\\[smoke\\]',
      '-c',
      'packages/harness-smoke/promptfooconfig.json',
    ],
  ]);
});

test('splitPromptfooInvocations keeps single-config and no-config argv unchanged', () => {
  assert.deepEqual(
    splitPromptfooInvocations([
      'view',
      '-c',
      'packages/harness-smoke/promptfooconfig.json',
    ]),
    [[
      'view',
      '-c',
      'packages/harness-smoke/promptfooconfig.json',
    ]],
  );

  assert.deepEqual(
    splitPromptfooInvocations(['list']),
    [['list']],
  );
});

test('splitPromptfooInvocations rejects a dangling -c flag', () => {
  assert.throws(
    () => splitPromptfooInvocations(['eval', '-c']),
    /Missing config path after -c/,
  );
});

test('materializeInvocation resolves suite-local package configs into tests/evals/.tmp', () => {
  const materialized = materializeInvocation(
    ['eval', '-c', 'packages/harness-smoke/promptfooconfig.json', '-c', 'packages/harness-smoke/promptfooconfig.json'],
    {
      writeResolvedConfig: (configPath) => `.tmp/resolved-configs/${configPath}`,
    },
  );

  assert.deepEqual(materialized, [
    'eval',
    '-c',
    '.tmp/resolved-configs/packages/harness-smoke/promptfooconfig.json',
    '-c',
    '.tmp/resolved-configs/packages/harness-smoke/promptfooconfig.json',
  ]);
});

test('shouldMaterializeConfig skips already resolved configs and non-config args', () => {
  assert.equal(shouldMaterializeConfig('.tmp/resolved-configs/packages/foo.yaml'), false);
  assert.equal(shouldMaterializeConfig('packages/foo.yaml'), true);
  assert.equal(shouldMaterializeConfig('packages/foo.json'), true);
  assert.equal(shouldMaterializeConfig('packages/harness-smoke/promptfooconfig.json'), true);
  assert.equal(shouldMaterializeConfig('--no-cache'), false);
});

test('applyDefaultEvalConcurrency runs four eval cases unless caller overrides concurrency', () => {
  assert.deepEqual(
    applyDefaultEvalConcurrency(['eval', '--no-cache', '-c', 'packages/foo.yaml']),
    ['eval', '--max-concurrency', '4', '--no-cache', '-c', 'packages/foo.yaml'],
  );

  assert.deepEqual(
    applyDefaultEvalConcurrency(['eval', '--max-concurrency', '2', '-c', 'packages/foo.yaml']),
    ['eval', '--max-concurrency', '2', '-c', 'packages/foo.yaml'],
  );

  assert.deepEqual(
    applyDefaultEvalConcurrency(['eval', '--max-concurrency=3', '-c', 'packages/foo.yaml']),
    ['eval', '--max-concurrency=3', '-c', 'packages/foo.yaml'],
  );

  assert.deepEqual(
    applyDefaultEvalConcurrency(['view']),
    ['view'],
  );
});

test('runPromptfooInvocation never passes unresolved package configs to promptfoo', () => {
  const spawns = [];
  const status = runPromptfooInvocation(
    ['eval', '-c', 'packages/harness-smoke/promptfooconfig.json'],
    {
      materializeInvocation: () => ['eval', '-c', '.tmp/resolved-configs/packages/harness-smoke/promptfooconfig.json'],
      spawnSync: (command, args) => {
        spawns.push([command, args]);
        return { status: 0 };
      },
    },
  );

  assert.equal(status, 0);
  assert.deepEqual(spawns, [[
    process.execPath,
    [
      require('node:path').join(
        require('node:path').resolve(__dirname, '..'),
        'node_modules',
        'promptfoo',
        'dist',
        'src',
        'entrypoint.js',
      ),
      'eval',
      '--max-concurrency',
      '4',
      '-c',
      '.tmp/resolved-configs/packages/harness-smoke/promptfooconfig.json',
    ],
  ]]);
});

test('main runs split promptfoo invocations sequentially and returns success when clean', () => {
  const invocations = [];
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
  ];

  const status = main(
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'a.yaml', '-c', 'b.yaml'],
    {
      collectGitSnapshot: () => snapshots.shift(),
      detectCleanupViolations: () => [],
      formatViolationMessage: () => 'unused',
      runPromptfooInvocation: (argv) => {
        invocations.push(argv);
        return 0;
      },
    },
  );

  assert.equal(status, 0);
  assert.deepEqual(invocations, [
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'a.yaml'],
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'b.yaml'],
  ]);
});

test('main continues split invocations after promptfoo eval failures and returns success', () => {
  const invocations = [];
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
  ];

  const status = main(
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'a.yaml', '-c', 'b.yaml', '-c', 'c.yaml'],
    {
      collectGitSnapshot: () => snapshots.shift(),
      detectCleanupViolations: () => [],
      formatViolationMessage: () => 'unused',
      runPromptfooInvocation: (argv) => {
        invocations.push(argv);
        return invocations.length === 2 ? PROMPTFOO_EVAL_RESULT_FAILURE_STATUS : 0;
      },
    },
  );

  assert.equal(status, 0);
  assert.deepEqual(invocations, [
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'a.yaml'],
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'b.yaml'],
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'c.yaml'],
  ]);
});

test('main continues split invocations after non-eval promptfoo process failures and returns failure', () => {
  const invocations = [];
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
  ];

  const status = main(
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'a.yaml', '-c', 'b.yaml', '-c', 'c.yaml'],
    {
      collectGitSnapshot: () => snapshots.shift(),
      detectCleanupViolations: () => [],
      formatViolationMessage: () => 'unused',
      runPromptfooInvocation: (argv) => {
        invocations.push(argv);
        return invocations.length === 2 ? 2 : 0;
      },
    },
  );

  assert.equal(status, 2);
  assert.deepEqual(invocations, [
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'a.yaml'],
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'b.yaml'],
    ['eval', '--filter-pattern', '^\\[smoke\\]', '-c', 'c.yaml'],
  ]);
});

test('main reports cleanup violations even after successful invocations', () => {
  const errors = [];
  const originalError = console.error;
  const restored = [];
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(['tests/evals/fixtures/x.json']), untracked: new Set() },
  ];

  console.error = (message) => {
    errors.push(message);
  };

  try {
    const status = main(
      ['eval', '-c', 'a.yaml', '-c', 'b.yaml'],
      {
        collectGitSnapshot: () => snapshots.shift(),
        detectCleanupViolations: () => ['tests/evals/fixtures/x.json'],
        formatViolationMessage: (paths) => `violations:${paths.join(',')}`,
        restoreCleanupViolations: (paths) => {
          restored.push(...paths);
        },
        runPromptfooInvocation: () => 0,
      },
    );

    assert.equal(status, 1);
    assert.deepEqual(errors, ['violations:tests/evals/fixtures/x.json']);
    assert.deepEqual(restored, ['tests/evals/fixtures/x.json']);
  } finally {
    console.error = originalError;
  }
});

test('restoreCleanupViolations removes untracked blockers before restoring tracked files', () => {
  const calls = [];

  restoreCleanupViolations(
    [
      'tests/evals/fixtures/blocker',
      'tests/evals/fixtures/blocker/catalog.json',
    ],
    {
      runGitLines: (args) => {
        calls.push(['git-lines', ...args]);
        return ['tests/evals/fixtures/blocker/catalog.json'];
      },
      execFileSync: (command, args) => {
        calls.push(['exec', command, ...args]);
      },
      repoRoot: 'REPO_ROOT',
      resolveRepoPath: (filePath) => filePath,
      rmSync: (filePath, options) => {
        calls.push(['rm', filePath, options]);
      },
    },
  );

  assert.deepEqual(calls, [
    [
      'git-lines',
      'ls-files',
      '--',
      'tests/evals/fixtures/blocker',
      'tests/evals/fixtures/blocker/catalog.json',
    ],
    [
      'rm',
      'tests/evals/fixtures/blocker',
      { force: true, recursive: true },
    ],
    [
      'exec',
      'git',
      '-C',
      'REPO_ROOT',
      'checkout',
      '--',
      'tests/evals/fixtures/blocker/catalog.json',
    ],
  ]);
});

test('main restores cleanup violations before returning a promptfoo failure', () => {
  const errors = [];
  const originalError = console.error;
  const restored = [];
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(['tests/evals/fixtures/dirty.json']), untracked: new Set() },
  ];

  console.error = (message) => {
    errors.push(message);
  };

  try {
    const status = main(
      ['eval', '-c', 'a.yaml'],
      {
        collectGitSnapshot: () => snapshots.shift(),
        detectCleanupViolations: () => ['tests/evals/fixtures/dirty.json'],
        formatViolationMessage: () => 'violation',
        restoreCleanupViolations: (paths) => {
          restored.push(...paths);
        },
        runPromptfooInvocation: () => 99,
      },
    );

    assert.equal(status, 1);
    assert.deepEqual(errors, ['violation']);
    assert.deepEqual(restored, ['tests/evals/fixtures/dirty.json']);
  } finally {
    console.error = originalError;
  }
});

test('main does not restore pre-existing dirty files that changed during promptfoo', () => {
  const errors = [];
  const originalError = console.error;
  const restored = [];
  const snapshots = [
    {
      tracked: new Set(['tests/evals/fixtures/already-dirty.json']),
      untracked: new Set(),
      trackedHashes: new Map([['tests/evals/fixtures/already-dirty.json', 'before']]),
      untrackedHashes: new Map(),
    },
    {
      tracked: new Set(['tests/evals/fixtures/already-dirty.json']),
      untracked: new Set(),
      trackedHashes: new Map([['tests/evals/fixtures/already-dirty.json', 'after']]),
      untrackedHashes: new Map(),
    },
  ];

  console.error = (message) => {
    errors.push(message);
  };

  try {
    const status = main(
      ['eval', '-c', 'a.yaml'],
      {
        collectGitSnapshot: () => snapshots.shift(),
        formatViolationMessage: (paths) => `violations:${paths.join(',')}`,
        restoreCleanupViolations: (paths) => {
          restored.push(...paths);
        },
        runPromptfooInvocation: () => 0,
      },
    );

    assert.equal(status, 1);
    assert.deepEqual(errors, ['violations:tests/evals/fixtures/already-dirty.json']);
    assert.deepEqual(restored, []);
  } finally {
    console.error = originalError;
  }
});

test('main checks cleanup violations after each split invocation', () => {
  const errors = [];
  const originalError = console.error;
  const invocations = [];
  const restored = [];
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(['tests/evals/fixtures/dirty.json']), untracked: new Set() },
  ];

  console.error = (message) => {
    errors.push(message);
  };

  try {
    const status = main(
      ['eval', '-c', 'a.yaml', '-c', 'b.yaml'],
      {
        collectGitSnapshot: () => snapshots.shift(),
        detectCleanupViolations: (before, after) => {
          if (before.tracked.size === 0 && after.tracked.size === 1) {
            return ['tests/evals/fixtures/dirty.json'];
          }
          return [];
        },
        formatViolationMessage: (paths) => `violations:${paths.join(',')}`,
        restoreCleanupViolations: (paths) => {
          restored.push(...paths);
        },
        runPromptfooInvocation: (argv) => {
          invocations.push(argv);
          return 0;
        },
      },
    );

    assert.equal(status, 1);
    assert.deepEqual(invocations, [['eval', '-c', 'a.yaml']]);
    assert.deepEqual(errors, ['violations:tests/evals/fixtures/dirty.json']);
    assert.deepEqual(restored, ['tests/evals/fixtures/dirty.json']);
  } finally {
    console.error = originalError;
  }
});

test('main still fails for dirty paths outside allowed roots after config materialization', () => {
  const errors = [];
  const originalError = console.error;
  const restored = [];
  const invocations = [];
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(['tests/evals/packages/harness-smoke/promptfooconfig.json']), untracked: new Set() },
  ];

  console.error = (message) => {
    errors.push(message);
  };

  try {
    const status = main(
      ['eval', '-c', 'packages/harness-smoke/promptfooconfig.json'],
      {
        collectGitSnapshot: () => snapshots.shift(),
        detectCleanupViolations: () => ['tests/evals/packages/harness-smoke/promptfooconfig.json'],
        formatViolationMessage: (paths) => `violations:${paths.join(',')}`,
        restoreCleanupViolations: (paths) => {
          restored.push(...paths);
        },
        runPromptfooInvocation: (argv) => {
          invocations.push(argv);
          return 0;
        },
      },
    );

    assert.equal(status, 1);
    assert.deepEqual(invocations, [['eval', '-c', 'packages/harness-smoke/promptfooconfig.json']]);
    assert.deepEqual(errors, ['violations:tests/evals/packages/harness-smoke/promptfooconfig.json']);
    assert.deepEqual(restored, ['tests/evals/packages/harness-smoke/promptfooconfig.json']);
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// E.24 — Workspace post-run assertion (spec §7.3)
// ---------------------------------------------------------------------------

// assertWorkspaceClean uses injectable deps so we can test without real filesystem.

test('assertWorkspaceClean: Case A — empty workspace dir returns 0', () => {
  const status = assertWorkspaceClean('test-run-A', {
    readdirSync: () => [],
    log: () => {},
    error: () => {},
  });
  assert.equal(status, 0);
});

test('assertWorkspaceClean: Case B — leftover file returns 1 with WORKSPACE_DIRTY message', () => {
  const errors = [];
  // Simulate a directory entry object with a .name property
  const fakeEntry = { name: 'leftover.txt' };
  const status = assertWorkspaceClean('test-run-B', {
    readdirSync: () => [fakeEntry],
    log: () => {},
    error: (msg) => errors.push(msg),
  });
  assert.equal(status, 1);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('WORKSPACE_DIRTY'), `expected WORKSPACE_DIRTY in: ${errors[0]}`);
  assert.ok(errors[0].includes('leftover.txt'), `expected filename in: ${errors[0]}`);
});

test('assertWorkspaceClean: Case C — AD_EVALS_KEEP_WORKSPACE=1 with leftovers returns 0', () => {
  const origEnv = process.env.AD_EVALS_KEEP_WORKSPACE;
  process.env.AD_EVALS_KEEP_WORKSPACE = '1';
  try {
    const logs = [];
    const fakeEntry = { name: 'leftover.txt' };
    const status = assertWorkspaceClean('test-run-C', {
      readdirSync: () => [fakeEntry],
      log: (msg) => logs.push(msg),
      error: () => {},
    });
    assert.equal(status, 0);
    assert.ok(logs.some((l) => l.includes('skipped')), `expected "skipped" in logs: ${logs}`);
  } finally {
    if (origEnv === undefined) {
      delete process.env.AD_EVALS_KEEP_WORKSPACE;
    } else {
      process.env.AD_EVALS_KEEP_WORKSPACE = origEnv;
    }
  }
});

test('assertWorkspaceClean: Case D — non-existent workspace dir returns 0', () => {
  const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
  const status = assertWorkspaceClean('test-run-D', {
    readdirSync: () => { throw enoent; },
    log: () => {},
    error: () => {},
  });
  assert.equal(status, 0);
});

test('assertWorkspaceClean: non-ENOENT error returns 1', () => {
  const other = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const status = assertWorkspaceClean('test-run-E', {
    readdirSync: () => { throw other; },
    log: () => {},
    error: () => {},
  });
  assert.equal(status, 1);
});

test('assertWorkspaceClean: empty runId skips assertion and returns 0', () => {
  const status = assertWorkspaceClean('', {
    readdirSync: () => { throw new Error('should not be called'); },
    log: () => {},
    error: () => {},
  });
  assert.equal(status, 0);
});

test('main passes assertWorkspaceClean result through on success exit', () => {
  const snapshots = [
    { tracked: new Set(), untracked: new Set() },
    { tracked: new Set(), untracked: new Set() },
  ];
  const wsResults = [1];  // first call returns dirty

  const status = main(
    ['eval', '-c', 'a.yaml'],
    {
      collectGitSnapshot: () => snapshots.shift(),
      detectCleanupViolations: () => [],
      formatViolationMessage: () => 'unused',
      runPromptfooInvocation: () => 0,
      assertWorkspaceClean: () => wsResults.shift() ?? 0,
    },
  );

  assert.equal(status, 1);
});
