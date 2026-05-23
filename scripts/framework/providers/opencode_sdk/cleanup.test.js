'use strict';

/**
 * Phase 11 — v1.3.3 cleanup contract tests for the opencode_sdk provider.
 *
 * Asserts the three invariants of the cleanup contract:
 *
 *   1. Per-case `shutdown()` removes the server from the active registry.
 *   2. `_drainActiveServers()` closes orphaned servers (no per-case finalize ran).
 *   3. SIGTERM to the parent process closes every active server before exit,
 *      verified via a cleanup log file the mock SDK appends to.
 *
 * Each test spawns a child Node process with `--import` pointing at the mock
 * loader hook (same pattern as `_node_bridge.opencode_sdk.test.js`) so the
 * provider's `await import('@opencode-ai/sdk')` resolves to the mock. The
 * cleanup runner exposes three modes — sync, drain, sigterm — for the three
 * tests below.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const REGISTER = path.resolve(__dirname, '..', '..', '..', '..', 'tests', '_mock_opencode_sdk', 'register.mjs');
const RUNNER = path.resolve(__dirname, '_cleanup_runner.cjs');

function _mkLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sdk-cleanup-'));
  return path.join(dir, 'cleanup.log');
}

function _readLog(p) {
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

function _waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (predicate()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timeout after ${timeoutMs}ms`));
      }
    }, 25);
  });
}

test('opencode_sdk cleanup: per-case shutdown empties active-server registry', () => {
  const result = spawnSync(process.execPath, ['--import', REGISTER, RUNNER, 'sync'], {
    encoding: 'utf8',
    env: { ...process.env, OPENCODE_SDK_MOCK_SCENARIO: 'happy' },
  });
  if (result.status !== 0) {
    throw new Error(`sync runner exited ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const payload = JSON.parse(lines[lines.length - 1]);
  assert.equal(payload.mode, 'sync');
  assert.equal(payload.counts.length, 3);
  for (const c of payload.counts) {
    assert.equal(c.after_init, 1, 'registry should hold exactly one server after init');
    assert.equal(c.after_shutdown, 0, 'shutdown must deregister the server');
  }
});

test('opencode_sdk cleanup: _drainActiveServers() closes orphan servers and clears registry', () => {
  const logPath = _mkLog();
  const result = spawnSync(process.execPath, ['--import', REGISTER, RUNNER, 'drain'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCODE_SDK_MOCK_SCENARIO: 'happy',
      OPENCODE_SDK_CLEANUP_LOG: logPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(`drain runner exited ${result.status}\nstderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  }
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  const payload = JSON.parse(lines[lines.length - 1]);
  assert.equal(payload.mode, 'drain');
  assert.equal(payload.beforeDrain, 3, 'three orphans before drain');
  assert.equal(payload.afterDrain, 0, 'drain must close all orphans');
  const log = _readLog(logPath);
  const creates = (log.match(/server\.create/g) || []).length;
  const closes = (log.match(/server\.close/g) || []).length;
  assert.equal(creates, 3, `expected 3 create events, got ${creates} in:\n${log}`);
  assert.equal(closes, 3, `expected 3 close events, got ${closes} in:\n${log}`);
});

test('opencode_sdk cleanup: SIGTERM drains active servers before exit', async () => {
  const logPath = _mkLog();
  const child = spawn(process.execPath, ['--import', REGISTER, RUNNER, 'sigterm'], {
    env: {
      ...process.env,
      OPENCODE_SDK_MOCK_SCENARIO: 'happy',
      OPENCODE_SDK_CLEANUP_LOG: logPath,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b.toString(); });
  child.stderr.on('data', (b) => { stderr += b.toString(); });

  // Wait for READY signal that init() finished and the server is registered.
  try {
    await _waitFor(() => /^READY \d+/m.test(stdout), 10_000);
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    throw new Error(`child never signaled READY\nstderr:\n${stderr}\nstdout:\n${stdout}`);
  }

  // Snapshot — confirm at least one create event hit the log before signaling.
  const preCreates = (_readLog(logPath).match(/server\.create/g) || []).length;
  assert.equal(preCreates, 1, `expected 1 create event before SIGTERM, got ${preCreates}`);

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const { code, signal } = await exited;

  // Re-raised signal exits with the signal name (code=null on POSIX) — accept
  // either form so this test is robust on platforms that surface SIGTERM as
  // exit code 143 instead.
  if (signal == null) {
    assert.ok(code === 143 || code === 0, `unexpected exit code ${code} (signal=${signal})`);
  } else {
    assert.equal(signal, 'SIGTERM');
  }

  const log = _readLog(logPath);
  const closes = (log.match(/server\.close/g) || []).length;
  assert.equal(closes, 1, `expected exactly 1 close after SIGTERM, got ${closes} in:\n${log}`);
});
