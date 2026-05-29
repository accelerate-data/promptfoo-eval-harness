'use strict';

/**
 * eval-harness-init.test.js — Tests for bin/eval-harness-init.sh (G.31 + H.36).
 *
 * Verifies scaffold output, --upgrade idempotence, --migrate-from-v0 flag,
 * and H.36 dependabot template drop logic.
 * Runs the actual shell script against tmp consumer repos.
 */

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');

const HARNESS_ROOT = path.resolve(__dirname, '..');
const INIT_SCRIPT = path.join(HARNESS_ROOT, 'bin', 'eval-harness-init.sh');
const V0_FIXTURE = path.join(HARNESS_ROOT, 'tests', 'fixtures', 'v0-legacy-tier.toml');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpConsumer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-test-'));
  // Initialise a minimal git repo so eval-harness-init can find REPO_ROOT.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function runInit(consumerDir, extraArgs = []) {
  const result = spawnSync(
    'bash',
    [INIT_SCRIPT, '--no-install', ...extraArgs],
    { cwd: consumerDir, encoding: 'utf8', env: process.env },
  );
  return result;
}

// ---------------------------------------------------------------------------
// Fresh init
// ---------------------------------------------------------------------------

describe('eval-harness-init fresh scaffold (G.31)', () => {
  let consumerDir;

  before(() => { consumerDir = makeTmpConsumer(); });
  after(() => rmDir(consumerDir));

  test('exits 0', () => {
    const result = runInit(consumerDir);
    assert.equal(result.status, 0, result.stderr);
  });

  test('creates tests/harness-scenarios/packages/index.json', () => {
    const idx = path.join(consumerDir, 'tests', 'harness-scenarios', 'packages', 'index.json');
    assert.ok(fs.existsSync(idx), 'index.json should exist');
    const parsed = JSON.parse(fs.readFileSync(idx, 'utf8'));
    assert.ok(Array.isArray(parsed.scenarios), 'scenarios should be an array');
  });

  test('creates tests/evals/.tmp/workspaces/.gitkeep', () => {
    const keep = path.join(consumerDir, 'tests', 'evals', '.tmp', 'workspaces', '.gitkeep');
    assert.ok(fs.existsSync(keep), '.gitkeep should exist');
  });

  test('appends tests/evals/.tmp/ to repo .gitignore', () => {
    const gi = path.join(consumerDir, '.gitignore');
    assert.ok(fs.existsSync(gi));
    const content = fs.readFileSync(gi, 'utf8');
    assert.ok(content.includes('tests/evals/.tmp/'), '.gitignore should contain tests/evals/.tmp/');
  });

  test('creates config/sdk-pins.toml', () => {
    const pins = path.join(consumerDir, 'config', 'sdk-pins.toml');
    assert.ok(fs.existsSync(pins), 'sdk-pins.toml should exist');
    const content = fs.readFileSync(pins, 'utf8');
    assert.ok(content.includes('[openhands_sdk]'), 'sdk-pins.toml should have openhands_sdk section');
  });
});

// ---------------------------------------------------------------------------
// --upgrade idempotence
// ---------------------------------------------------------------------------

