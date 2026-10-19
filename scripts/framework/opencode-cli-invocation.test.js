'use strict';

/**
 * Layer 2 unit tests for opencode-cli-invocation.js (VD-7010).
 *
 * The argv builder is the whole point of this module: v1 must stay
 * byte-for-byte the locked §7.4 shape, and v2 must drop `--dir`, add
 * `--standalone`, and lowercase `--log-level`. Everything here is
 * deterministic — the generation probe is always injected, so no test ever
 * spawns a real OpenCode binary.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  GENERATION_ENV_VAR,
  splitCommand,
  normalizeMajor,
  parseMajor,
  resolveMajor,
  buildRunArgs,
  resolveSpawnCwd,
  _resetMajorCache,
} = require('./opencode-cli-invocation');

const PROJECT_DIR = '/repo';
const EVAL_ROOT = '/repo/tests/evals';

/** A probe that returns a fixed version string and counts calls. */
function makeProbe(output, { throws = false } = {}) {
  const probe = async () => {
    probe.calls += 1;
    if (throws) throw new Error('probe exploded');
    return output;
  };
  probe.calls = 0;
  return probe;
}

describe('splitCommand', () => {
  test('tokenizes bare commands and quoted args', () => {
    assert.deepEqual(splitCommand('opencode'), ['opencode']);
    assert.deepEqual(splitCommand('npx opencode --foo'), ['npx', 'opencode', '--foo']);
    assert.deepEqual(splitCommand('"path with spaces" arg'), ['path with spaces', 'arg']);
    assert.deepEqual(splitCommand("  opencode   "), ['opencode']);
    assert.deepEqual(splitCommand(''), []);
  });

  test('rejects an unclosed quote', () => {
    assert.throws(() => splitCommand('"unclosed'), /Unclosed quote/);
  });
});

describe('normalizeMajor', () => {
  test('maps v2-or-later onto the v2 shape and v1 onto v1', () => {
    assert.equal(normalizeMajor('1'), 1);
    assert.equal(normalizeMajor('2'), 2);
    assert.equal(normalizeMajor(2), 2);
    // A future major keeps the v2 argv shape: the split is a generation
    // boundary, and a v3 is far likelier to speak v2 than to restore --dir.
    assert.equal(normalizeMajor('3'), 2);
  });

  test('returns null for anything unparseable', () => {
    for (const value of [undefined, null, '', '   ', 'abc', '0', '-1', '1.5', NaN]) {
      assert.equal(normalizeMajor(value), null, `expected null for ${String(value)}`);
    }
  });
});

describe('parseMajor', () => {
  test('reads the major from observed version output', () => {
    assert.equal(parseMajor('opencode v2.0.32'), 2);
    assert.equal(parseMajor('opencode v1.2.3'), 1);
    assert.equal(parseMajor('2.0.32'), 2);
    assert.equal(parseMajor('opencode 2.1'), 2);
  });

  test('returns null for unrecognisable output', () => {
    for (const value of ['', null, undefined, 'opencode', '[mock] --version']) {
      assert.equal(parseMajor(value), null, `expected null for ${String(value)}`);
    }
  });
});

describe('resolveMajor', () => {
  test('the env override wins and never probes', async () => {
    const probe = makeProbe('opencode v2.0.32');
    const major = await resolveMajor({
      runnerCommand: 'override-wins',
      env: { [GENERATION_ENV_VAR]: '1' },
      probe,
    });
    assert.equal(major, 1);
    assert.equal(probe.calls, 0, 'an explicit pin must not spawn a probe');
  });

  test('probes once and memoizes per runner command', async () => {
    _resetMajorCache();
    const probe = makeProbe('opencode v2.0.32');
    const first = await resolveMajor({ runnerCommand: 'memo-runner', env: {}, probe });
    const second = await resolveMajor({ runnerCommand: 'memo-runner', env: {}, probe });
    assert.equal(first, 2);
    assert.equal(second, 2);
    assert.equal(probe.calls, 1, 'the generation is a process-lifetime fact, not a per-turn one');
  });

  test('falls back to v1 when the probe fails or is unreadable', async () => {
    _resetMajorCache();
    const throwing = makeProbe('', { throws: true });
    assert.equal(await resolveMajor({ runnerCommand: 'probe-throws', env: {}, probe: throwing }), 1);

    _resetMajorCache();
    const junk = makeProbe('[mock] --version');
    assert.equal(await resolveMajor({ runnerCommand: 'probe-junk', env: {}, probe: junk }), 1);
  });

  test('an unparseable override falls through to the probe', async () => {
    _resetMajorCache();
    const probe = makeProbe('opencode v2.0.32');
    const major = await resolveMajor({
      runnerCommand: 'bad-override',
      env: { [GENERATION_ENV_VAR]: 'not-a-number' },
      probe,
    });
    assert.equal(major, 2);
    assert.equal(probe.calls, 1);
  });
});

