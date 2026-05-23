'use strict';

/**
 * Thin shim that wraps the harness bridge for the opencode-cli-compatibility
 * scenario. Adds a string `label` property to the returned provider object
 * so Promptfoo's telemetry path (`usesExampleProvider`) can call
 * `provider.label.toLowerCase()` without crashing.
 *
 * Promptfoo 0.121.11 accesses `provider.label` as a string in its
 * `usesExampleProvider` telemetry check, but our bridge exposes `label` as
 * a function (per the Provider interface). This shim bridges the gap until
 * the bridge adds a string label property.
 *
 * File ownership: tests/harness-scenarios/packages/opencode-cli-compatibility/
 * (phase 05 owns this directory).
 */

const path = require('node:path');
const makeBridge = require(path.resolve(__dirname, '../../../../scripts/framework/_node_bridge.js'));

module.exports = function makeShimBridge(options) {
  const provider = makeBridge(options);
  // Resolve label: prefer options.config.provider_label, then options.provider_label
  const labelStr = (options && (
    (options.config && options.config.provider_label) ||
    options.provider_label
  )) || 'opencode-cli';

  return {
    id: provider.id,
    label: labelStr,          // string property — satisfies Promptfoo telemetry
    callApi: provider.callApi,
  };
};
