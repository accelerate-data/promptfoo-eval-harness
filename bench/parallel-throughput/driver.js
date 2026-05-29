'use strict';

/**
 * Parallel-throughput micro-benchmark for the NDJSON adapter (spec §4.3 / §2.5).
 *
 * Spawns the mock adapter `config.iterations` times for each value of
 * `config.outer_concurrency_values`, using a p-limit gate to cap concurrent
 * spawns. Measures total wall-clock time per concurrency level and computes
 * speedup relative to concurrency=1.
 *
 * Soft assertion (Phase 03 gate):
 *   speedup at outer_concurrency=2 must be >= config/bench-budget.toml
 *   [throughput] min_speedup_at_2 (default 1.4×). The mock adapter does no
 *   I/O, so doubling concurrency should yield close to 2× speedup; anything
 *   below 1.4× indicates the OUTER limiter is serializing spawns or there is
 *   spawn-level contention.
 *
 * Exit codes:
 *   0 — all concurrency levels measured; speedup assertion passes (or BENCH_OVERRIDE_REASON set)
 *   1 — speedup at concurrency=2 below threshold
 *
 * Escape valve:
 *   BENCH_OVERRIDE_REASON=<reason>  — bypass soft assertion, exit 0 regardless.
 *   CI NEVER sets this variable.
 *
 * Usage:
 *   node bench/parallel-throughput/driver.js
 *   BENCH_OVERRIDE_REASON='slow machine' node bench/parallel-throughput/driver.js
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const pLimit = require('p-limit');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_PATH = path.join(REPO_ROOT, 'scripts', 'framework', 'providers', '_python_adapter.py');
const BUDGET_PATH = path.join(REPO_ROOT, 'config', 'bench-budget.toml');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const OVERRIDE_REASON = process.env.BENCH_OVERRIDE_REASON || '';

// ---------------------------------------------------------------------------
// Config / budget readers.
// ---------------------------------------------------------------------------
function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function readBudget() {
  const { parse } = require('smol-toml');
  const raw = fs.readFileSync(BUDGET_PATH, 'utf8');
  const cfg = parse(raw);
  return {
    min_speedup_at_2: cfg.throughput?.min_speedup_at_2 ?? 1.4,
  };
}

// ---------------------------------------------------------------------------
// Single call: spawn adapter, send init + one turn + finalize + shutdown.
// Returns total wall-clock ms for the call.
// ---------------------------------------------------------------------------
function runOnce() {
  return new Promise((resolve, reject) => {
    const pythonExe = process.env.PYTHON_EXEC || 'python3';
    const start = Date.now();

    const child = spawn(
      pythonExe,
      [ADAPTER_PATH, '--kind=mock'],
      {
        cwd: REPO_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENHANDS_SUPPRESS_BANNER: '1',
          PYTHONPATH: REPO_ROOT,
        },
      },
    );

    child.stderr.on('data', () => { /* ignore adapter logs */ });

    let buf = '';
    let msgQueue = [];
    let resolveNext = null;
    let settled = false;

    function settle(fn, val) {
      if (settled) return;
      settled = true;
      fn(val);
    }

    child.on('error', (e) => settle(reject, e));
    child.on('exit', (code) => {
      if (!settled) settle(reject, new Error(`unexpected exit code ${code}`));
    });

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (_) {
          settle(reject, new Error(`malformed NDJSON: ${line}`));
          return;
        }
        if (resolveNext) {
          const cb = resolveNext;
          resolveNext = null;
          cb(parsed);
        } else {
          msgQueue.push(parsed);
        }
      }
    });

    function recv() {
      return new Promise((res) => {
        if (msgQueue.length > 0) {
          res(msgQueue.shift());
        } else {
          resolveNext = res;
        }
      });
    }

    function send(msg) {
      return new Promise((res, rej) => {
        try {
          child.stdin.write(JSON.stringify(msg) + '\n', res);
        } catch (e) {
          rej(e);
        }
      });
    }

    async function run() {
      const initMsg = {
        type: 'init', id: 'tp-init',
        config: {
          provider_kind: 'mock', model: 'test', sdk_version: '0.0.0',
          workspace_root: '/tmp', tools: [], permissions: {},
          timeout_per_turn_s: 30, provider_label: 'tp', extra: {},
        },
      };
      await send(initMsg);
      const initResp = await recv();
      if (initResp.type === 'error') {
        throw new Error(`init error: ${JSON.stringify(initResp.error)}`);
      }
      const sid = initResp.session_id;

      await send({ type: 'turn', id: 'tp-turn', session_id: sid, message: 'bench' });
      await recv(); // turn_ack

      await send({ type: 'finalize', id: 'tp-final', session_id: sid });
      await recv(); // finalize_ack

      await send({ type: 'shutdown', id: 'tp-shutdown', session_id: sid });
      await recv(); // shutdown_ack

      child.stdin.end();
      return Date.now() - start;
    }

    run().then((ms) => settle(resolve, ms)).catch((e) => settle(reject, e));
  });
}

