'use strict';

/**
 * doctor-install-providers.test.js — L2 tests for `ad-evals doctor --install-providers` (G.32).
 *
 * Uses a mock `uv` shell script on PATH to capture the exact argv the doctor
 * sends, without touching the real uv or making any network calls.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const AD_EVALS_BIN = path.join(HARNESS_ROOT, 'bin', 'ad-evals.js');
const SDK_PINS_PATH = path.join(HARNESS_ROOT, 'config', 'sdk-pins.toml');

// Expected exact argv components (spec §6.3).
const EXPECTED_UV_ARGS = [
  'run',
  '--python', '3.12',
  '--with', 'openhands-sdk==1.22.1',
  'python', '-c', 'import openhands.sdk',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Write a mock `uv` shell script to `dir` that:
 *   - Records its argv to `<dir>/uv-argv.json`
 *   - Exits with `exitCode`
 *   - Optionally records `uv cache dir` output when that sub-command is given
 */
function writeMockUv(dir, { exitCode = 0, cacheDir = null } = {}) {
  const uvPath = path.join(dir, 'uv');
  const argvFile = path.join(dir, 'uv-argv.json');
  const cacheDirStr = cacheDir ? cacheDir : dir;

  const script = [
    '#!/usr/bin/env bash',
    `ARGV_FILE="${argvFile}"`,
    // Write JSON array of all args using node (always available in this harness).
    `node -e "process.stdout.write(JSON.stringify(process.argv.slice(1))+'\\n')" -- "$@" > "$ARGV_FILE"`,
    // Handle `uv cache dir` sub-command.
    'if [ "$1" = "cache" ] && [ "$2" = "dir" ]; then',
    `  echo "${cacheDirStr}"`,
    '  exit 0',
    'fi',
    `exit ${exitCode}`,
  ].join('\n');

  fs.writeFileSync(uvPath, script, { mode: 0o755 });
  return { uvPath, argvFile };
}

/**
 * Run `node bin/ad-evals.js doctor --install-providers` with `mockBinDir`
 * prepended to PATH.  Returns { status, stdout, stderr }.
 */
