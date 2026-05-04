const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { discoverPackageConfigs } = require('./package-discovery');

test('discoverPackageConfigs finds package Promptfoo YAML and JSON configs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-packages-'));
  try {
    fs.mkdirSync(path.join(root, 'packages', 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages', 'b'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages', 'c', 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'a', 'promptfooconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'packages', 'b', 'suite.yaml'), '{}');
    fs.writeFileSync(path.join(root, 'packages', 'c', 'promptfooconfig.yml'), '{}');
    fs.writeFileSync(path.join(root, 'packages', 'c', 'fixtures', 'input.json'), '{}');
    fs.writeFileSync(path.join(root, 'packages', 'c', 'vars.json'), '{}');
    fs.writeFileSync(path.join(root, 'packages', 'b', 'notes.txt'), 'ignore');

    assert.deepEqual(discoverPackageConfigs(root), [
      'packages/a/promptfooconfig.json',
      'packages/b/suite.yaml',
      'packages/c/promptfooconfig.yml',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discoverPackageConfigs returns an empty list when packages directory is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-evals-no-packages-'));
  try {
    assert.deepEqual(discoverPackageConfigs(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
