'use strict';

// Lifecycle for the openhands-agent-server daemon.
//
// Public API:
//   startAgentServerDaemon({ rootDir, evalRoot, logger, _internals? }) → Promise<handle>
//   stopAgentServerDaemon(handle) → Promise<void>
//   allocateFreePort() → Promise<number>
//   waitForReady(url, timeoutMs, { httpGet? }) → Promise<void>
//
// The CLI (bin/ad-evals.js) calls startAgentServerDaemon() before invoking
// promptfoo, exports OPENHANDS_SERVER_URL = handle.url into the promptfoo
// subprocess env, and calls stopAgentServerDaemon() in a finally block.
// _node_bridge.js is intentionally NOT involved — the bridge's
// {output,error,metadata} contract is incompatible with a lifecycle handle.
//
// `_internals` is a test-only DI seam. Production callers omit it.

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const childProcess = require('node:child_process');
const { PassThrough } = require('node:stream');

const { loadSdkPins } = require('./sdk-pins');

const RING_BUFFER_CAP_BYTES = 100 * 1024;
const LOG_TAIL_BYTES = 8 * 1024;
const STDERR_TAIL_IN_ERROR_BYTES = 2 * 1024;
const READINESS_POLL_INTERVAL_MS = 250;
const STOP_GRACE_MS = 5_000;

const ACTIVE_HANDLES = new Set();
let SIGNALS_INSTALLED = false;

const _defaultInternals = {
  spawn: childProcess.spawn,
  allocateFreePort,
  processKill: process.kill.bind(process),
  httpGet: http.get,
};

async function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function _isEAddrInUse(err) {
  if (!err) return false;
  if (err.code === 'EADDRINUSE') return true;
  const msg = String(err.message || err);
  return msg.includes('EADDRINUSE') || msg.includes('Address already in use');
}

async function waitForReady(url, timeoutMs, { httpGet = http.get } = {}) {
  const deadline = Date.now() + timeoutMs;
  const probeUrl = `${url.replace(/\/$/, '')}/health`;
  let lastErr = null;

  while (Date.now() < deadline) {
    const result = await _probeOnce(httpGet, probeUrl);
    if (result.ok) return;
    lastErr = result.err;
    if (_isEAddrInUse(lastErr)) {
      const e = new Error(`agent-server readiness failed: EADDRINUSE on ${probeUrl}`);
      e.code = 'EADDRINUSE';
      throw e;
    }
    await _sleep(READINESS_POLL_INTERVAL_MS);
  }
  const err = new Error(
    `agent-server readiness timed out after ${timeoutMs}ms at ${probeUrl}`
    + (lastErr ? ` (last error: ${lastErr.message || lastErr})` : ''),
  );
  err.code = 'READINESS_TIMEOUT';
  throw err;
}

function _probeOnce(httpGet, probeUrl) {
  return new Promise((resolve) => {
    let req;
    try {
      req = httpGet(probeUrl, (res) => {
        res.resume();
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok });
      });
    } catch (err) {
      resolve({ ok: false, err });
      return;
    }
    req.on('error', (err) => resolve({ ok: false, err }));
    req.setTimeout?.(READINESS_POLL_INTERVAL_MS, () => {
      try { req.destroy(); } catch (_) { /* ignore */ }
      resolve({ ok: false, err: new Error('probe timeout') });
    });
  });
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function buildChildEnv(allowlist) {
  const env = {};
  const baseline = ['PATH', 'HOME', 'TMPDIR', 'LANG'];
  for (const key of [...baseline, ...allowlist]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  env.OPENHANDS_SUPPRESS_BANNER = '1';
  return env;
}

function _attachRingBuffer(child) {
  const buf = { stdout: '', stderr: '' };
  const collect = (stream, key) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf[key] += chunk;
      if (buf[key].length > RING_BUFFER_CAP_BYTES) {
        buf[key] = buf[key].slice(buf[key].length - RING_BUFFER_CAP_BYTES);
      }
    });
  };
  collect(child.stdout, 'stdout');
  collect(child.stderr, 'stderr');
  return buf;
}

function _flushLogTail(handle, evalRoot) {
  if (!handle || !handle.logs || !evalRoot) return;
  try {
    const dir = path.join(evalRoot, '.eval-run');
    fs.mkdirSync(dir, { recursive: true });
    const stdoutTail = handle.logs.stdout.slice(-LOG_TAIL_BYTES);
    const stderrTail = handle.logs.stderr.slice(-LOG_TAIL_BYTES);
    const body = [
      `# agent-server lifecycle log (tail ${LOG_TAIL_BYTES} bytes each)`,
      `# pid=${handle.pid} url=${handle.url} timestamp=${new Date().toISOString()}`,
      '## stdout',
      stdoutTail,
      '## stderr',
      stderrTail,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'agent-server.log'), body, 'utf8');
  } catch (_) { /* best effort */ }
}

