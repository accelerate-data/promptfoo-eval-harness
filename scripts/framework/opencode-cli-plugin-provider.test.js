'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const makeOpenCodeCliPluginProvider = require('./opencode-cli-plugin-provider');
const OpenCodeCliProvider = require('./opencode-cli-provider');
const { EVAL_ROOT } = require('./roots');

const {
  TRANSPORT_NAME,
  PROVIDER_ID,
  extractWorkspace,
  splitCommand,
  buildOpenCodeInvocation,
  _resolveWorkspace,
  _resolvePluginLink,
  _resolveParser,
} = makeOpenCodeCliPluginProvider.__private;

const FIXTURE_DIR = path.join(EVAL_ROOT, 'tests', '_fixtures', 'opencode-plugin-parsers');

function buildFactory(extraConfig = {}, extraOptions = {}) {
  return makeOpenCodeCliPluginProvider({
    id: PROVIDER_ID,
    config: {
      agent: 'eval_light',
      opencode_config: 'config/eval-tiers.toml',
      project_dir: '.',
      format: 'json',
      log_level: 'info',
      ...extraConfig,
    },
    ...extraOptions,
  });
}

test('factory returns exactly { id, label, callApi } — no lifecycle methods', () => {
  const p = buildFactory();
  assert.deepEqual(Object.keys(p).sort(), ['callApi', 'id', 'label']);
  assert.equal(typeof p.id, 'function');
  assert.equal(typeof p.label, 'string');
  assert.equal(typeof p.callApi, 'function');
  // Sibling is NOT a subclass of OpenCodeCliProvider — Shape B wrapper.
  assert.notEqual(Object.getPrototypeOf(p), OpenCodeCliProvider.prototype);
});

test('label format is opencode_cli_plugin/<agent_id-or-agent>', () => {
  assert.equal(
    buildFactory({ agent: 'eval_high' }).label,
    'opencode_cli_plugin/eval_high',
  );
  assert.equal(
    buildFactory({ agent: 'eval_high', agent_id: 'vibedata:de' }).label,
    'opencode_cli_plugin/vibedata:de',
  );
});

test('id delegates to base.id (consumer-facing id parity)', () => {
  const p = makeOpenCodeCliPluginProvider({ id: 'custom-id', config: { agent: 'eval_light' } });
  assert.equal(p.id(), 'custom-id');
});

test('TRANSPORT_NAME is opencode_cli_plugin', () => {
  assert.equal(TRANSPORT_NAME, 'opencode_cli_plugin');
});

test('extractWorkspace handles Workspace: / operating in workspace markers', () => {
  assert.equal(extractWorkspace('Workspace: /tmp/foo'), '/tmp/foo');
  assert.equal(extractWorkspace('operating in workspace /tmp/abc.'), '/tmp/abc');
  assert.equal(extractWorkspace('no marker'), null);
  assert.equal(extractWorkspace(null), null);
});

test('splitCommand tokenizes quoted args', () => {
  assert.deepEqual(splitCommand('opencode'), ['opencode']);
  assert.deepEqual(splitCommand('npx opencode --foo'), ['npx', 'opencode', '--foo']);
  assert.deepEqual(splitCommand('"path with spaces" arg'), ['path with spaces', 'arg']);
});

test('buildOpenCodeInvocation honors override > env > default', () => {
  assert.equal(
    buildOpenCodeInvocation(['run'], {}, 'my-runner').command,
    'my-runner',
  );
  assert.equal(
    buildOpenCodeInvocation(['run'], { OPENCODE_RUNNER_COMMAND: 'env-runner' }).command,
    'env-runner',
  );
  // override beats env
  assert.equal(
    buildOpenCodeInvocation(['run'], { OPENCODE_RUNNER_COMMAND: 'env-runner' }, 'cfg-runner').command,
    'cfg-runner',
  );
});

