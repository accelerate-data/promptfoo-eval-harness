'use strict';

/**
 * Minimal in-proc mock provider for Phase 9.5 Layer 2 round-trip tests
 * (VD-2174-12).
 *
 * Exports:
 *   - create()                  — happy-path provider; turn() echoes input
 *   - createWithTurnError()     — variant whose turn() returns a populated
 *                                  error object (validates bridge errorReturn)
 *
 * Lifecycle shape matches what `_node_bridge.js#_dispatchInproc` drives:
 *   { init(cfg), turn(session, message), finalize(session), shutdown(session) }
 *
 * Methods are intentionally `async` to prove the bridge handles Promise-returning
 * lifecycle exports (Claude Agent SDK / OpenCode SDK / Codex SDK pattern).
 */

async function create() {
  return {
    async init(cfg) {
      return { count: 0, cfg, turns: [] };
    },
    async turn(session, message) {
      session.count += 1;
      session.turns.push(message);
      return {
        output: `echo: ${message}`,
        tool_calls: [
          { name: 'mock_inproc_tool', arguments: { turn_index: session.count - 1 }, result_truncated: `r${session.count - 1}` },
        ],
      };
    },
    async finalize(session) {
      return {
        metadata: {
          cost_usd: 0,
          tokens: { input: 2 * session.count, output: 3 * session.count },
          transcript_summary: `mock inproc session — ${session.count} turns`,
        },
      };
    },
    async shutdown(session) {
      if (session) session.closed = true;
    },
  };
}

async function createWithTurnError() {
  return {
    async init(cfg) {
      return { cfg };
    },
    async turn(_session, message) {
      return {
        output: '',
        error: { code: 'TEST_FAIL', message: `forced inproc turn failure for ${JSON.stringify(message)}`, retryable: false },
      };
    },
    async finalize(_session) {
      return { metadata: {} };
    },
    async shutdown(_session) {},
  };
}

module.exports = { create, createWithTurnError };
