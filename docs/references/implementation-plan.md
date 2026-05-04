# Shared Eval Harness Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current repo-local Promptfoo/OpenCode eval harness into a package-shaped framework that owns model policy, tier sizing, runtime setup, state resolution, config materialization, and guardrails while project repos keep only eval YAML, prompts, fixtures, and domain assertions.

**Architecture:** First prove the package boundary inside Skill Builder under `tests/evals` with a local `ad-evals` CLI. The CLI owns dependency resolution for Promptfoo state, model/tier policy, provider wiring, command discovery, resolved config generation, and cleanup guarding. After Skill Builder works, port `migration-utility` as the second consumer and `engineering-skills` as the older-provider migration case before extracting the unchanged framework files into a standalone npm package.

**Tech Stack:** Node.js CLI, Promptfoo, OpenCode CLI provider, TOML policy config, git common-dir state discovery, Node test runner.

**Branching:** Implement this issue on `feature/vu-1154-package-promptfooopencode-eval-harness-as-shared-framework` stacked on `feature/vu-1145-implement-openhands-native-clean-break-agent-runtime`. Raise the VU-1154 PR against the VU-1145 branch, not `main`, because the shared harness proof depends on the VU-1145 OpenHands-native eval/runtime baseline.

---

## File Structure

- Modify: `tests/evals/package.json` - replace hardcoded command wiring with calls to the local `ad-evals` CLI.
- Create: `tests/evals/bin/ad-evals.js` - CLI entrypoint for `test`, `smoke`, `regression`, `run`, `view`, and `doctor`.
- Create: `tests/evals/eval-map.json` - eval-local navigation map for coding agents that add or maintain packages.
- Create: `tests/evals/scripts/framework/paths.js` - resolves repo root, eval root, git common dir, shared Promptfoo state, and worktree-local artifact dirs.
- Create: `tests/evals/scripts/framework/environment.js` - prepares and exports Promptfoo/OpenCode env vars before every command.
- Create: `tests/evals/scripts/framework/package-discovery.js` - discovers Promptfoo package configs and smoke coverage automatically.
- Move: `tests/evals/scripts/eval-tier-config.js` -> `tests/evals/scripts/framework/eval-tier-config.js`.
- Move: `tests/evals/scripts/resolve-promptfoo-config.js` -> `tests/evals/scripts/framework/resolve-promptfoo-config.js`.
- Move: `tests/evals/scripts/run-promptfoo-with-guard.js` -> `tests/evals/scripts/framework/run-promptfoo-with-guard.js`.
- Move: `tests/evals/scripts/opencode-cli-provider.js` -> `tests/evals/scripts/framework/opencode-cli-provider.js`.
- Modify: `tests/evals/scripts/promptfoo.sh` - reduce to a compatibility wrapper around `node bin/ad-evals.js promptfoo --`.
- Modify: `tests/evals/config/eval-tiers.toml` - keep project-overridable policy in this repo while making its schema framework-owned.
- Modify: `tests/evals/scripts/*.test.js` - update imports and add tests for state export, command discovery, eval-map coverage, and no symlink dependency.
- Modify: `scripts/worktree.sh` - remove Promptfoo symlink setup after the CLI owns state export.
- Modify: `TEST_MAP.md` and `repo-map.json` - reflect the framework-shaped harness commands and validation boundaries.

## Task 1: Add Framework Path And Environment Resolution

**Files:**

- Create: `tests/evals/scripts/framework/paths.js`
- Create: `tests/evals/scripts/framework/environment.js`
- Test: `tests/evals/scripts/framework/paths.test.js`
- Test: `tests/evals/scripts/framework/environment.test.js`

- [ ] **Step 1: Write path resolution tests**

Create `tests/evals/scripts/framework/paths.test.js`:

