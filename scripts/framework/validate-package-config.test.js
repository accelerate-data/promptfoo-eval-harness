'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validate } = require('./validate-package-config');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures');

function loadFixture(name) {
  return require(path.join(FIXTURES_DIR, name));
}

// KIND_REGISTRY mirrored from _node_bridge.js (live at v1.3.0).
// claude_agent_sdk added in Phase 10 / v1.1.0; opencode_sdk added in Phase 11
// / v1.2.0; codex_sdk added in Phase 12 / v1.3.0. RESERVED_KINDS is now empty.
const KIND_REGISTRY = {
  opencode_cli: { mode: 'inproc' },
  openhands_sdk: { mode: 'subprocess' },
  claude_agent_sdk: { mode: 'subprocess' },
  opencode_sdk: { mode: 'inproc' },
  codex_sdk: { mode: 'inproc' },
};

// ---------------------------------------------------------------------------
// Helper: assert one error matches a path + message fragment
// ---------------------------------------------------------------------------
function assertError(errors, partialPath, messageFragment) {
  const match = errors.find(
    (e) => e.path.includes(partialPath) && e.message.includes(messageFragment),
  );
  if (!match) {
    const summary = errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    assert.fail(
      `Expected error with path containing "${partialPath}" and message containing "${messageFragment}".\n` +
      `Actual errors:\n${summary}`,
    );
  }
}

// ---------------------------------------------------------------------------
// PASS cases
// ---------------------------------------------------------------------------
describe('validate — pass cases', () => {
  test('v0-normalized single-provider config passes', () => {
    const raw = loadFixture('v0-legacy-tier.json');
    // parseTierConfig gives us v1-normalized; simulate by building from fixture
    const config = {
      version: 'v1-normalized',
      tiers: {
        light: { providers: [{ provider_kind: 'opencode_cli', label: 'opencode-haiku', model: null }] },
        standard: { providers: [{ provider_kind: 'opencode_cli', label: 'opencode-sonnet', model: null }] },
        high: { providers: [{ provider_kind: 'opencode_cli', label: 'opencode-sonnet-high', model: null }] },
        x_high: { providers: [{ provider_kind: 'opencode_cli', label: 'opencode-opus', model: null }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, `Expected ok:true, got errors: ${JSON.stringify(result.errors)}`);
  });

  test('v1 single-provider (opencode_cli) passes', () => {
    const config = {
      version: 'v1',
      tiers: {
        standard: {
          providers: [
            { provider_kind: 'opencode_cli', model: 'anthropic/claude-sonnet-4-6', label: 'oc-sonnet' },
          ],
        },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, JSON.stringify(result.errors));
  });

  test('v1 multi-provider (opencode_cli + openhands_sdk) passes', () => {
    const raw = loadFixture('v1-multi-provider-tier.json');
    const result = validate(raw, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, JSON.stringify(result.errors));
  });

  test('config without tiers passes', () => {
    const result = validate({}, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok);
  });
});

// ---------------------------------------------------------------------------
// FAIL — provider_kind rules
// ---------------------------------------------------------------------------
describe('validate — provider_kind failures', () => {
  test('unknown kind "made_up_sdk" → error on provider_kind path', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'made_up_sdk', model: 'some-model' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok, 'Expected ok:false');
    assertError(result.errors, 'providers[0].provider_kind', 'not registered');
  });

  test('claude_agent_sdk (live since v1.1.0) with model → passes', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'claude_agent_sdk', model: 'anthropic/claude-sonnet-4-6' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, `Expected ok:true, got: ${JSON.stringify(result.errors)}`);
  });

  test('opencode_sdk (live since v1.2.0) with model → passes', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'opencode_sdk', model: 'anthropic/claude-sonnet-4-6' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, `Expected ok:true, got: ${JSON.stringify(result.errors)}`);
  });

  test('codex_sdk (live since v1.3.0) with model → passes', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'codex_sdk', model: 'gpt-4o' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, `Expected ok:true, got: ${JSON.stringify(result.errors)}`);
  });

  test('SDK kind (openhands_sdk) without model → error on model path', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'openhands_sdk' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'providers[0].model', 'requires a non-empty model field');
  });

  test('SDK kind (openhands_sdk) with empty model string → error', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'openhands_sdk', model: '' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'providers[0].model', 'requires a non-empty model field');
  });

  test('missing provider_kind → error', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ model: 'anthropic/claude-sonnet-4-6' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'providers[0].provider_kind', 'required');
  });
});

