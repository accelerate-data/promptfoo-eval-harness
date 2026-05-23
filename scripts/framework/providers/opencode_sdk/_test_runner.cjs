'use strict';

/**
 * Phase 11 — child-process test runner for opencode_sdk provider.
 *
 * Invoked by ../../_node_bridge.opencode_sdk.test.js via:
 *
 *   node --import .../tests/_mock_opencode_sdk/register.mjs _test_runner.cjs
 *
 * Reads a JSON request from stdin describing the case (turns, model, agent),
 * drives a real HarnessBridgeProvider against the opencode_sdk kind, and
 * writes the result JSON to stdout as a single line.
 *
 * The bridge's `_dispatchInproc` requires `KIND_REGISTRY.opencode_sdk` to be
 * populated; the runner registers it defensively so the test file can be
 * exercised before Step 2 lands the permanent entry in `_node_bridge.js`.
 */

const path = require('node:path');
const fs = require('node:fs');

const makeBridge = require('../../_node_bridge');
const HarnessBridgeProvider = makeBridge._HarnessBridgeProvider;
const KIND_REGISTRY = makeBridge._KIND_REGISTRY;

if (!KIND_REGISTRY.opencode_sdk) {
  KIND_REGISTRY.opencode_sdk = {
    mode: 'inproc',
    module: path.resolve(__dirname, 'provider.js'),
  };
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const req = raw.trim() ? JSON.parse(raw) : {};
  const turns = Array.isArray(req.turns) ? req.turns : ['hello'];
  const cfg = {
    provider_kind: 'opencode_sdk',
    provider_label: req.label || 'opencode-sdk-mock',
    model: req.model || 'anthropic/claude-sonnet-4-6',
    extra: {
      opencode_agent: req.agent || 'build',
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
