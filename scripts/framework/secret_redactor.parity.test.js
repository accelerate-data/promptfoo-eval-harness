'use strict';

/**
 * Parity test — asserts that Node (secret_redactor.js) and Python
 * (_secret_redactor.py) produce byte-identical redacted output for every
 * pattern in config/redaction-patterns.json.
 *
 * Each test case constructs a synthetic input string that contains a known
 * match for the pattern, runs it through both implementations, and asserts
 * equality.
 */

const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { redact } = require('./secret_redactor');

const PYTHON_SCRIPT = path.resolve(__dirname, 'providers/_secret_redactor.py');

// Map of pattern name → synthetic match string that will trigger the pattern.
// We test with the full context string so both engines see the same input.
const PATTERN_SAMPLES = {
  anthropic_api_key: 'key=sk-ant-api03-' + 'A'.repeat(40) + '1234567890AB',
  openai_api_key: 'Authorization: sk-proj-' + 'A'.repeat(40) + '1234567890AB',
  openhands_api_key: 'token=oh-' + 'a'.repeat(40),
  aws_access_key_id: 'id=AKIAIOSFODNN7EXAMPLE',
  // AWS secret: 40-char base64 token bounded by non-base64 chars (space and colon)
  aws_secret_access_key: 'secret:' + 'A'.repeat(38) + 'z+' + ':end',
  github_pat: 'token=ghp_' + 'A'.repeat(36),
  bearer_token: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload',
  // GCP: include the full private_key JSON field
  gcp_service_account_json_snippet:
    '"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEv\\n-----END PRIVATE KEY-----\\n"',
};

function runPython(input) {
  // Pass the input as a JSON string so the Python CLI can round-trip it.
  const result = spawnSync(
    'python3',
    [PYTHON_SCRIPT, input],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Python redactor exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

for (const [name, sample] of Object.entries(PATTERN_SAMPLES)) {
  test(`parity: ${name} — Node and Python produce identical redaction`, () => {
    const nodeOut = redact(sample);
    const pyOut = runPython(sample);
    assert.equal(
      nodeOut,
      pyOut,
      `Pattern "${name}" diverged:\n  Node: ${nodeOut}\n  Python: ${pyOut}`,
    );
    // Also assert that the sample was actually redacted (not a false-negative parity)
    assert.notEqual(nodeOut, sample, `Pattern "${name}" was NOT redacted by either engine`);
  });
}