function _installSignalsOnce() {
  if (SIGNALS_INSTALLED) return;
  SIGNALS_INSTALLED = true;
  process.on('exit', () => {
    for (const h of ACTIVE_HANDLES) {
      try { (h._I || _defaultInternals).processKill(-h.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
    }
  });
  const reRaise = (signal, code) => {
    for (const h of ACTIVE_HANDLES) {
      try { (h._I || _defaultInternals).processKill(-h.pid, 'SIGTERM'); } catch (_) { /* ignore */ }
    }
    try { process.kill(process.pid, signal); }
    catch (_) { process.exit(code); }
  };
  process.once('SIGINT', () => reRaise('SIGINT', 130));
  process.once('SIGTERM', () => reRaise('SIGTERM', 143));
  process.once('uncaughtException', (err) => {
    for (const h of ACTIVE_HANDLES) {
      try { (h._I || _defaultInternals).processKill(-h.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
    }
    // eslint-disable-next-line no-console
    console.error('[agent-server] uncaughtException, drained active daemons:', err && err.stack || err);
    process.exit(1);
  });
}

async function _waitForExit(child, timeoutMs) {
  if (child.exitCode !== null && child.exitCode !== undefined) return true;
  return new Promise((resolve) => {
    let settled = false;
    const onExit = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
    child.once('exit', onExit);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs).unref?.();
  });
}

async function stopAgentServerDaemon(handle) {
  if (!handle) return;
  const I = handle._I || _defaultInternals;
  if (!handle.child || handle.child.exitCode !== null) {
    ACTIVE_HANDLES.delete(handle);
    return;
  }
  try { I.processKill(-handle.pid, 'SIGTERM'); } catch (_) { /* already gone */ }
  const exited = await _waitForExit(handle.child, STOP_GRACE_MS);
  if (!exited) {
    try { I.processKill(-handle.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
    await _waitForExit(handle.child, 2_000);
  }
  if (handle.evalRoot) _flushLogTail(handle, handle.evalRoot);
  ACTIVE_HANDLES.delete(handle);
}

async function startAgentServerDaemon({ rootDir, evalRoot, logger, _internals } = {}) {
  if (ACTIVE_HANDLES.size > 0) {
    throw new Error('agent-server: already running (single-daemon-per-run)');
  }
  const I = { ..._defaultInternals, ...(_internals || {}) };
  const pins = loadSdkPins().openhands_agent_server;
  const env = buildChildEnv(pins.env_allowlist || []);

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const port = await I.allocateFreePort();
    const argv = [
      '--with', 'libtmux',
      '--with', `openhands-tools==${pins.tools_version}`,
      '--from', `openhands-agent-server==${pins.version}`,
      'agent-server', '--host', '127.0.0.1', '--port', String(port),
    ];
    if (logger && typeof logger.info === 'function') {
      logger.info(`[agent-server] spawning uvx ${argv.join(' ')}`);
    }
    const child = I.spawn('uvx', argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env,
      cwd: rootDir,
    });
    if (!child.stdout) child.stdout = new PassThrough();
    if (!child.stderr) child.stderr = new PassThrough();
    const logs = _attachRingBuffer(child);
    _installSignalsOnce();
    const url = `http://127.0.0.1:${port}`;
    const handle = {
      url,
      port,
      pid: child.pid,
      child,
      logs,
      evalRoot,
      _I: I,
      shutdown: () => stopAgentServerDaemon(handle),
    };
    ACTIVE_HANDLES.add(handle);
    try {
      await waitForReady(url, pins.startup_timeout_ms || 30_000, { httpGet: I.httpGet });
      return handle;
    } catch (err) {
      lastError = err;
      ACTIVE_HANDLES.delete(handle);
      try { I.processKill(-child.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
      if (_isEAddrInUse(err) && attempt === 1) continue;
      const stderrTail = (logs.stderr || '').slice(-STDERR_TAIL_IN_ERROR_BYTES);
      const enriched = new Error(
        `agent-server failed to start: ${err.message}`
        + (stderrTail ? `\n--- stderr tail ---\n${stderrTail}` : ''),
      );
      enriched.code = err.code || 'AGENT_SERVER_START_FAILED';
      throw enriched;
    }
  }
  const e = new Error(`agent-server: 2 port allocation attempts failed (last: ${lastError && lastError.message})`);
  e.code = 'EADDRINUSE_EXHAUSTED';
  throw e;
}

function _resetForTest() {
  ACTIVE_HANDLES.clear();
  SIGNALS_INSTALLED = false;
}

module.exports = {
  startAgentServerDaemon,
  stopAgentServerDaemon,
  allocateFreePort,
  waitForReady,
  buildChildEnv,
  _resetForTest,
};