```js
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolveHarnessPaths } = require('./paths');

test('resolveHarnessPaths keeps shared state under git common dir', () => {
  const calls = [];
  const paths = resolveHarnessPaths({
    cwd: '/repo/worktree/tests/evals',
    execFileSync: (cmd, args) => {
      calls.push([cmd, args]);
      if (args.includes('--show-toplevel')) return '/repo/worktree\n';
      if (args.includes('--git-common-dir')) return '/repo/.git/worktrees/feature\n';
      throw new Error(`unexpected args: ${args.join(' ')}`);
    },
  });

  assert.equal(paths.repoRoot, '/repo/worktree');
  assert.equal(paths.evalRoot, path.join('/repo/worktree', 'tests', 'evals'));
  assert.equal(paths.sharedPromptfooDir, path.join('/repo/.git/worktrees/feature', 'ad-evals', 'promptfoo'));
  assert.equal(paths.sharedOpenCodeStateDir, path.join('/repo/.git/worktrees/feature', 'ad-evals', 'opencode-state'));
  assert.equal(paths.promptfooCachePath, path.join('/repo/worktree', 'tests', 'evals', '.cache', 'promptfoo'));
  assert.equal(paths.tmpDir, path.join('/repo/worktree', 'tests', 'evals', '.tmp'));
});
```

- [ ] **Step 2: Run the path test and verify it fails**

Run: `cd tests/evals && node --test scripts/framework/paths.test.js`

Expected: FAIL with `Cannot find module './paths'`.

- [ ] **Step 3: Implement path resolution**

Create `tests/evals/scripts/framework/paths.js`:

```js
const { execFileSync } = require('node:child_process');
const path = require('node:path');

function gitOutput(args, cwd, execFile = execFileSync) {
  return execFile('git', args, { cwd, encoding: 'utf8' }).trim();
}

function resolveHarnessPaths({ cwd = process.cwd(), execFileSync: execFile = execFileSync } = {}) {
  const repoRoot = gitOutput(['rev-parse', '--show-toplevel'], cwd, execFile);
  const gitCommonDir = path.resolve(repoRoot, gitOutput(['rev-parse', '--git-common-dir'], repoRoot, execFile));
  const evalRoot = path.join(repoRoot, 'tests', 'evals');
  const sharedRoot = path.join(gitCommonDir, 'ad-evals');

  return {
    repoRoot,
    gitCommonDir,
    evalRoot,
    sharedPromptfooDir: path.join(sharedRoot, 'promptfoo'),
    sharedOpenCodeStateDir: path.join(sharedRoot, 'opencode-state'),
    promptfooCachePath: path.join(evalRoot, '.cache', 'promptfoo'),
    promptfooLogDir: path.join(evalRoot, 'results', 'logs'),
    promptfooMediaPath: path.join(evalRoot, 'output', 'media'),
    tmpDir: path.join(evalRoot, '.tmp'),
  };
}

module.exports = { resolveHarnessPaths };
```

- [ ] **Step 4: Add environment export tests**

Create `tests/evals/scripts/framework/environment.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildHarnessEnv } = require('./environment');

test('buildHarnessEnv exports shared Promptfoo state and worktree-local artifacts', () => {
  const env = buildHarnessEnv({
    baseEnv: { PATH: '/bin' },
    paths: {
      repoRoot: '/repo/worktree',
      sharedPromptfooDir: '/repo/.git/ad-evals/promptfoo',
      sharedOpenCodeStateDir: '/repo/.git/ad-evals/opencode-state',
      promptfooCachePath: '/repo/worktree/tests/evals/.cache/promptfoo',
      promptfooLogDir: '/repo/worktree/tests/evals/results/logs',
      promptfooMediaPath: '/repo/worktree/tests/evals/output/media',
      tmpDir: '/repo/worktree/tests/evals/.tmp',
    },
  });

  assert.equal(env.PROMPTFOO_CONFIG_DIR, '/repo/.git/ad-evals/promptfoo');
  assert.equal(env.XDG_STATE_HOME, '/repo/.git/ad-evals/opencode-state');
  assert.equal(env.PROMPTFOO_CACHE_PATH, '/repo/worktree/tests/evals/.cache/promptfoo');
  assert.equal(env.CLAUDE_PLUGIN_ROOT, '/repo/worktree');
  assert.equal(env.TMPDIR, '/repo/worktree/tests/evals/.tmp');
});
```