// ---------------------------------------------------------------------------
// FAIL — vars.turns rules
// ---------------------------------------------------------------------------
describe('validate — vars.turns failures', () => {
  function configWithTurns(turns, providerKind = 'opencode_cli') {
    return {
      version: 'v1',
      tiers: {
        low: {
          providers: [{ provider_kind: providerKind, model: providerKind === 'openhands_sdk' ? 'some-model' : null }],
          tests: [{ vars: { turns } }],
        },
      },
    };
  }

  test('vars.turns = [] → error (empty array)', () => {
    const result = validate(configWithTurns([]), { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'vars', 'must not be empty');
  });

  test('vars.turns = [undefined] → error (undefined element)', () => {
    const result = validate(configWithTurns([undefined]), { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'vars', 'non-empty string');
  });

  test('vars.turns = ["", "foo"] → error (empty string element)', () => {
    const result = validate(configWithTurns(['', 'foo']), { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'vars', 'non-empty string');
  });

  test('vars.turns = null → error', () => {
    const result = validate(configWithTurns(null), { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'vars', 'non-empty array');
  });

  test('opencode_cli with vars.turns.length === 2 → error (spec §3.1)', () => {
    const result = validate(configWithTurns(['turn one', 'turn two'], 'opencode_cli'), { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    assertError(result.errors, 'vars', 'not supported by opencode_cli');
  });

  test('openhands_sdk with vars.turns.length === 2 → ok (multi-turn allowed)', () => {
    const result = validate(configWithTurns(['turn one', 'turn two'], 'openhands_sdk'), { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, `Expected ok:true, got: ${JSON.stringify(result.errors)}`);
  });

  test('opencode_cli with vars.turns = ["single turn"] → ok', () => {
    const result = validate(configWithTurns(['single turn'], 'opencode_cli'), { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, JSON.stringify(result.errors));
  });
});

// ---------------------------------------------------------------------------
// Error shape
// ---------------------------------------------------------------------------
describe('validate — error object shape', () => {
  test('errors have path, expected, received, message fields', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'made_up_sdk', model: 'x' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    for (const e of result.errors) {
      assert.ok('path' in e, 'error must have path');
      assert.ok('expected' in e, 'error must have expected');
      assert.ok('received' in e, 'error must have received');
      assert.ok('message' in e, 'error must have message');
    }
  });

  test('error path uses YAML-style notation', () => {
    const config = {
      version: 'v1',
      tiers: {
        low: { providers: [{ provider_kind: 'made_up_sdk' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(!result.ok);
    const e = result.errors[0];
    assert.ok(e.path.includes('['), `path should use bracket notation, got: ${e.path}`);
  });
});

// ---------------------------------------------------------------------------
// Phase 05 — openhands_agent_server (wrapper kind via extraKinds + adapter file)
// ---------------------------------------------------------------------------
describe('validate — openhands_agent_server (Phase 05)', () => {
  function makeEvalRoot(adapter, { filename = 'openhands.json' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase05-validate-'));
    const body = adapter === null ? {} : { adapter };
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(body, null, 2));
    return dir;
  }

  const FULL_ADAPTER = {
    agent_id: 'eval-agent',
    agent_entrypoint_file: 'agents/eval.py',
    agent_semantics: 'react-loop',
    eval_mode_preamble: 'You are running in eval mode. Respond with plain text only.',
  };

  test('t1 — valid agent_server tier with adapter file passes', () => {
    const evalRoot = makeEvalRoot(FULL_ADAPTER);
    const config = {
      version: 'v1',
      tiers: {
        standard: {
          providers: [
            {
              provider_kind: 'openhands_agent_server',
              model: 'anthropic/claude-sonnet-4-6',
              label: 'agent-server-sonnet',
            },
          ],
        },
      },
    };
    const result = validate(config, {
      kindRegistry: KIND_REGISTRY,
      evalRoot,
      extraKinds: ['openhands_agent_server'],
    });
    assert.ok(result.ok, `Expected ok:true, got: ${JSON.stringify(result.errors)}`);
  });

  test('t2 — adapter missing agent_id → error on adapter.agent_id path', () => {
    const partial = { ...FULL_ADAPTER };
    delete partial.agent_id;
    const evalRoot = makeEvalRoot(partial);
    const config = {
      version: 'v1',
      tiers: {
        standard: {
          providers: [
            { provider_kind: 'openhands_agent_server', model: 'anthropic/claude-sonnet-4-6' },
          ],
        },
      },
    };
    const result = validate(config, {
      kindRegistry: KIND_REGISTRY,
      evalRoot,
      extraKinds: ['openhands_agent_server'],
    });
    assert.ok(!result.ok);
    assertError(result.errors, '.adapter.agent_id', 'non-empty string');
  });

  test('t3 — bogus provider_kind lists merged set including openhands_agent_server', () => {
    const config = {
      version: 'v1',
      tiers: {
        standard: {
          providers: [{ provider_kind: 'bogus', model: 'x' }],
        },
      },
    };
    const result = validate(config, {
      kindRegistry: KIND_REGISTRY,
      extraKinds: ['openhands_agent_server'],
    });
    assert.ok(!result.ok);
    const e = result.errors.find((x) => x.path.endsWith('.provider_kind'));
    assert.ok(e, `expected provider_kind error, got: ${JSON.stringify(result.errors)}`);
    assert.ok(
      e.expected.includes('openhands_agent_server'),
      `expected message lists openhands_agent_server, got: ${e.expected}`,
    );
    for (const k of Object.keys(KIND_REGISTRY)) {
      assert.ok(e.expected.includes(k), `expected list to include ${k}, got: ${e.expected}`);
    }
  });

  test('t4 — openhands_agent_server without model → non-empty model error', () => {
    const evalRoot = makeEvalRoot(FULL_ADAPTER);
    const config = {
      version: 'v1',
      tiers: {
        standard: {
          providers: [{ provider_kind: 'openhands_agent_server' }],
        },
      },
    };
    const result = validate(config, {
      kindRegistry: KIND_REGISTRY,
      evalRoot,
      extraKinds: ['openhands_agent_server'],
    });
    assert.ok(!result.ok);
    assertError(result.errors, 'providers[0].model', 'non-empty model');
  });

  test('t5 — valid adapter WITHOUT microagent_install_path passes', () => {
    const adapter = { ...FULL_ADAPTER };
    assert.ok(!('microagent_install_path' in adapter), 'fixture must omit microagent_install_path');
    const evalRoot = makeEvalRoot(adapter);
    const config = {
      version: 'v1',
      tiers: {
        standard: {
          providers: [
            { provider_kind: 'openhands_agent_server', model: 'anthropic/claude-sonnet-4-6' },
          ],
        },
      },
    };
    const result = validate(config, {
      kindRegistry: KIND_REGISTRY,
      evalRoot,
      extraKinds: ['openhands_agent_server'],
    });
    assert.ok(result.ok, `Expected ok:true (microagent_install_path is optional), got: ${JSON.stringify(result.errors)}`);
  });

  test('t6 — regression: existing call shape (no evalRoot, no extraKinds) still accepts the 5 registry kinds', () => {
    const config = {
      version: 'v1',
      tiers: {
        a: { providers: [{ provider_kind: 'opencode_cli', model: null }] },
        b: { providers: [{ provider_kind: 'openhands_sdk', model: 'anthropic/claude-sonnet-4-6' }] },
        c: { providers: [{ provider_kind: 'claude_agent_sdk', model: 'anthropic/claude-sonnet-4-6' }] },
        d: { providers: [{ provider_kind: 'opencode_sdk', model: 'anthropic/claude-sonnet-4-6' }] },
        e: { providers: [{ provider_kind: 'codex_sdk', model: 'gpt-4o' }] },
      },
    };
    const result = validate(config, { kindRegistry: KIND_REGISTRY });
    assert.ok(result.ok, `Expected ok:true, got: ${JSON.stringify(result.errors)}`);
  });
});