function runDoctor(mockBinDir, extraEnv = {}) {
  const env = {
    ...process.env,
    PATH: `${mockBinDir}:${process.env.PATH}`,
    AD_EVALS_ROOT: path.join(HARNESS_ROOT, 'tests', 'evals'),
    ...extraEnv,
  };
  const result = spawnSync(process.execPath, [AD_EVALS_BIN, 'doctor', '--install-providers'], {
    encoding: 'utf8',
    env,
    cwd: HARNESS_ROOT,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Read pinned version from sdk-pins.toml to keep test in sync with config
// ---------------------------------------------------------------------------

let PINNED_VERSION = '1.22.1'; // fallback
let PINNED_PYTHON = '3.12';

try {
  const { parse } = require('smol-toml');
  const pins = parse(fs.readFileSync(SDK_PINS_PATH, 'utf8'));
  PINNED_VERSION = pins.openhands_sdk.version;
  // Extract min python from range e.g. ">=3.12,<3.14"
  const m = String(pins.openhands_sdk.python || '').match(/>=\s*(\d+\.\d+)/);
  if (m) PINNED_PYTHON = m[1];
} catch {
  /* use fallbacks */
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('doctor --install-providers exact argv (G.32)', () => {
  let tmpDir;
  let argvFile;

  before(() => {
    tmpDir = makeTmpDir();
    const mock = writeMockUv(tmpDir, { exitCode: 0 });
    argvFile = mock.argvFile;
  });

  after(() => rmDir(tmpDir));

  test('sends EXACT uv argv: run --python 3.12 --with openhands-sdk==<ver> python -c import openhands.sdk', () => {
    const result = runDoctor(tmpDir);
    assert.equal(result.status, 0, `doctor exited ${result.status}:\n${result.stderr}`);

    assert.ok(fs.existsSync(argvFile), 'mock uv should have written argv file');
    const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));

    const expected = [
      'run',
      '--python', PINNED_PYTHON,
      '--with', `openhands-sdk==${PINNED_VERSION}`,
      'python', '-c', 'import openhands.sdk',
    ];
    assert.deepEqual(argv, expected,
      `uv argv mismatch.\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(argv)}`);
  });

  test('reports success message with pinned version', () => {
    const result = runDoctor(tmpDir);
    assert.ok(
      result.stdout.includes(`openhands-sdk==${PINNED_VERSION}`),
      `stdout should mention pinned version; got:\n${result.stdout}`,
    );
  });
});

describe('doctor --install-providers AD_EVALS_OFFLINE=1 (G.32)', () => {
  let tmpDir;

  after(() => rmDir(tmpDir));

  test('skips uv spawn when AD_EVALS_OFFLINE=1 and cache hit found', () => {
    tmpDir = makeTmpDir();
    // Put a fake wheel file in the cache dir so _globUvCache finds it.
    const fakeWheelDir = path.join(tmpDir, 'wheels');
    fs.mkdirSync(fakeWheelDir);
    fs.writeFileSync(
      path.join(fakeWheelDir, `openhands_sdk-${PINNED_VERSION}-py3-none-any.whl`),
      'fake',
    );

    // Mock uv that returns our tmp dir as cache dir but records if run sub-cmd is called.
    const argvFile = path.join(tmpDir, 'uv-argv.json');
    const uvScript = [
      '#!/usr/bin/env bash',
      `ARGV_FILE="${argvFile}"`,
      `node -e "process.stdout.write(JSON.stringify(process.argv.slice(1))+'\\n')" -- "$@" > "$ARGV_FILE"`,
      'if [ "$1" = "cache" ] && [ "$2" = "dir" ]; then',
      `  echo "${tmpDir}"`,
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n');
    const uvPath = path.join(tmpDir, 'uv');
    fs.writeFileSync(uvPath, uvScript, { mode: 0o755 });

    const result = runDoctor(tmpDir, { AD_EVALS_OFFLINE: '1' });

    // Should exit 0 (cache hit).
    assert.equal(result.status, 0, `doctor exited ${result.status}:\n${result.stderr}`);

    // The final argv written should be from 'uv cache dir', NOT 'uv run'.
    if (fs.existsSync(argvFile)) {
      const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
      assert.ok(
        !argv.includes('run'),
        `uv run should NOT be called in offline mode; got argv: ${JSON.stringify(argv)}`,
      );
    }

    assert.ok(
      result.stdout.includes('found in uv cache') || result.stdout.includes('openhands-sdk'),
      `stdout should confirm cache hit; got:\n${result.stdout}`,
    );
  });

  test('exits non-zero with MISSING_CACHE when AD_EVALS_OFFLINE=1 and cache empty', () => {
    const emptyTmp = makeTmpDir();
    try {
      // Mock uv returns an empty cache dir.
      const uvScript = [
        '#!/usr/bin/env bash',
        'if [ "$1" = "cache" ] && [ "$2" = "dir" ]; then',
        `  echo "${emptyTmp}"`,
        '  exit 0',
        'fi',
        'exit 0',
      ].join('\n');
      const uvPath = path.join(emptyTmp, 'uv');
      fs.writeFileSync(uvPath, uvScript, { mode: 0o755 });

      const result = runDoctor(emptyTmp, { AD_EVALS_OFFLINE: '1' });

      assert.notEqual(result.status, 0, 'should exit non-zero when cache is empty in offline mode');
      assert.ok(
        result.stderr.includes('MISSING_CACHE'),
        `stderr should say MISSING_CACHE; got:\n${result.stderr}`,
      );
    } finally {
      rmDir(emptyTmp);
    }
  });
});

describe('doctor --install-providers uv exit-code propagation (G.32)', () => {
  let tmpDir;

  before(() => { tmpDir = makeTmpDir(); });
  after(() => rmDir(tmpDir));

  test('exits non-zero when mock uv returns non-zero', () => {
    writeMockUv(tmpDir, { exitCode: 42 });
    const result = runDoctor(tmpDir);
    assert.notEqual(result.status, 0, 'doctor should propagate uv non-zero exit');
  });
});