- [ ] **Step 5: Run the environment test and verify it fails**

Run: `cd tests/evals && node --test scripts/framework/environment.test.js`

Expected: FAIL with `Cannot find module './environment'`.

- [ ] **Step 6: Implement environment export**

Create `tests/evals/scripts/framework/environment.js`:

```js
function buildHarnessEnv({ baseEnv = process.env, paths }) {
  return {
    ...baseEnv,
    PROMPTFOO_CONFIG_DIR: paths.sharedPromptfooDir,
    PROMPTFOO_CACHE_PATH: paths.promptfooCachePath,
    PROMPTFOO_LOG_DIR: paths.promptfooLogDir,
    PROMPTFOO_MEDIA_PATH: paths.promptfooMediaPath,
    PROMPTFOO_EVAL_TIMEOUT_MS: baseEnv.PROMPTFOO_EVAL_TIMEOUT_MS || '900000',
    PROMPTFOO_SCHEDULER_QUEUE_TIMEOUT_MS: baseEnv.PROMPTFOO_SCHEDULER_QUEUE_TIMEOUT_MS || '900000',
    CLAUDE_PLUGIN_ROOT: paths.repoRoot,
    TMPDIR: paths.tmpDir,
    TMP: paths.tmpDir,
    TEMP: paths.tmpDir,
    XDG_STATE_HOME: paths.sharedOpenCodeStateDir,
  };
}

module.exports = { buildHarnessEnv };
```

- [ ] **Step 7: Run both tests**

Run: `cd tests/evals && node --test scripts/framework/paths.test.js scripts/framework/environment.test.js`

Expected: PASS.

## Task 2: Introduce The Local `ad-evals` CLI

**Files:**

- Create: `tests/evals/bin/ad-evals.js`
- Create: `tests/evals/scripts/framework/package-discovery.js`
- Test: `tests/evals/scripts/framework/package-discovery.test.js`
- Test: `tests/evals/scripts/ad-evals-cli.test.js`

- [ ] **Step 1: Write package discovery tests**

Create `tests/evals/scripts/framework/package-discovery.test.js`:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { discoverPackageConfigs } = require('./package-discovery');

test('discoverPackageConfigs finds package YAML and JSON configs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-packages-'));
  fs.mkdirSync(path.join(root, 'packages', 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'a', 'promptfooconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'packages', 'b', 'suite.yaml'), '{}');
  fs.writeFileSync(path.join(root, 'packages', 'b', 'notes.txt'), 'ignore');

  assert.deepEqual(discoverPackageConfigs(root), [
    'packages/a/promptfooconfig.json',
    'packages/b/suite.yaml',
  ]);
});
```

- [ ] **Step 2: Run discovery test and verify it fails**

Run: `cd tests/evals && node --test scripts/framework/package-discovery.test.js`

Expected: FAIL with `Cannot find module './package-discovery'`.

- [ ] **Step 3: Implement package discovery**

Create `tests/evals/scripts/framework/package-discovery.js`:

```js
const fs = require('node:fs');
const path = require('node:path');

function walkConfigs(rootDir, currentDir = path.join(rootDir, 'packages')) {
  if (!fs.existsSync(currentDir)) return [];

  return fs.readdirSync(currentDir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) return walkConfigs(rootDir, entryPath);
    if (entry.isFile() && /\.(json|ya?ml)$/.test(entry.name)) {
      return [path.relative(rootDir, entryPath).split(path.sep).join('/')];
    }
    return [];
  }).sort();
}

function discoverPackageConfigs(evalRoot) {
  return walkConfigs(evalRoot);
}

module.exports = { discoverPackageConfigs };
```

- [ ] **Step 4: Write CLI routing tests**

Create `tests/evals/scripts/ad-evals-cli.test.js`:

```js
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildPromptfooArgs } = require('../bin/ad-evals');

