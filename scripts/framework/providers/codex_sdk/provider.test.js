'use strict';

/**
 * Phase 12 — Layer 1 direct unit tests for codex_sdk provider.
 *
 * Top-level require of tests/_mock_codex_sdk/register.js installs the
 * Module._resolveFilename hook BEFORE the provider's lazy
 * require('@openai/codex-sdk') runs in create().init(). The mock module
 * records every Codex ctor + startThread + run event onto
 * globalThis.__codexMockState so we can assert:
 *
 *   - HOME isolation across parallel cases (per-session mkdtemp)
 *   - workingDirectory continuity within a case (same Thread for both turns)
 *   - skipGitRepoCheck=false forwarded
 *   - sandboxMode / modelReasoningEffort forwarded
 *   - git init created the .git directory + initial commit in workspace
 *   - multi-turn dependency: turn 2 recalls value from turn 1
 *   - failure scenarios surface contract codes (AUTH, rate_limit, UNSUPPORTED_MODEL)
 */

require('../../../../tests/_mock_codex_sdk/register.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { create } = require('./provider');

function _resetMockState() {
  globalThis.__codexMockState = { events: [] };
}

function _mkWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sdk-test-'));
}

async function _rmrf(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

test('codex_sdk: single-turn happy path returns text + records mock events', async () => {
  delete process.env.CODEX_SDK_MOCK_SCENARIO;
  _resetMockState();
  const wsRoot = _mkWorkspace();
  try {
    const provider = create();
    const session = await provider.init({
      provider_kind: 'codex_sdk',
      provider_label: 'codex-sdk-test',
      model: 'gpt-4o',
      case_id: 'case-happy',
      workspace_root: wsRoot,
      extra: { sandbox_mode: 'workspace-write', reasoning_effort: 'high' },
    });

    const res = await provider.turn(session, 'hello world');
    assert.equal(res.error, undefined, `unexpected error: ${JSON.stringify(res.error)}`);
    assert.match(res.output, /Hi there!/);
    assert.ok(Array.isArray(res.tool_calls));
    assert.equal(res.tool_calls.length, 0);

    const fin = await provider.finalize(session);
    assert.ok(fin.metadata, 'finalize must return metadata');
    assert.ok(fin.metadata.tokens, 'tokens object expected');
    assert.equal(typeof fin.metadata.tokens.total, 'number');
    assert.ok(fin.metadata.tokens.total > 0);

    // Mock events must cover: ctor → startThread → run
    const events = globalThis.__codexMockState.events;
    const kinds = events.map((e) => e.event);
    assert.deepEqual(kinds, ['ctor', 'startThread', 'run']);
    const startEvent = events.find((e) => e.event === 'startThread');
    assert.equal(startEvent.skipGitRepoCheck, false);
    assert.equal(startEvent.sandboxMode, 'workspace-write');
    assert.equal(startEvent.modelReasoningEffort, 'high');
    assert.equal(startEvent.model, 'gpt-4o');
    assert.equal(startEvent.gitExists, true, 'git init must have created .git before startThread');

    // Workspace dir + HOME dir live under wsRoot until shutdown.
    assert.ok(session.caseWorkDir.startsWith(wsRoot));
    assert.ok(session.homeDir.startsWith(wsRoot));
    assert.ok(fs.existsSync(path.join(session.caseWorkDir, '.git')));

    await provider.shutdown(session);
    assert.equal(session.caseWorkDir, null);
    assert.equal(session.homeDir, null);
  } finally {
    await _rmrf(wsRoot);
  }
});

test('codex_sdk: multi-turn continuity — turn 2 recalls remembered number from turn 1', async () => {
  delete process.env.CODEX_SDK_MOCK_SCENARIO;
  _resetMockState();
  const wsRoot = _mkWorkspace();
  try {
    const provider = create();
    const session = await provider.init({
      provider_kind: 'codex_sdk',
      provider_label: 'codex-sdk-multi',
      model: 'gpt-4o',
      case_id: 'case-multi',
      workspace_root: wsRoot,
    });

    const t1 = await provider.turn(session, 'Please remember 42 for me.');
    assert.equal(t1.error, undefined);
    assert.match(t1.output, /remember 42/);

    const t2 = await provider.turn(session, 'what number was it?');
    assert.equal(t2.error, undefined);
    assert.match(t2.output, /42/);

    // Both turns must hit the SAME Thread instance — only ONE startThread event.
    const events = globalThis.__codexMockState.events;
    const startThreadCount = events.filter((e) => e.event === 'startThread').length;
    assert.equal(startThreadCount, 1, 'multi-turn must reuse the same Thread');
    const runEvents = events.filter((e) => e.event === 'run');
    assert.equal(runEvents.length, 2);
    assert.equal(runEvents[0].workingDirectory, runEvents[1].workingDirectory,
      'both turns must share workingDirectory');

    await provider.shutdown(session);
  } finally {
    await _rmrf(wsRoot);
  }
});

test('codex_sdk: parallel cases get isolated HOME dirs and workspaces', async () => {
  delete process.env.CODEX_SDK_MOCK_SCENARIO;
  _resetMockState();
  const wsRoot = _mkWorkspace();
  try {
    const provider = create();
    const [s1, s2] = await Promise.all([
      provider.init({
        provider_kind: 'codex_sdk', provider_label: 'a', model: 'gpt-4o',
        case_id: 'case-A', workspace_root: wsRoot,
      }),
      provider.init({
        provider_kind: 'codex_sdk', provider_label: 'b', model: 'gpt-4o',
        case_id: 'case-B', workspace_root: wsRoot,
      }),
    ]);

    assert.notEqual(s1.homeDir, s2.homeDir, 'HOMEs must be distinct');
    await Promise.all([provider.turn(s1, 'hello'), provider.turn(s2, 'hello')]);

    assert.notEqual(s1.caseWorkDir, s2.caseWorkDir, 'workspaces must be distinct');
    assert.ok(fs.existsSync(path.join(s1.caseWorkDir, '.git')));
    assert.ok(fs.existsSync(path.join(s2.caseWorkDir, '.git')));

    const ctorEvents = globalThis.__codexMockState.events.filter((e) => e.event === 'ctor');
    assert.equal(ctorEvents.length, 2);
    assert.notEqual(ctorEvents[0].home, ctorEvents[1].home, 'forwarded HOME must differ across ctors');

    await Promise.all([provider.shutdown(s1), provider.shutdown(s2)]);
  } finally {
    await _rmrf(wsRoot);
  }
});

test('codex_sdk: auth scenario → AUTH (retryable: false)', async () => {
  process.env.CODEX_SDK_MOCK_SCENARIO = 'auth';
  _resetMockState();
  const wsRoot = _mkWorkspace();
  try {
    const provider = create();
    const session = await provider.init({
      provider_kind: 'codex_sdk', provider_label: 'auth', model: 'gpt-4o',
      case_id: 'case-auth', workspace_root: wsRoot,
    });
    const res = await provider.turn(session, 'hi');
    assert.ok(res.error, 'expected error object');
    assert.equal(res.error.code, 'AUTH');
    assert.equal(res.error.retryable, false);
    await provider.shutdown(session);
  } finally {
    delete process.env.CODEX_SDK_MOCK_SCENARIO;
    await _rmrf(wsRoot);
  }
});

test('codex_sdk: rate_limit scenario → rate_limit (retryable: true)', async () => {
  process.env.CODEX_SDK_MOCK_SCENARIO = 'rate_limit';
  _resetMockState();
  const wsRoot = _mkWorkspace();
  try {
    const provider = create();
    const session = await provider.init({
      provider_kind: 'codex_sdk', provider_label: 'rate', model: 'gpt-4o',
      case_id: 'case-rate', workspace_root: wsRoot,
    });
    const res = await provider.turn(session, 'hi');
    assert.ok(res.error, 'expected error object');
    assert.equal(res.error.code, 'rate_limit');
    assert.equal(res.error.retryable, true);
    await provider.shutdown(session);
  } finally {
    delete process.env.CODEX_SDK_MOCK_SCENARIO;
    await _rmrf(wsRoot);
  }
});

test('codex_sdk: unsupported_model scenario → UNSUPPORTED_MODEL (retryable: false)', async () => {
  process.env.CODEX_SDK_MOCK_SCENARIO = 'unsupported_model';
  _resetMockState();
  const wsRoot = _mkWorkspace();
  try {
    const provider = create();
    const session = await provider.init({
      provider_kind: 'codex_sdk', provider_label: 'um', model: 'made-up',
      case_id: 'case-um', workspace_root: wsRoot,
    });
    const res = await provider.turn(session, 'hi');
    assert.ok(res.error, 'expected error object');
    assert.equal(res.error.code, 'UNSUPPORTED_MODEL');
    assert.equal(res.error.retryable, false);
    await provider.shutdown(session);
  } finally {
    delete process.env.CODEX_SDK_MOCK_SCENARIO;
    await _rmrf(wsRoot);
  }
});
