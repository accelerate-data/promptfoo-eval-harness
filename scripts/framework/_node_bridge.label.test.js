'use strict';

/**
 * Regression test for the bridge `label` shape bug (phase 05 finding):
 * Promptfoo 0.121.x calls provider.label.toLowerCase() expecting a string.
 * The bridge previously exposed label as a function, causing a TypeError.
 *
 * This test documents the fix: label MUST be a plain string property.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const makeBridge = require('./_node_bridge');

test('bridge label is a string, not a function', () => {
  const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'my-label' } });
  assert.strictEqual(typeof provider.label, 'string', 'provider.label must be a string');
});

test('bridge label.toLowerCase() does not throw', () => {
  const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'My-Label' } });
  assert.doesNotThrow(() => {
    const lower = provider.label.toLowerCase();
    assert.strictEqual(lower, 'my-label');
  }, 'provider.label.toLowerCase() must not throw');
});

test('bridge label reflects provider_label from config', () => {
  const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'opencode-cli/claude-sonnet-4-6' } });
  assert.strictEqual(provider.label, 'opencode-cli/claude-sonnet-4-6');
});

test('bridge label falls back to "unknown" when provider_label is absent', () => {
  const provider = makeBridge({ config: { provider_kind: 'opencode_cli' } });
  assert.strictEqual(provider.label, 'unknown');
});

test('bridge label supports Promptfoo usesExampleProvider access pattern', () => {
  // Simulate what Promptfoo's usesExampleProvider does internally.
  const provider = makeBridge({ config: { provider_kind: 'opencode_cli', provider_label: 'OpenCode-CLI' } });
  // This is what Promptfoo 0.121.x does — must not throw.
  const result = provider.label.toLowerCase().includes('opencode');
  assert.strictEqual(result, true);
});
