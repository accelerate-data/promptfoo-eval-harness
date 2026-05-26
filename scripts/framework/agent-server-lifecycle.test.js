'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('node:net');
const childProcess = require('node:child_process');

const {
  allocateFreePort,
  waitForReady,
  buildChildEnv,
  startAgentServerDaemon,
  stopAgentServerDaemon,
  _resetForTest,
} = require('./agent-server-lifecycle');

function makeFakeChild({ pid = 12345 } = {}) {
  const ee = new EventEmitter();
  ee.pid = pid;
  ee.exitCode = null;
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.kill = function kill(sig) {
    if (this.exitCode !== null) return true;
    this.exitCode = sig === 'SIGKILL' ? 137 : 143;
    setImmediate(() => this.emit('exit', this.exitCode, sig));
    return true;
  };
  return ee;
}

// Build a processKill stub that also triggers child.emit('exit') so
// stopAgentServerDaemon doesn't wait 5s + 2s for the real subprocess to die.
function makeProcessKillStub(childRef, { record } = {}) {
  return function processKill(pid, sig) {
    if (record) record.push({ pid, sig });
    const child = childRef.current;
    if (child && Math.abs(pid) === child.pid && child.exitCode === null) {
      child.exitCode = sig === 'SIGKILL' ? 137 : 143;
      setImmediate(() => child.emit('exit', child.exitCode, sig));
    }
    return true;
  };
}

function makeReadyHttpGet() {
  return function httpGet(_url, cb) {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.resume = () => {};
    process.nextTick(() => cb(res));
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    return req;
  };
}

function makeRefusingHttpGet() {
  return function httpGet(_url, _cb) {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    process.nextTick(() => {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      req.emit('error', err);
    });
    return req;
  };
}

