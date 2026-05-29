'use strict';

/**
 * Cold-spawn cost benchmark for the Python NDJSON adapter (spec §2.5 / §8.5).
 *
 * Spawns the mock provider through _node_bridge.js 20 times in series.
 * Each iteration measures from bridge callApi start to init_ack receipt
 * (cold spawn cost — a fresh OS process each time).
 *
 * Budget configuration: config/bench-budget.toml [spawn_cost] p95_ms.
 * Mock adapter (no SDK import) should be well within 300 ms p95 on any
 * developer laptop or CI runner.
 *
 * Exit codes:
 *   0 — p95 within budget (or BENCH_OVERRIDE_REASON set)
 *   1 — p95 exceeds budget (or a spawn error occurred)
 *
 * Escape valve:
 *   BENCH_OVERRIDE_REASON=<reason>  — bypass gate, exit 0 regardless.
 *   CI NEVER sets this variable. Use only when diagnosing locally on a
 *   resource-constrained machine and you know the breach is environmental.
 *   PRs touching latency-sensitive paths must NOT use this escape valve.
 *
 * Usage:
 *   node bench/spawn-cost.js
 *   BENCH_OVERRIDE_REASON='slow CI runner' node bench/spawn-cost.js
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const REPO_ROOT = path.resolve(__dirname, '..');
const ADAPTER_PATH = path.join(REPO_ROOT, 'scripts', 'framework', 'providers', '_python_adapter.py');
const BUDGET_PATH = path.join(REPO_ROOT, 'config', 'bench-budget.toml');

const ITERATIONS = 20;
const OVERRIDE_REASON = process.env.BENCH_OVERRIDE_REASON || '';

// ---------------------------------------------------------------------------
// TOML reader — uses smol-toml (already in dependencies).
// ---------------------------------------------------------------------------
function readBudget() {
  const { parse } = require('smol-toml');
  const raw = fs.readFileSync(BUDGET_PATH, 'utf8');
  const cfg = parse(raw);
  return {
    p95_ms: cfg.spawn_cost?.p95_ms ?? 300,
    turn_p95_ms: cfg.spawn_cost?.turn_p95_ms ?? 100,
  };
}

// ---------------------------------------------------------------------------
// Percentile helper — simple sort + index (no extra library).
// ---------------------------------------------------------------------------
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// IPC helper: send one JSON message to a child process stdin and read back
// one NDJSON response line from stdout.
// ---------------------------------------------------------------------------
function ipcSend(child, msg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`IPC timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    function settle(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    }

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) return;
        try {
          settle(resolve, JSON.parse(line));
        } catch (e) {
          settle(reject, new Error(`malformed NDJSON: ${line}`));
        }
      }
    });

    child.on('error', (e) => settle(reject, e));
    child.on('exit', (code) => {
      if (!settled) settle(reject, new Error(`adapter exited with code ${code} before response`));
    });

    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      settle(reject, e);
    }
  });
}

// ---------------------------------------------------------------------------
// Single spawn measurement: spawn the Python adapter directly (mirrors what
// _node_bridge.js does for openhands_sdk), send init, record init_ack latency.
//
// We spawn Python directly (no uv --with SDK) since the mock provider has no
// SDK import — this tests the cold-spawn cost without SDK overhead.
// ---------------------------------------------------------------------------
function measureSpawnCost() {
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

    child.stderr.on('data', () => { /* adapter logs — ignore in bench */ });
    child.on('error', reject);

    const initMsg = {
      type: 'init',
      id: 'bench-init',
      config: {
        provider_kind: 'mock',
        model: 'test-model',
        sdk_version: '0.0.0',
        workspace_root: '/tmp',
        tools: [],
        permissions: {},
        timeout_per_turn_s: 30,
        provider_label: 'bench',
        extra: {},
      },
    };

    ipcSend(child, initMsg, 10000)
      .then((resp) => {
        const latency = Date.now() - start;
        if (resp.type === 'error') {
          reject(new Error(`adapter error: ${JSON.stringify(resp.error)}`));
        } else {
          resolve(latency);
        }
        // Shut down cleanly
        try {
          child.stdin.write(JSON.stringify({ type: 'shutdown', id: 'bench-shutdown', session_id: resp.session_id || '' }) + '\n');
          child.stdin.end();
        } catch (_) { /* best-effort */ }
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const budget = readBudget();
  const measurements = [];

  process.stderr.write(`[bench:spawn-cost] running ${ITERATIONS} iterations (mock adapter, no SDK import)\n`);

  for (let i = 0; i < ITERATIONS; i++) {
    try {
      const ms = await measureSpawnCost();
      measurements.push(ms);
      process.stderr.write(`  iter ${String(i + 1).padStart(2)}: ${ms}ms\n`);
    } catch (e) {
      process.stderr.write(`  iter ${String(i + 1).padStart(2)}: ERROR — ${e.message}\n`);
      process.stdout.write(
        `spawn_cost: n=${ITERATIONS} p50=ERR p95=ERR p99=ERR budget=${budget.p95_ms} verdict=FAIL\n`,
      );
      process.exit(1);
    }
  }

  const sorted = [...measurements].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  const exceeded = p95 > budget.p95_ms;

  if (OVERRIDE_REASON) {
    process.stderr.write(
      `[bench-override] reason="${OVERRIDE_REASON}" p95=${p95} budget=${budget.p95_ms}\n`,
    );
    process.stdout.write(
      `spawn_cost: n=${ITERATIONS} p50=${p50} p95=${p95} p99=${p99} budget=${budget.p95_ms} verdict=OVERRIDE\n`,
    );
    process.exit(0);
  }

  const verdict = exceeded ? 'FAIL' : 'PASS';
  process.stdout.write(
    `spawn_cost: n=${ITERATIONS} p50=${p50} p95=${p95} p99=${p99} budget=${budget.p95_ms} verdict=${verdict}\n`,
  );

  if (exceeded) {
    process.stderr.write(
      `[bench:spawn-cost] FAIL: p95=${p95}ms exceeds budget=${budget.p95_ms}ms\n` +
      `  To bypass locally: BENCH_OVERRIDE_REASON='<reason>' node bench/spawn-cost.js\n` +
      `  CI never sets BENCH_OVERRIDE_REASON — a failing budget MUST fail the build.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`[bench:spawn-cost] PASS: p95=${p95}ms within budget=${budget.p95_ms}ms\n`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[bench:spawn-cost] fatal: ${e.message}\n`);
  process.exit(1);
});
