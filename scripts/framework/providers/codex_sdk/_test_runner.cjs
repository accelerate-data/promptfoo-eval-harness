'use strict';

/**
 * Phase 12 — child-process test runner for codex_sdk provider.
 *
 * Invoked by ../../_node_bridge.codex_sdk.test.js via:
 *
 *   node --import .../tests/_mock_codex_sdk/register.mjs _test_runner.cjs
 *
 * Reads a JSON request from stdin describing the case (turns, model,
 * sandbox_mode, reasoning_effort, case_id), drives a real
 * HarnessBridgeProvider against the codex_sdk kind, and writes the result
 * JSON to stdout as a single line.
 *
 * KIND_REGISTRY.codex_sdk is wired in `_node_bridge.js` (Step 2); the
 * --import register.mjs installs an ESM loader hook so the provider's
 * `await import('@openai/codex-sdk')` resolves to the mock module under
 * tests/_mock_codex_sdk/sdk.mjs without the real SDK installed. (v1.3.1
 * — the real `@openai/codex-sdk` is ESM-only.)
 */

const fs = require('node:fs');

const makeBridge = require('../../_node_bridge');
const HarnessBridgeProvider = makeBridge._HarnessBridgeProvider;

async function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const req = raw.trim() ? JSON.parse(raw) : {};
  const turns = Array.isArray(req.turns) ? req.turns : ['hello'];
  const cfg = {
    provider_kind: 'codex_sdk',
    provider_label: req.label || 'codex-sdk-mock',
    model: req.model || 'gpt-4o',
    extra: {
      sandbox_mode: req.sandbox_mode || 'workspace-write',
      reasoning_effort: req.reasoning_effort || 'medium',
    },
    case_id: req.case_id || `runner-${process.pid}`,
  };
  if (makeBridge._clearInprocCache) makeBridge._clearInprocCache();
  const bridge = new HarnessBridgeProvider({ config: cfg });
  const out = await bridge.callApi('ignored', { vars: { turns: JSON.stringify(turns) } });
  process.stdout.write(JSON.stringify(out) + '\n');
}

main().catch((err) => {
  process.stderr.write(`runner crashed: ${(err && err.stack) || err}\n`);
  process.exit(2);
});