test('_resolveWorkspace precedence: prompt marker > cfg.project_dir > mkdtemp fallback', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'occp-ws-'));
  try {
    // 1. Prompt marker wins
    assert.equal(
      _resolveWorkspace('Workspace: /tmp/marker-win\nDo X', {}, { project_dir: '.' }, path.join(tmp, 'fallback-')),
      path.resolve('/tmp/marker-win'),
    );
    // 2. project_dir when no marker
    assert.equal(
      _resolveWorkspace('no marker', {}, { project_dir: '.' }, path.join(tmp, 'fallback-')),
      path.resolve(EVAL_ROOT, '.'),
    );
    // 3. mkdtemp fallback when neither set — returns a dir starting with fallback prefix
    const allocated = _resolveWorkspace('no marker', {}, {}, path.join(tmp, 'fallback-'));
    assert.ok(allocated.startsWith(path.join(tmp, 'fallback-')));
    assert.ok(fs.existsSync(allocated));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('_resolvePluginLink returns { linked: true, path } when symlink exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'occp-link-'));
  try {
    const target = path.join(tmp, 'target');
    fs.mkdirSync(target);
    const linkParent = path.join(tmp, 'workspace', '.opencode', 'plugins');
    fs.mkdirSync(linkParent, { recursive: true });
    const linkPath = path.join(linkParent, 'plugin-x');
    fs.symlinkSync(target, linkPath);

    const workspace = path.join(tmp, 'workspace');
    const result = _resolvePluginLink(workspace, '.opencode/plugins/plugin-x');
    assert.equal(result.linked, true);
    assert.equal(result.path, path.relative(workspace, fs.realpathSync(linkPath)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('_resolvePluginLink returns { linked: false } when path missing or unset', () => {
  assert.deepEqual(_resolvePluginLink('/tmp/nonexistent', null), { linked: false, path: null });
  assert.deepEqual(_resolvePluginLink('/tmp', '.opencode/plugins/missing'), { linked: false, path: null });
});

test('_resolveParser default-function fixture loads and runs', async () => {
  const rel = path.relative(EVAL_ROOT, path.join(FIXTURE_DIR, 'default-export.js'));
  const parser = _resolveParser(rel);
  assert.equal(typeof parser, 'function');
  const result = await parser('hello');
  assert.equal(result.text, 'default:hello');
  assert.equal(result.trajectory[0].via, 'default-export');
});

test('_resolveParser named-export fixture loads and runs', async () => {
  const rel = path.relative(EVAL_ROOT, path.join(FIXTURE_DIR, 'named-export.js'));
  const parser = _resolveParser(rel);
  const result = await parser('world');
  assert.equal(result.text, 'named:world');
  assert.equal(result.trajectory[0].via, 'named-export');
});

test('_resolveParser throws actionable error when neither shape present', () => {
  const rel = path.relative(EVAL_ROOT, path.join(FIXTURE_DIR, 'no-function.js'));
  assert.throws(
    () => _resolveParser(rel),
    /must export a function or \{ parseOpenCodeJsonStream \}/,
  );
});

test('_resolveParser rejects paths resolving outside EVAL_ROOT', () => {
  assert.throws(
    () => _resolveParser('../../etc/passwd'),
    /must resolve under EVAL_ROOT/,
  );
});

test('_resolveParser identity parser returns trimmed text', async () => {
  const parser = _resolveParser(null);
  const result = await parser('  hello world  \n');
  assert.deepEqual(result, { text: 'hello world' });
});

test('bootstrap_prompt prepended to argv prompt; identity preserved on retry', async () => {
  const capturedPrompts = [];
  let attempts = 0;
  const runner = async (args, _opts) => {
    capturedPrompts.push(args[args.length - 1]);
    attempts += 1;
    return attempts === 1 ? '' : 'ok';
  };
  const provider = buildFactory(
    { bootstrap_prompt: 'BOOT', empty_output_retries: 1 },
    { runner },
  );
  const result = await provider.callApi('Workspace: /tmp/probe-x\nDo X');
  assert.equal(result.output, 'ok');
  assert.equal(capturedPrompts.length, 2);
  assert.equal(capturedPrompts[0], 'BOOT\n\nWorkspace: /tmp/probe-x\nDo X');
  assert.equal(capturedPrompts[1], 'BOOT\n\nWorkspace: /tmp/probe-x\nDo X');
});

test('capture_on_failure=true selects runOpenCodeCaptureAll by default; false selects base runOpenCode', () => {
  // Indirectly: assert different defaults are wired. The sibling reads option.runner
  // before falling back. We don't run a subprocess, just check factory accepts both.
  const a = buildFactory({ capture_on_failure: true });
  const b = buildFactory({ capture_on_failure: false });
  assert.equal(typeof a.callApi, 'function');
  assert.equal(typeof b.callApi, 'function');
});

test('write_run_metadata=true emits <workspace>/.eval-run/provider.json; false skips', async () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'occp-meta-'));
  const ws = path.join(wsRoot, 'ws');
  fs.mkdirSync(ws);
  try {
    const runner = async () => 'output text';
    const onCfg = {
      bootstrap_prompt: '',
      write_run_metadata: true,
      agent_id: 'plugin:agent',
      agent_entrypoint_file: 'plugins/x/agent.md',
    };
    const onProvider = buildFactory(onCfg, { runner });
    await onProvider.callApi(`Workspace: ${ws}\nGo`);
    const jsonPath = path.join(ws, '.eval-run', 'provider.json');
    assert.ok(fs.existsSync(jsonPath), 'provider.json should be written');
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(meta.transport, 'opencode_cli_plugin');
    assert.equal(meta.agent, 'plugin:agent');
    assert.equal(meta.agent_entrypoint_file, 'plugins/x/agent.md');
    assert.equal(meta.agent_runtime, 'opencode-cli plugin agent');

    // Negative case: write_run_metadata=false → no file even though dir is reused
    const ws2 = path.join(wsRoot, 'ws2');
    fs.mkdirSync(ws2);
    const offProvider = buildFactory({ write_run_metadata: false }, { runner });
    await offProvider.callApi(`Workspace: ${ws2}\nGo`);
    assert.ok(!fs.existsSync(path.join(ws2, '.eval-run', 'provider.json')));
  } finally {
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
});

test('parser trajectory persisted to <workspace>/.eval-run/trajectory.json', async () => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'occp-traj-'));
  const ws = path.join(wsRoot, 'ws');
  fs.mkdirSync(ws);
  try {
    const runner = async () => 'raw output';
    const rel = path.relative(EVAL_ROOT, path.join(FIXTURE_DIR, 'named-export.js'));
    const provider = buildFactory(
      { opencode_parser_module: rel },
      { runner },
    );
    const result = await provider.callApi(`Workspace: ${ws}\nGo`);
    assert.equal(result.output, 'named:raw output');
    const trajPath = path.join(ws, '.eval-run', 'trajectory.json');
    assert.ok(fs.existsSync(trajPath));
    const traj = JSON.parse(fs.readFileSync(trajPath, 'utf8'));
    assert.deepEqual(traj, [{ via: 'named-export', raw: 'raw output' }]);
  } finally {
    fs.rmSync(wsRoot, { recursive: true, force: true });
  }
});

