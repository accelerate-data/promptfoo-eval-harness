const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

const SURFACES = [
  { label: 'templates/AGENTS.md', file: path.join(REPO_ROOT, 'templates', 'AGENTS.md') },
  { label: 'README.md', file: path.join(REPO_ROOT, 'README.md') },
  { label: 'docs/setup.md', file: path.join(REPO_ROOT, 'docs', 'setup.md') },
];

const STALE_INVOCATION = /node\s+bin\/ad-evals\.js/;
const CURRENT_INVOCATION = /ad-evals\s+run\s+packages\//;

for (const { label, file } of SURFACES) {
  test(`${label} does not reference the removed node bin/ad-evals.js entrypoint`, () => {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, STALE_INVOCATION,
      `${label} still references the legacy "node bin/ad-evals.js" invocation`);
  });

  test(`${label} documents the supported "ad-evals run packages/..." invocation`, () => {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, CURRENT_INVOCATION,
      `${label} is missing the canonical "ad-evals run packages/..." invocation`);
  });
}
