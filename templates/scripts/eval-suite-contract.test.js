// Generic contract tests every consumer eval suite should pass.
// Add project-specific assertions in a separate test file alongside this one.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');

const EVAL_ROOT = path.resolve(__dirname, '..');
const PACKAGE_ROOT = path.join(EVAL_ROOT, 'packages');
const ALLOWED_TIERS = new Set(['light', 'standard', 'high', 'x_high']);

function collectPackageConfigs(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const configs = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      configs.push(...collectPackageConfigs(entryPath));
      continue;
    }
    if (
      entry.isFile()
      && /^(promptfooconfig|suite)\.(json|ya?ml)$/.test(entry.name)
    ) {
      configs.push(path.relative(EVAL_ROOT, entryPath));
    }
  }
  return configs.sort();
}

function readConfig(relativePath) {
  return yaml.load(fs.readFileSync(path.join(EVAL_ROOT, relativePath), 'utf8'));
}

test('every package config declares a supported metadata.eval_tier', () => {
  const configs = collectPackageConfigs(PACKAGE_ROOT);
  assert.ok(configs.length > 0, 'expected at least one package config');
  for (const relativePath of configs) {
    const parsed = readConfig(relativePath);
    assert.ok(parsed?.metadata, `${relativePath} must define metadata`);
    assert.ok(parsed.metadata.eval_tier, `${relativePath} must define metadata.eval_tier`);
    assert.ok(
      ALLOWED_TIERS.has(parsed.metadata.eval_tier),
      `${relativePath} has unsupported eval tier: ${parsed.metadata.eval_tier}`,
    );
  }
});

test('package configs do not declare package-local providers', () => {
  for (const relativePath of collectPackageConfigs(PACKAGE_ROOT)) {
    const parsed = readConfig(relativePath);
    assert.equal(
      Object.prototype.hasOwnProperty.call(parsed, 'providers'),
      false,
      `${relativePath} must receive providers from the framework, not declare them locally`,
    );
  }
});

test('every package has exactly one [smoke] scenario', () => {
  for (const relativePath of collectPackageConfigs(PACKAGE_ROOT)) {
    const parsed = readConfig(relativePath);
    const smokeTests = (parsed.tests || []).filter(
      (entry) => typeof entry.description === 'string'
        && entry.description.startsWith('[smoke]'),
    );
    assert.equal(
      smokeTests.length,
      1,
      `${relativePath} must define exactly one [smoke] scenario`,
    );
  }
});