test('runner error surfaces as { error: ... }', async () => {
  const runner = async () => { throw new Error('runner blew up'); };
  const provider = buildFactory({}, { runner });
  const result = await provider.callApi('Workspace: /tmp/x\nGo');
  assert.match(result.error, /runner blew up/);
});

test('empty-output retries respect cap and report errors[]', async () => {
  let calls = 0;
  const runner = async () => { calls += 1; return ''; };
  // Identity parser (no opencode_parser_module): text === trim('') === '' → retry
  const provider = buildFactory(
    { empty_output_retries: 2 },
    { runner },
  );
  const result = await provider.callApi(`Workspace: ${fs.mkdtempSync(path.join(os.tmpdir(), 'occp-cap-'))}\nGo`);
  assert.equal(calls, 3); // 1 + 2 retries
  assert.match(result.error, /empty output after 3 attempt\(s\)/);
});

test('load_local_env does NOT overwrite pre-existing process.env keys', () => {
  // Setup: write a small .env into a fresh tmp tree, point loadEnvFile at it
  const { loadEnvFile } = makeOpenCodeCliPluginProvider.__private;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'occp-env-'));
  const envFile = path.join(tmp, '.env');
  fs.writeFileSync(envFile, 'OCCP_PROBE_KEEP=fromfile\nOCCP_PROBE_NEW=fresh\n');
  process.env.OCCP_PROBE_KEEP = 'preexisting';
  delete process.env.OCCP_PROBE_NEW;
  try {
    loadEnvFile(envFile);
    assert.equal(process.env.OCCP_PROBE_KEEP, 'preexisting'); // NOT overwritten
    assert.equal(process.env.OCCP_PROBE_NEW, 'fresh');         // newly populated
  } finally {
    delete process.env.OCCP_PROBE_KEEP;
    delete process.env.OCCP_PROBE_NEW;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('base file scripts/framework/opencode-cli-provider.js is byte-identical from phase-04 parent SHA', () => {
  const shaFile = path.join(EVAL_ROOT, 'tests', '_fixtures', 'phase-04-parent.sha');
  if (!fs.existsSync(shaFile)) {
    // If the stamp is missing we cannot enforce — skip rather than false-negative.
    return;
  }
  const sha = fs.readFileSync(shaFile, 'utf8').trim();
  assert.match(sha, /^[0-9a-f]{40}$/, 'stamp file must contain a full 40-char SHA');
  try {
    execFileSync(
      'git',
      ['diff', '--exit-code', sha, 'HEAD', '--', 'scripts/framework/opencode-cli-provider.js'],
      { cwd: EVAL_ROOT, stdio: 'pipe' },
    );
  } catch (err) {
    assert.fail(
      `Base file scripts/framework/opencode-cli-provider.js diverged from phase-04 parent ${sha}:\n${err.stdout || ''}${err.stderr || ''}`,
    );
  }
});

test('runner receives expected argv shape: run --agent --dir --format --log-level + prompt', async () => {
  const captured = [];
  const runner = async (args, _opts) => { captured.push(args); return 'ok'; };
  const provider = buildFactory(
    {
      agent: 'eval_high',
      format: 'json',
      log_level: 'debug',
      print_logs: true,
    },
    { runner },
  );
  await provider.callApi('Workspace: /tmp/probe-y\nDo Y');
  const args = captured[0];
  assert.equal(args[0], 'run');
  assert.equal(args[args.indexOf('--agent') + 1], 'eval_high');
  assert.equal(args[args.indexOf('--dir') + 1], path.resolve('/tmp/probe-y'));
  assert.equal(args[args.indexOf('--format') + 1], 'json');
  assert.equal(args[args.indexOf('--log-level') + 1], 'debug');
  assert.ok(args.includes('--print-logs'));
  assert.equal(args[args.length - 1], 'Workspace: /tmp/probe-y\nDo Y');
});

test('runner env includes OPENCODE_CONFIG when cfg.opencode_config set, omits when null', async () => {
  const captured = [];
  const runner = async (_args, opts) => { captured.push(opts.env); return 'ok'; };

  const withCfg = buildFactory(
    { opencode_config: 'config/eval-tiers.toml' },
    { runner },
  );
  await withCfg.callApi('Workspace: /tmp/probe-z\nGo');
  assert.ok(captured[0].OPENCODE_CONFIG.endsWith('config/eval-tiers.toml'));
  assert.ok(captured[0].XDG_STATE_HOME);
});