test('smoke command discovers packages and adds smoke filter', () => {
  const args = buildPromptfooArgs({
    command: 'smoke',
    packageConfigs: ['packages/a/config.yaml', 'packages/b/config.json'],
  });

  assert.deepEqual(args, [
    'eval',
    '--no-cache',
    '--filter-pattern',
    '^\\[smoke\\]',
    '-c',
    'packages/a/config.yaml',
    '-c',
    'packages/b/config.json',
  ]);
});

test('run command targets one package config', () => {
  const args = buildPromptfooArgs({
    command: 'run',
    rest: ['packages/a/config.yaml', '--filter-pattern', 'case'],
    packageConfigs: [],
  });

  assert.deepEqual(args, ['eval', '--no-cache', '-c', 'packages/a/config.yaml', '--filter-pattern', 'case']);
});
```

- [ ] **Step 5: Run CLI routing test and verify it fails**

Run: `cd tests/evals && node --test scripts/ad-evals-cli.test.js`

Expected: FAIL with `Cannot find module '../bin/ad-evals'`.

- [ ] **Step 6: Implement the CLI entrypoint**

Create `tests/evals/bin/ad-evals.js` with exported `buildPromptfooArgs`, command dispatch, environment preparation, and Promptfoo invocation through the existing guard:

```js
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { buildHarnessEnv } = require('../scripts/framework/environment');
const { discoverPackageConfigs } = require('../scripts/framework/package-discovery');
const { resolveHarnessPaths } = require('../scripts/framework/paths');
const { main: runPromptfooWithGuard } = require('../scripts/framework/run-promptfoo-with-guard');

function buildPromptfooArgs({ command, rest = [], packageConfigs }) {
  if (command === 'smoke') {
    return ['eval', '--no-cache', '--filter-pattern', '^\\[smoke\\]', ...packageConfigs.flatMap((config) => ['-c', config])];
  }
  if (command === 'regression') {
    return ['eval', '--no-cache', ...packageConfigs.flatMap((config) => ['-c', config])];
  }
  if (command === 'run') {
    const [configPath, ...extra] = rest;
    if (!configPath) throw new Error('Usage: ad-evals run <config-path> [promptfoo args]');
    return ['eval', '--no-cache', '-c', configPath, ...extra];
  }
  if (command === 'view') return ['view', ...rest];
  if (command === 'promptfoo') return rest[0] === '--' ? rest.slice(1) : rest;
  throw new Error(`Unknown ad-evals command: ${command}`);
}