describe('buildRunArgs', () => {
  test('v1 emits the locked §7.4 argv byte-for-byte', () => {
    assert.deepEqual(
      buildRunArgs({
        major: 1,
        agent: 'eval_standard',
        format: 'json',
        logLevel: 'WARN',
        projectDir: PROJECT_DIR,
      }),
      ['run', '--agent', 'eval_standard', '--dir', PROJECT_DIR, '--format', 'json', '--log-level', 'WARN'],
    );
  });

  test('v1 keeps --model before --print-logs, and the log level verbatim', () => {
    assert.deepEqual(
      buildRunArgs({
        major: 1,
        agent: 'eval_light',
        format: 'default',
        logLevel: 'ERROR',
        projectDir: PROJECT_DIR,
        modelOverride: 'opencode-go/qwen3.5-plus',
        printLogs: true,
      }),
      [
        'run', '--agent', 'eval_light', '--dir', PROJECT_DIR,
        '--format', 'default', '--log-level', 'ERROR',
        '--model', 'opencode-go/qwen3.5-plus', '--print-logs',
      ],
    );
  });

  test('v2 drops --dir, adds --standalone, and lowercases the log level', () => {
    assert.deepEqual(
      buildRunArgs({
        major: 2,
        agent: 'eval_standard',
        format: 'json',
        logLevel: 'ERROR',
        projectDir: PROJECT_DIR,
      }),
      ['run', '--standalone', '--agent', 'eval_standard', '--format', 'json', '--log-level', 'error'],
    );
  });

  test('v2 keeps the model override and print-logs', () => {
    const args = buildRunArgs({
      major: 2,
      agent: 'eval_high',
      format: 'default',
      logLevel: 'WARN',
      projectDir: PROJECT_DIR,
      modelOverride: '  opencode-go/minimax-m2.7  ',
      printLogs: true,
    });
    assert.deepEqual(args, [
      'run', '--standalone', '--agent', 'eval_high',
      '--format', 'default', '--log-level', 'warn',
      '--model', 'opencode-go/minimax-m2.7', '--print-logs',
    ]);
    assert.ok(!args.includes('--dir'), 'v2 has no --dir');
  });

  test('omits --format / --log-level when the runtime field is absent', () => {
    assert.deepEqual(
      buildRunArgs({ major: 1, agent: 'a', projectDir: PROJECT_DIR }),
      ['run', '--agent', 'a', '--dir', PROJECT_DIR],
    );
    assert.deepEqual(
      buildRunArgs({ major: 2, agent: 'a', projectDir: PROJECT_DIR }),
      ['run', '--standalone', '--agent', 'a'],
    );
  });

  test('an unset, empty, or whitespace model override adds no --model', () => {
    for (const modelOverride of [undefined, null, '', '   ']) {
      const args = buildRunArgs({
        major: 2, agent: 'a', format: 'json', logLevel: 'warn', projectDir: PROJECT_DIR, modelOverride,
      });
      assert.ok(!args.includes('--model'), `no --model for ${JSON.stringify(modelOverride)}`);
    }
  });
});

describe('resolveSpawnCwd', () => {
  test('v1 runs from the eval root (--dir carries the project)', () => {
    assert.equal(resolveSpawnCwd({ major: 1, evalRoot: EVAL_ROOT, projectDir: PROJECT_DIR }), EVAL_ROOT);
  });

  test('v2 runs from project_dir (there is no --dir to carry it)', () => {
    assert.equal(resolveSpawnCwd({ major: 2, evalRoot: EVAL_ROOT, projectDir: PROJECT_DIR }), PROJECT_DIR);
  });
});