describe('eval-harness-init --upgrade idempotence (G.31)', () => {
  let consumerDir;

  before(() => {
    consumerDir = makeTmpConsumer();
    // First init.
    const r = runInit(consumerDir);
    assert.equal(r.status, 0, `first init failed:\n${r.stderr}`);
  });

  after(() => rmDir(consumerDir));

  test('--upgrade exits 0', () => {
    const result = runInit(consumerDir, ['--upgrade']);
    assert.equal(result.status, 0, result.stderr);
  });

  test('--upgrade does not overwrite existing files (all lines say "skip")', () => {
    const result = runInit(consumerDir, ['--upgrade']);
    const lines = result.stdout.split('\n').filter((l) => l.trim().startsWith('copy '));
    // No "copy" lines — only "skip" lines for existing files.
    assert.equal(lines.length, 0, `unexpected copy lines:\n${lines.join('\n')}`);
  });

  test('--upgrade is idempotent for index.json (file unchanged)', () => {
    const idx = path.join(consumerDir, 'tests', 'harness-scenarios', 'packages', 'index.json');
    const before = fs.readFileSync(idx, 'utf8');
    runInit(consumerDir, ['--upgrade']);
    const after = fs.readFileSync(idx, 'utf8');
    assert.equal(before, after, 'index.json should be byte-identical after second run');
  });

  test('--upgrade is idempotent for .gitignore (no duplicate entry)', () => {
    runInit(consumerDir, ['--upgrade']);
    const gi = path.join(consumerDir, '.gitignore');
    const content = fs.readFileSync(gi, 'utf8');
    const count = (content.match(/tests\/evals\/\.tmp\//g) || []).length;
    assert.equal(count, 1, `.gitignore should have exactly 1 tests/evals/.tmp/ entry, found ${count}`);
  });
});

// ---------------------------------------------------------------------------
// --migrate-from-v0 requires --upgrade
// ---------------------------------------------------------------------------

describe('eval-harness-init flag validation', () => {
  let consumerDir;

  before(() => { consumerDir = makeTmpConsumer(); });
  after(() => rmDir(consumerDir));

  test('--migrate-from-v0 without --upgrade exits non-zero', () => {
    const result = runInit(consumerDir, ['--migrate-from-v0']);
    assert.notEqual(result.status, 0, 'should fail when --upgrade is not set');
    assert.ok(result.stderr.includes('--migrate-from-v0 requires --upgrade'), result.stderr);
  });
});

// ---------------------------------------------------------------------------
// --upgrade --migrate-from-v0
// ---------------------------------------------------------------------------

describe('eval-harness-init --upgrade --migrate-from-v0 (G.29 wiring)', () => {
  let consumerDir;

  before(() => {
    consumerDir = makeTmpConsumer();
    // First init to scaffold the structure.
    runInit(consumerDir);
    // Replace the scaffolded eval-tiers.toml with a v0 fixture.
    const dest = path.join(consumerDir, 'tests', 'evals', 'config', 'eval-tiers.toml');
    fs.copyFileSync(V0_FIXTURE, dest);
  });

  after(() => rmDir(consumerDir));

  test('exits 0', () => {
    const result = runInit(consumerDir, ['--upgrade', '--migrate-from-v0']);
    assert.equal(result.status, 0, result.stderr);
  });

  test('rewrites eval-tiers.toml to v1 shape in place', () => {
    const dest = path.join(consumerDir, 'tests', 'evals', 'config', 'eval-tiers.toml');
    const { parse } = require('smol-toml');
    const raw = parse(fs.readFileSync(dest, 'utf8'));
    assert.equal(raw.version, 'v1', 'config should be v1 after migration');
    assert.ok(Array.isArray(raw.tiers.light.providers), 'tiers.light.providers should be an array');
  });

  test('re-running is idempotent (second run exits 0, file unchanged)', () => {
    const dest = path.join(consumerDir, 'tests', 'evals', 'config', 'eval-tiers.toml');
    const before = fs.readFileSync(dest, 'utf8');
    const result = runInit(consumerDir, ['--upgrade', '--migrate-from-v0']);
    assert.equal(result.status, 0, result.stderr);
    const after = fs.readFileSync(dest, 'utf8');
    assert.equal(before, after, 'file should be byte-identical on second migration run');
  });
});

// ---------------------------------------------------------------------------
// H.36 — Consumer dependabot template drop logic
// ---------------------------------------------------------------------------

describe('eval-harness-init dependabot template drop — no existing file (H.36)', () => {
  let consumerDir;

  before(() => {
    consumerDir = makeTmpConsumer();
    // Fresh init: consumer has no .github/dependabot.yml
    const result = runInit(consumerDir);
    assert.equal(result.status, 0, result.stderr);
  });

  after(() => rmDir(consumerDir));

  test('materializes .github/dependabot.yml', () => {
    const dep = path.join(consumerDir, '.github', 'dependabot.yml');
    assert.ok(fs.existsSync(dep), '.github/dependabot.yml should be created');
  });

  test('materialized file contains package-ecosystem: npm', () => {
    const dep = path.join(consumerDir, '.github', 'dependabot.yml');
    const content = fs.readFileSync(dep, 'utf8');
    assert.ok(content.includes('package-ecosystem: npm'), 'should contain npm ecosystem');
  });

  test('materialized file contains package-ecosystem: github-actions', () => {
    const dep = path.join(consumerDir, '.github', 'dependabot.yml');
    const content = fs.readFileSync(dep, 'utf8');
    assert.ok(content.includes('package-ecosystem: github-actions'), 'should contain github-actions ecosystem');
  });

  test('materialized file does NOT contain package-ecosystem: pip (spec §6.4 + §6.6)', () => {
    const dep = path.join(consumerDir, '.github', 'dependabot.yml');
    const content = fs.readFileSync(dep, 'utf8');
    assert.ok(!content.includes('package-ecosystem: pip'), 'consumer template must NOT watch PyPI');
  });

  test('does NOT create .github/dependabot.harness.example.yml', () => {
    const example = path.join(consumerDir, '.github', 'dependabot.harness.example.yml');
    assert.ok(!fs.existsSync(example), 'example file should not exist when no conflict');
  });
});

describe('eval-harness-init dependabot template drop — existing file (H.36)', () => {
  let consumerDir;

  before(() => {
    consumerDir = makeTmpConsumer();
    // Pre-create a .github/dependabot.yml to simulate an existing consumer config.
    const githubDir = path.join(consumerDir, '.github');
    fs.mkdirSync(githubDir, { recursive: true });
    fs.writeFileSync(
      path.join(githubDir, 'dependabot.yml'),
      'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: monthly\n',
    );
    const result = runInit(consumerDir);
    assert.equal(result.status, 0, result.stderr);
  });

  after(() => rmDir(consumerDir));

  test('does NOT overwrite existing .github/dependabot.yml', () => {
    const dep = path.join(consumerDir, '.github', 'dependabot.yml');
    const content = fs.readFileSync(dep, 'utf8');
    // Original file had "monthly"; harness template uses "weekly" — original must survive.
    assert.ok(content.includes('interval: monthly'), 'original dependabot.yml must not be overwritten');
  });

  test('drops .github/dependabot.harness.example.yml', () => {
    const example = path.join(consumerDir, '.github', 'dependabot.harness.example.yml');
    assert.ok(fs.existsSync(example), 'example file should be dropped next to existing dependabot.yml');
  });

  test('example file contains package-ecosystem: npm', () => {
    const example = path.join(consumerDir, '.github', 'dependabot.harness.example.yml');
    const content = fs.readFileSync(example, 'utf8');
    assert.ok(content.includes('package-ecosystem: npm'), 'example should contain npm ecosystem');
  });

  test('example file contains package-ecosystem: github-actions', () => {
    const example = path.join(consumerDir, '.github', 'dependabot.harness.example.yml');
    const content = fs.readFileSync(example, 'utf8');
    assert.ok(content.includes('package-ecosystem: github-actions'), 'example should contain github-actions ecosystem');
  });

  test('example file does NOT contain package-ecosystem: pip (spec §6.4 + §6.6)', () => {
    const example = path.join(consumerDir, '.github', 'dependabot.harness.example.yml');
    const content = fs.readFileSync(example, 'utf8');
    assert.ok(!content.includes('package-ecosystem: pip'), 'example consumer template must NOT watch PyPI');
  });

  test('prints a notice about the existing file', () => {
    // Re-run to capture stdout; prior before() already ran init but we need output.
    const result = runInit(consumerDir);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes('dependabot.harness.example.yml') ||
      result.stdout.includes('Manually merge') ||
      result.stdout.includes('notice'),
      `expected a notice about dependabot conflict in stdout:\n${result.stdout}`,
    );
  });
});