function prepareEnvironment(paths) {
  for (const dir of [
    paths.sharedPromptfooDir,
    paths.sharedOpenCodeStateDir,
    paths.promptfooCachePath,
    paths.promptfooLogDir,
    paths.promptfooMediaPath,
    paths.tmpDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  Object.assign(process.env, buildHarnessEnv({ paths }));
}

function run(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv;
  const paths = resolveHarnessPaths();
  prepareEnvironment(paths);
  if (command === 'test') {
    return require('node:child_process').spawnSync(process.execPath, ['--test', 'scripts/*.test.js', 'assertions/*.test.js'], {
      cwd: paths.evalRoot,
      env: process.env,
      stdio: 'inherit',
      shell: true,
    }).status || 0;
  }
  if (command === 'doctor') {
    console.log(JSON.stringify(paths, null, 2));
    return 0;
  }
  const promptfooArgs = buildPromptfooArgs({
    command,
    rest,
    packageConfigs: discoverPackageConfigs(paths.evalRoot),
  });
  return runPromptfooWithGuard(promptfooArgs);
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = { buildPromptfooArgs, run };
```

- [ ] **Step 7: Run CLI tests**

Run: `cd tests/evals && node --test scripts/framework/package-discovery.test.js scripts/ad-evals-cli.test.js`

Expected: PASS.

## Task 3: Move Framework Scripts Behind Stable Imports

**Files:**

- Move: `tests/evals/scripts/eval-tier-config.js` -> `tests/evals/scripts/framework/eval-tier-config.js`
- Move: `tests/evals/scripts/resolve-promptfoo-config.js` -> `tests/evals/scripts/framework/resolve-promptfoo-config.js`
- Move: `tests/evals/scripts/run-promptfoo-with-guard.js` -> `tests/evals/scripts/framework/run-promptfoo-with-guard.js`
- Move: `tests/evals/scripts/opencode-cli-provider.js` -> `tests/evals/scripts/framework/opencode-cli-provider.js`
- Modify: matching `*.test.js` imports
- Modify: `tests/evals/config/eval-tiers.toml`

- [ ] **Step 1: Move files with git**

Run:

```bash
mkdir -p tests/evals/scripts/framework
git mv tests/evals/scripts/eval-tier-config.js tests/evals/scripts/framework/eval-tier-config.js
git mv tests/evals/scripts/resolve-promptfoo-config.js tests/evals/scripts/framework/resolve-promptfoo-config.js
git mv tests/evals/scripts/run-promptfoo-with-guard.js tests/evals/scripts/framework/run-promptfoo-with-guard.js
git mv tests/evals/scripts/opencode-cli-provider.js tests/evals/scripts/framework/opencode-cli-provider.js
```

- [ ] **Step 2: Update relative imports**

Run: `rg "require\\('\\./(eval-tier-config|resolve-promptfoo-config|run-promptfoo-with-guard|opencode-cli-provider)" tests/evals/scripts`

Update each test import to require from `./framework/<name>` or `../scripts/framework/<name>` depending on the test file location.

- [ ] **Step 3: Update provider path policy**

Modify `tests/evals/config/eval-tiers.toml`:

```toml
[runtime]
provider_id = "file://scripts/framework/opencode-cli-provider.js"
opencode_config = "opencode.json"
project_dir = "../.."
format = "default"
log_level = "ERROR"
print_logs = false
empty_output_retries = 1
```

- [ ] **Step 4: Run moved-script tests**

Run: `cd tests/evals && node --test scripts/*test.js scripts/framework/*test.js`

Expected: PASS.

## Task 4: Replace Hardcoded NPM Scripts With CLI Commands

**Files:**

- Modify: `tests/evals/package.json`
- Modify: `tests/evals/scripts/promptfoo.sh`
- Test: `tests/evals/scripts/eval-suite-contract.test.js`

- [ ] **Step 1: Update package scripts**

Change `tests/evals/package.json` scripts to:

```json
{
  "eval:harness-smoke": "node bin/ad-evals.js run packages/harness-smoke/promptfooconfig.json",
  "eval:smoke": "node bin/ad-evals.js smoke",
  "eval:regression": "node bin/ad-evals.js regression",
  "test": "node bin/ad-evals.js test",
  "test:harness": "node --test scripts/*.test.js scripts/framework/*.test.js",
  "test:assertions": "node --test assertions/*.test.js",
  "doctor": "node bin/ad-evals.js doctor",
  "view": "node bin/ad-evals.js view"
}
```

Keep package-specific scripts only when they provide value for common targeted runs; each should call `node bin/ad-evals.js run <config>`.

- [ ] **Step 2: Keep `promptfoo.sh` as compatibility wrapper**

Replace `tests/evals/scripts/promptfoo.sh` body with:

```sh
#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
NODE_BIN="${npm_node_execpath:-$(command -v node)}"

exec "$NODE_BIN" "$SCRIPT_DIR/bin/ad-evals.js" promptfoo -- "$@"
```

- [ ] **Step 3: Update smoke contract**

Modify `tests/evals/scripts/eval-suite-contract.test.js` so `eval:smoke` is expected to call `node bin/ad-evals.js smoke`, and move per-package smoke inclusion checks to `package-discovery.test.js`.

- [ ] **Step 4: Run harness contract tests**

Run: `cd tests/evals && npm test`

Expected: PASS.

## Task 5: Remove Worktree Promptfoo Symlink Responsibility

**Files:**

- Modify: `scripts/worktree.sh`
- Modify: `tests/evals/scripts/worktree-script.test.js`
- Modify: `TEST_MAP.md`

- [ ] **Step 1: Update the worktree test expectation**

Modify `tests/evals/scripts/worktree-script.test.js` to assert that worktree bootstrap no longer creates or replaces `tests/evals/.promptfoo`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd tests/evals && node --test scripts/worktree-script.test.js`

Expected: FAIL because `scripts/worktree.sh` still links Promptfoo state.

- [ ] **Step 3: Remove Promptfoo symlink setup**

In `scripts/worktree.sh`, remove `link_promptfoo_state` and remove its call from `bootstrap_worktree`.

- [ ] **Step 4: Update test map wording**

In `TEST_MAP.md`, replace references to worktree Promptfoo symlinks with: "The eval harness exports Promptfoo state from the git common dir at runtime; worktree creation does not manage Promptfoo state."

- [ ] **Step 5: Run worktree and harness tests**

Run:

```bash
cd tests/evals && node --test scripts/worktree-script.test.js
cd tests/evals && npm test
```

Expected: PASS.

## Task 6: Prove Live Harness Behavior In Skill Builder

**Files:**

- No new files expected unless test failures expose required fixes.

- [ ] **Step 1: Inspect resolved paths**

Run: `cd tests/evals && npm run doctor`

Expected: JSON output includes shared state under the git common dir and worktree-local cache/output/tmp paths.

- [ ] **Step 2: Run deterministic harness tests**

Run: `cd tests/evals && npm test`

Expected: PASS.

- [ ] **Step 3: Run the harness smoke package**

Run: `cd tests/evals && npm run eval:harness-smoke`

Expected: PASS with Promptfoo invoking the OpenCode provider through materialized config.

- [ ] **Step 4: Run smoke discovery**

Run: `cd tests/evals && npm run eval:smoke`

Expected: PASS or real scenario failures only; no unresolved config/provider errors and no artifact guard failures.

## Task 7: Prepare For Extraction After Second Consumer

**Files:**

- Create: `docs/plans/2026-05-03-shared-eval-harness-framework-extraction-notes.md`

- [ ] **Step 1: Record package boundary after Skill Builder passes**

Create the extraction notes file with:

```md
# Shared Eval Harness Extraction Notes

## Framework-Owned
- `bin/ad-evals.js`
- `scripts/framework/**`
- model/tier schema and validation
- Promptfoo/OpenCode state export
- config materialization
- artifact guard
- package discovery
- framework contract tests

## Project-Owned
- `packages/**`
- `prompts/**`
- `fixtures/**`
- domain assertion files
- project-specific scenario inventory
- optional package-specific npm aliases

## Second Consumer Checklist
- Port `migration-utility` without changing its package YAML semantics.
- Confirm git-common-dir state export works across its worktrees.
- Confirm targeted `-o <json>` diagnostics still work.
- Port `engineering-skills` after removing package-local provider/model wiring.
```

- [ ] **Step 2: Commit the Skill Builder internal-framework proof**

Run:

```bash
git add tests/evals scripts/worktree.sh TEST_MAP.md repo-map.json docs/plans/2026-05-03-shared-eval-harness-framework.md docs/plans/2026-05-03-shared-eval-harness-framework-extraction-notes.md
git commit -m "test: package eval harness framework internally"
```

Expected: commit succeeds without including unrelated worktree changes.

## Verification Commands

Run before reporting implementation complete:

```bash
cd tests/evals && npm test
cd tests/evals && npm run doctor
cd tests/evals && npm run eval:harness-smoke
cd tests/evals && npm run eval:smoke
```

If `eval:smoke` has behavior failures, export JSON output for failing packages and report scenario-level failures separately from framework failures.

## Self-Review

- Spec coverage: Covers model/tier framework ownership, project-local YAML/prompts/fixtures, export-only Promptfoo state resolution, worktree decoupling, and extract-after-two-consumers sequence.
- Placeholder scan: No TODO/TBD placeholders are present.
- Type consistency: `resolveHarnessPaths`, `buildHarnessEnv`, `discoverPackageConfigs`, `buildPromptfooArgs`, and CLI command names are used consistently across tasks.
