'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redact, redactPatternNames } = require('./secret_redactor');

// ---------------------------------------------------------------------------
// Per-pattern positive match tests
// ---------------------------------------------------------------------------

test('redact: anthropic_api_key replaced', () => {
  const input = 'key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567890AB';
  const out = redact(input);
  assert.ok(!out.includes('sk-ant-'), `expected redaction, got: ${out}`);
  assert.ok(out.includes('<redacted-anthropic-api-key>'));
});

test('redact: openai_api_key replaced (proj prefix)', () => {
  const input = 'Authorization: sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567890AB';
  const out = redact(input);
  assert.ok(!out.includes('sk-proj-'), `expected redaction, got: ${out}`);
  assert.ok(out.includes('<redacted-openai-api-key>'));
});

test('redact: openai_api_key replaced (bare sk-)', () => {
  const input = 'key=sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567890ABCD';
  const out = redact(input);
  assert.ok(!out.includes('sk-AAAA'), `expected redaction, got: ${out}`);
  assert.ok(out.includes('<redacted-openai-api-key>'));
});

test('redact: anthropic key NOT matched as openai key', () => {
  const input = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567890AB';
  const out = redact(input);
  assert.ok(out.includes('<redacted-anthropic-api-key>'));
  assert.ok(!out.includes('<redacted-openai-api-key>'));
});

test('redact: openhands_api_key replaced', () => {
  const input = 'token=oh-' + 'a'.repeat(40);
  const out = redact(input);
  assert.ok(!out.includes('oh-' + 'a'.repeat(40)));
  assert.ok(out.includes('<redacted-openhands-api-key>'));
});

test('redact: aws_access_key_id replaced', () => {
  const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
  const out = redact(input);
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(out.includes('<redacted-aws-access-key>'));
});

test('redact: github_pat replaced (ghp_ prefix)', () => {
  const input = 'token=ghp_' + 'A'.repeat(36);
  const out = redact(input);
  assert.ok(!out.includes('ghp_'));
  assert.ok(out.includes('<redacted-github-pat>'));
});

test('redact: github_pat replaced (ghs_ prefix)', () => {
  const input = 'token=ghs_' + 'A'.repeat(36);
  const out = redact(input);
  assert.ok(!out.includes('ghs_'));
  assert.ok(out.includes('<redacted-github-pat>'));
});

test('redact: bearer_token replaced preserving Bearer prefix', () => {
  const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.some-payload';
  const out = redact(input);
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert.ok(out.includes('Bearer <redacted-bearer-token>'));
});

test('redact: bearer_token case-insensitive', () => {
  const input = 'authorization: bearer abc123TokenXYZ';
  const out = redact(input);
  assert.ok(out.toLowerCase().includes('bearer <redacted-bearer-token>'));
});

test('redact: gcp service account private key block replaced', () => {
  const input = `{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEvAIBADANBgkqhkiG9w0B\\n-----END PRIVATE KEY-----\\n"}`;
  const out = redact(input);
  assert.ok(!out.includes('BEGIN PRIVATE KEY'));
  assert.ok(out.includes('<redacted-gcp-private-key>'));
});

// ---------------------------------------------------------------------------
// Negative (false-positive guard)
// ---------------------------------------------------------------------------

test('redact: plain text unchanged', () => {
  const input = 'Hello, this is a normal log line with no secrets';
  assert.equal(redact(input), input);
});

// ---------------------------------------------------------------------------
// Multi-pattern combined
// ---------------------------------------------------------------------------

test('redact: multiple keys in one string all redacted', () => {
  const anthropic = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567890AB';
  const ghpat = 'ghp_' + 'B'.repeat(36);
  const bearer = 'Bearer tokenXYZABC123';
  const input = `anthropic=${anthropic} pat=${ghpat} auth=${bearer}`;
  const out = redact(input);
  assert.ok(!out.includes('sk-ant-'));
  assert.ok(!out.includes('ghp_'));
  assert.ok(!out.includes('tokenXYZABC123'));
  assert.ok(out.includes('<redacted-anthropic-api-key>'));
  assert.ok(out.includes('<redacted-github-pat>'));
  assert.ok(out.includes('<redacted-bearer-token>'));
});

// ---------------------------------------------------------------------------
// Object recursion
// ---------------------------------------------------------------------------

test('redact: nested object string leaves all redacted', () => {
  const key = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567890AB';
  const inner = 'Bearer sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB1234567890AB';
  const obj = {
    error: {
      message: `Bearer ${key}`,
      inner: [inner],
    },
  };
  const out = redact(obj);
  assert.ok(!out.error.message.includes('sk-ant-'));
  assert.ok(!out.error.inner[0].includes('sk-ant-'));
  // The anthropic pattern fires first on the value portion, so we get either
  // the anthropic or bearer replacement (not the raw key).
  assert.ok(
    out.error.message.includes('<redacted-anthropic-api-key>') ||
    out.error.message.includes('<redacted-bearer-token>'),
  );
  // Keys are preserved
  assert.ok('error' in out);
  assert.ok('message' in out.error);
  assert.ok('inner' in out.error);
});

test('redact: object keys not redacted', () => {
  const obj = { 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA12345': 'value' };
  const out = redact(obj);
  // Key should be preserved (we only redact values)
  const keys = Object.keys(out);
  assert.equal(keys.length, 1);
  assert.equal(keys[0], 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA12345');
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('redact: empty string returns empty string', () => {
  assert.equal(redact(''), '');
});

test('redact: null returns null', () => {
  assert.equal(redact(null), null);
});

test('redact: undefined returns undefined', () => {
  assert.equal(redact(undefined), undefined);
});

test('redact: number returned as-is', () => {
  assert.equal(redact(42), 42);
});

test('redact: boolean returned as-is', () => {
  assert.equal(redact(true), true);
  assert.equal(redact(false), false);
});

// ---------------------------------------------------------------------------
// Pattern names
// ---------------------------------------------------------------------------

test('redactPatternNames: returns all expected pattern names', () => {
  const names = redactPatternNames();
  assert.ok(names.includes('anthropic_api_key'));
  assert.ok(names.includes('openai_api_key'));
  assert.ok(names.includes('openhands_api_key'));
  assert.ok(names.includes('aws_access_key_id'));
  assert.ok(names.includes('aws_secret_access_key'));
  assert.ok(names.includes('github_pat'));
  assert.ok(names.includes('bearer_token'));
  assert.ok(names.includes('gcp_service_account_json_snippet'));
});
