'use strict';

/**
 * Phase 11 — child-process runner exercising the opencode_sdk cleanup
 * contract (v1.3.3). Invoked by `cleanup.test.js` via:
 *
 *   node --import .../tests/_mock_opencode_sdk/register.mjs _cleanup_runner.cjs <mode>
 *
 * Modes:
 *   - sync   : init → shutdown three times in a row. Asserts the active-server
 *              registry empties after each shutdown. Prints a single JSON line
 *              with the per-cycle counts so the parent can assert.
 *   - drain  : init three times WITHOUT shutdown, then call `_drainActiveServers()`
 *              and report registry size before/after. Verifies the orphan
 *              code path closes servers when no per-case finalize ran.
 *   - sigterm: init once, write `READY <pid>` to stdout (line-flushed), then
 *              hang forever. Parent sends SIGTERM and inspects the cleanup
 *              log file the mock SDK writes to via OPENCODE_SDK_CLEANUP_LOG.
 *
 * The mock @opencode-ai/sdk is loaded via the ESM loader hook in
 * tests/_mock_opencode_sdk/register.mjs, so this runner does NOT need the
 * real SDK installed.
 */

const provider = require('./provider');

async function _initOnce(label) {
  const factory = provider.create();
  const session = await factory.init({
    provider_kind: 'opencode_sdk',
    provider_label: label,
    model: 'anthropic/claude-sonnet-4-6',
    extra: { opencode_agent: 'build' },
    case_id: label,
  });
  return { factory, session };
}

async function runSync() {
  const counts = [];
  for (let i = 0; i < 3; i++) {
    const { factory, session } = await _initOnce(`sync-${i}`);
    counts.push({ after_init: provider._activeServerCount() });
    await factory.shutdown(session);
    counts[i].after_shutdown = provider._activeServerCount();
  }
  process.stdout.write(JSON.stringify({ mode: 'sync', counts }) + '\n');
}

async function runDrain() {
  for (let i = 0; i < 3; i++) {
    await _initOnce(`drain-${i}`);
    // Intentionally do NOT shutdown — these are orphans the drain must clean.
  }
  const beforeDrain = provider._activeServerCount();
  provider._drainActiveServers();
  const afterDrain = provider._activeServerCount();
  process.stdout.write(JSON.stringify({ mode: 'drain', beforeDrain, afterDrain }) + '\n');
}

async function runSigterm() {
  await _initOnce('sigterm-0');
  // Tell parent we are live so it can signal us deterministically.
  process.stdout.write(`READY ${process.pid}\n`);
  // Hang forever — parent kills us with SIGTERM.
  setInterval(() => {}, 1 << 30);
}

async function main() {
  const mode = process.argv[2] || 'sync';
  if (mode === 'sync') return runSync();
  if (mode === 'drain') return runDrain();
  if (mode === 'sigterm') return runSigterm();
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`cleanup runner crashed: ${(err && err.stack) || err}\n`);
  process.exit(2);
});
