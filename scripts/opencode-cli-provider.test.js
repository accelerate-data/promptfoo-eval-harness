const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const OpenCodeCliProvider = require('./framework/opencode-cli-provider');

test('OpenCodeCliProvider invokes opencode run with the configured eval agent', async () => {
  const previousStateHome = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  const calls = [];
  try {
    const provider = new OpenCodeCliProvider({
      config: {
        agent: 'eval_light',
        opencode_config: '/suite/opencode.json',
        project_dir: '/repo',
        format: 'default',
        log_level: 'ERROR',
      },
      runner: async (args, options) => {
        calls.push({ args, options });
        return 'status output';
      },
    });

    const result = await provider.callApi('run status');

    assert.deepEqual(result, { output: 'status output' });
    assert.deepEqual(calls[0].args, [
      'run',
      '--agent',
      'eval_light',
      '--dir',
      '/repo',
      '--format',
      'default',
      '--log-level',
      'ERROR',
      'run status',
    ]);
    assert.equal(calls[0].options.cwd, path.resolve(__dirname, '..'));
    assert.equal(calls[0].options.env.OPENCODE_CONFIG, '/suite/opencode.json');
    assert.match(calls[0].options.env.XDG_STATE_HOME, /\.tmp\/opencode-state$/);
  } finally {
    if (previousStateHome !== undefined) {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
  }
});

test('OpenCodeCliProvider preserves framework-exported OpenCode state', async () => {
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/repo/.git/ad-evals/opencode-state';
  try {
    const calls = [];
    const provider = new OpenCodeCliProvider({
      config: {
        agent: 'eval_light',
        opencode_config: '/suite/opencode.json',
        project_dir: '/repo',
        format: 'default',
        log_level: 'ERROR',
      },
      runner: async (args, options) => {
        calls.push({ args, options });
        return 'status output';
      },
    });

    await provider.callApi('run status');

    assert.equal(calls[0].options.env.XDG_STATE_HOME, '/repo/.git/ad-evals/opencode-state');
  } finally {
    if (previousStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousStateHome;
    }
  }
});

test('OpenCodeCliProvider includes --print-logs only when configured', async () => {
  const calls = [];
  const provider = new OpenCodeCliProvider({
    config: {
      agent: 'eval_standard',
      opencode_config: '/suite/opencode.json',
      project_dir: '/repo',
      format: 'json',
      log_level: 'DEBUG',
      print_logs: true,
    },
    runner: async (args, options) => {
      calls.push({ args, options });
      return 'status output';
    },
  });

  await provider.callApi('prompt');

  assert.deepEqual(calls[0].args, [
    'run',
    '--agent',
    'eval_standard',
    '--dir',
    '/repo',
    '--format',
    'json',
    '--log-level',
    'DEBUG',
    '--print-logs',
    'prompt',
  ]);
});

test('OpenCodeCliProvider retries empty CLI output when configured', async () => {
  let calls = 0;
  const provider = new OpenCodeCliProvider({
    config: {
      agent: 'eval_light',
      opencode_config: '/suite/opencode.json',
      project_dir: '/repo',
      format: 'default',
      log_level: 'ERROR',
      empty_output_retries: 1,
    },
    runner: async () => {
      calls += 1;
      return calls === 1 ? '   ' : 'usable output';
    },
  });

  const result = await provider.callApi('prompt');

  assert.deepEqual(result, { output: 'usable output' });
  assert.equal(calls, 2);
});

test('OpenCodeCliProvider reports empty output after configured retries', async () => {
  const provider = new OpenCodeCliProvider({
    config: {
      agent: 'eval_light',
      opencode_config: '/suite/opencode.json',
      project_dir: '/repo',
      format: 'default',
      log_level: 'ERROR',
      empty_output_retries: 1,
    },
    runner: async () => '',
  });

  const result = await provider.callApi('prompt');

  assert.deepEqual(result, {
    error: 'OpenCode CLI returned empty output after 2 attempt(s)',
  });
});

test('OpenCodeCliProvider validates required runtime config and retry count', async () => {
  const missingAgent = new OpenCodeCliProvider({
    config: {
      opencode_config: '/suite/opencode.json',
      project_dir: '/repo',
      format: 'default',
      log_level: 'ERROR',
    },
  });

  assert.deepEqual(await missingAgent.callApi('prompt'), {
    error: 'OpenCode CLI provider requires agent, opencode_config, project_dir, format, and log_level',
  });

  const invalidRetries = new OpenCodeCliProvider({
    config: {
      agent: 'eval_light',
      opencode_config: '/suite/opencode.json',
      project_dir: '/repo',
      format: 'default',
      log_level: 'ERROR',
      empty_output_retries: -1,
    },
    runner: async () => 'unused',
  });

  assert.deepEqual(await invalidRetries.callApi('prompt'), {
    error: 'OpenCode CLI provider requires empty_output_retries to be a non-negative integer',
  });
});