// ---------------------------------------------------------------------------
// Run `iterations` concurrent calls at `concurrency` limit. Returns total
// wall-clock ms.
// ---------------------------------------------------------------------------
async function runBatch(iterations, concurrency) {
  const limit = pLimit(concurrency);
  const start = Date.now();
  await Promise.all(
    Array.from({ length: iterations }, () => limit(() => runOnce())),
  );
  return Date.now() - start;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const config = readConfig();
  const budget = readBudget();
  const { iterations, outer_concurrency_values: concValues } = config;

  process.stderr.write(
    `[bench:throughput] iterations=${iterations} concurrency_values=${concValues.join(',')}\n`,
  );

  const results = [];

  for (const conc of concValues) {
    process.stderr.write(`  measuring concurrency=${conc}…\n`);
    const totalMs = await runBatch(iterations, conc);
    results.push({ concurrency: conc, total: totalMs });
    process.stderr.write(`    total=${totalMs}ms\n`);
  }

  // Compute speedups relative to concurrency=1 baseline
  const baseline = results.find((r) => r.concurrency === 1);
  if (!baseline) {
    process.stderr.write('[bench:throughput] ERROR: concurrency=1 not in config\n');
    process.exit(1);
  }

  for (const r of results) {
    r.speedup = baseline.total / r.total;
  }

  // Print summary table
  for (const r of results) {
    process.stdout.write(
      `outer_concurrency=${r.concurrency}  iterations=${iterations}  total=${r.total}  speedup=${r.speedup.toFixed(2)}\n`,
    );
  }

  // Soft assertion: speedup at concurrency=2
  const at2 = results.find((r) => r.concurrency === 2);
  if (!at2) {
    process.stderr.write('[bench:throughput] no concurrency=2 result — skipping speedup assertion\n');
    process.exit(0);
  }

  if (OVERRIDE_REASON) {
    process.stderr.write(
      `[bench-override] reason="${OVERRIDE_REASON}" speedup@2=${at2.speedup.toFixed(2)} threshold=${budget.min_speedup_at_2}\n`,
    );
    process.exit(0);
  }

  if (at2.speedup < budget.min_speedup_at_2) {
    process.stderr.write(
      `[bench:throughput] FAIL: speedup@2=${at2.speedup.toFixed(2)}x below threshold=${budget.min_speedup_at_2}x\n` +
      `  This signals the OUTER limiter may be broken or spawns are serializing.\n` +
      `  Investigate before phase 04 builds on the concurrency primitive.\n` +
      `  To bypass locally: BENCH_OVERRIDE_REASON='<reason>' node bench/parallel-throughput/driver.js\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `[bench:throughput] PASS: speedup@2=${at2.speedup.toFixed(2)}x >= threshold=${budget.min_speedup_at_2}x\n`,
  );
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[bench:throughput] fatal: ${e.message}\n`);
  process.exit(1);
});