describe('agent-server-lifecycle', () => {
  beforeEach(() => {
    _resetForTest();
  });

  describe('allocateFreePort', () => {
    test('returns a numeric port > 1024 that is currently free', async () => {
      const port = await allocateFreePort();
      assert.strictEqual(typeof port, 'number');
      assert.ok(port > 1024, `expected port > 1024, got ${port}`);
      // Bind to it briefly to confirm availability.
      await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => srv.close(resolve));
      });
    });
  });

  describe('waitForReady', () => {
    test('rejects with timeout when httpGet always errors', async () => {
      const start = Date.now();
      await assert.rejects(
        waitForReady('http://127.0.0.1:1', 300, { httpGet: makeRefusingHttpGet() }),
        /timed out/,
      );
      assert.ok(Date.now() - start < 1_500, 'should reject within ~1.5s of timeoutMs=300');
    });

    test('resolves when httpGet returns 200', async () => {
      await waitForReady('http://127.0.0.1:1', 1_000, { httpGet: makeReadyHttpGet() });
    });
  });

  describe('buildChildEnv', () => {
    test('includes baseline keys + allowlisted keys + suppresses banner', () => {
      const prevOpenai = process.env.OPENAI_API_KEY;
      const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-fake';
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-fake';
      try {
        const env = buildChildEnv(['OPENAI_API_KEY']);
        assert.ok(env.PATH, 'must include PATH');
        assert.strictEqual(env.OPENAI_API_KEY, 'sk-test-fake', 'allowlisted key forwarded');
        assert.ok(!('AWS_SECRET_ACCESS_KEY' in env), 'non-allowlisted secret stripped');
        assert.strictEqual(env.OPENHANDS_SUPPRESS_BANNER, '1', 'banner suppressed');
      } finally {
        if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevOpenai;
        if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
        else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
      }
    });
  });

  describe('startAgentServerDaemon (DI)', () => {
    test('spawns uvx with exact argv and returns handle', async () => {
      const spawnCalls = [];
      const childRef = { current: null };
      const fakeSpawn = (cmd, argv, opts) => {
        spawnCalls.push({ cmd, argv, opts });
        childRef.current = makeFakeChild({ pid: 22222 });
        return childRef.current;
      };
      const handle = await startAgentServerDaemon({
        rootDir: process.cwd(),
        evalRoot: process.cwd(),
        logger: null,
        _internals: {
          spawn: fakeSpawn,
          allocateFreePort: async () => 54321,
          processKill: makeProcessKillStub(childRef),
          httpGet: makeReadyHttpGet(),
        },
      });
      try {
        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].cmd, 'uvx');
        assert.deepStrictEqual(spawnCalls[0].argv, [
          '--with', 'libtmux',
          // sdk pin must be present and must be listed before the
          // agent-server `--from`, otherwise uvx may install a later sdk
          // from the agent-server wheel's open-ended dep (root cause of
          // the 2026-05-26 ImportError on AgentSettings).
          '--with', 'openhands-sdk==1.23.1',
          '--with', 'openhands-tools==1.23.1',
          '--from', 'openhands-agent-server==1.23.1',
          'agent-server', '--host', '127.0.0.1', '--port', '54321',
        ]);
        assert.strictEqual(spawnCalls[0].opts.detached, true);
        assert.deepStrictEqual(spawnCalls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
        assert.strictEqual(handle.url, 'http://127.0.0.1:54321');
        assert.strictEqual(handle.port, 54321);
        assert.strictEqual(handle.pid, 22222);
      } finally {
        await stopAgentServerDaemon(handle);
      }
    });

    test('stopAgentServerDaemon calls processKill with -pid SIGTERM and clears handle', async () => {
      const killCalls = [];
      const childRef = { current: null };
      const fakeSpawn = () => { childRef.current = makeFakeChild({ pid: 33333 }); return childRef.current; };
      const handle = await startAgentServerDaemon({
        rootDir: process.cwd(),
        evalRoot: process.cwd(),
        logger: null,
        _internals: {
          spawn: fakeSpawn,
          allocateFreePort: async () => 60000,
          processKill: makeProcessKillStub(childRef, { record: killCalls }),
          httpGet: makeReadyHttpGet(),
        },
      });
      await stopAgentServerDaemon(handle);
      const sigterm = killCalls.find((c) => c.sig === 'SIGTERM');
      assert.ok(sigterm, 'SIGTERM must be sent');
      assert.strictEqual(sigterm.pid, -33333, 'kill must target negative pid (process group)');
    });

    test('second start while one is active throws synchronously', async () => {
      const childRef = { current: null };
      const handle = await startAgentServerDaemon({
        rootDir: process.cwd(),
        evalRoot: process.cwd(),
        logger: null,
        _internals: {
          spawn: () => { childRef.current = makeFakeChild({ pid: 44444 }); return childRef.current; },
          allocateFreePort: async () => 60001,
          processKill: makeProcessKillStub(childRef),
          httpGet: makeReadyHttpGet(),
        },
      });
      try {
        await assert.rejects(
          startAgentServerDaemon({
            rootDir: process.cwd(),
            evalRoot: process.cwd(),
            logger: null,
            _internals: {
              spawn: () => makeFakeChild({ pid: 44445 }),
              allocateFreePort: async () => 60002,
              processKill: () => true,
              httpGet: makeReadyHttpGet(),
            },
          }),
          /already running/,
        );
      } finally {
        await stopAgentServerDaemon(handle);
      }
    });

    test('EADDRINUSE on first port → retries on second port', async () => {
      const portsAllocated = [];
      let portCallCount = 0;
      const fakeAlloc = async () => {
        portCallCount += 1;
        const p = portCallCount === 1 ? 5000 : 5001;
        portsAllocated.push(p);
        return p;
      };
      const childRef = { current: null };
      const fakeKill = makeProcessKillStub(childRef);
      const httpGet = (url, cb) => {
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.destroy = () => {};
        if (url.includes(':5000')) {
          process.nextTick(() => {
            const err = new Error('EADDRINUSE');
            err.code = 'EADDRINUSE';
            req.emit('error', err);
          });
        } else if (url.includes(':5001')) {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.resume = () => {};
          process.nextTick(() => cb(res));
        }
        return req;
      };
      const spawnCalls = [];
      const fakeSpawn = (_cmd, argv) => {
        spawnCalls.push(argv);
        const port = argv[argv.length - 1];
        childRef.current = makeFakeChild({ pid: 50000 + Number(port) });
        return childRef.current;
      };
      const handle = await startAgentServerDaemon({
        rootDir: process.cwd(),
        evalRoot: process.cwd(),
        logger: null,
        _internals: {
          spawn: fakeSpawn,
          allocateFreePort: fakeAlloc,
          processKill: fakeKill,
          httpGet,
        },
      });
      try {
        assert.strictEqual(portCallCount, 2, 'allocateFreePort must be called twice');
        assert.deepStrictEqual(portsAllocated, [5000, 5001]);
        assert.ok(handle.url.endsWith(':5001'), `handle.url should end with :5001, got ${handle.url}`);
      } finally {
        await stopAgentServerDaemon(handle);
      }
    });
  });

  // Gated E2E: only runs when OPENHANDS_E2E=1 and uvx is on PATH.
  describe('agent-server-lifecycle (E2E, gated)', () => {
    const e2eEnabled = process.env.OPENHANDS_E2E === '1';
    test('real daemon start + /health 200 + stop leaves no live process', { skip: !e2eEnabled }, async () => {
      const handle = await startAgentServerDaemon({
        rootDir: process.cwd(),
        evalRoot: process.cwd(),
        logger: console,
      });
      try {
        const probe = await fetch(`${handle.url}/health`).catch((e) => ({ ok: false, e }));
        assert.ok(probe.ok || probe.status === 200, 'health must be 200');
      } finally {
        const pid = handle.pid;
        await stopAgentServerDaemon(handle);
        const ps = childProcess.spawnSync('ps', ['-o', 'pid=', '-p', String(pid)], { encoding: 'utf8' });
        assert.strictEqual(ps.stdout.trim(), '', `pid ${pid} should be gone`);
      }
    });
  });
});
