'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { createLogger } = require('./structured_logger');

// ---------------------------------------------------------------------------
// Helper: capture fs.writeSync(2, ...) calls during a callback.
// ---------------------------------------------------------------------------
function captureStderr(fn) {
  const lines = [];
  const orig = fs.writeSync;
  fs.writeSync = (fd, data) => {
    if (fd === 2) {
      lines.push(data);
      return data.length;
    }
    return orig(fd, data);
  };
  try {
    fn();
  } finally {
    fs.writeSync = orig;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Basic emission tests
// ---------------------------------------------------------------------------

test('logger.info emits exactly one NDJSON line to stderr', () => {
  const logger = createLogger({ run_id: 'r1', case_id: 'c1', provider_kind: 'opencode_cli', model: 'm1' });
  const lines = captureStderr(() => logger.info('hello'));
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'info');
  assert.equal(record.msg, 'hello');
});

test('logger.warn emits level=warn', () => {
  const logger = createLogger({});
  const lines = captureStderr(() => logger.warn('heads up'));
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'warn');
});

test('logger.error emits level=error', () => {
  const logger = createLogger({});
  const lines = captureStderr(() => logger.error('boom'));
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'error');
});

// ---------------------------------------------------------------------------
// Required fields
// ---------------------------------------------------------------------------

test('all 7 required fields present in emitted record', () => {
  const logger = createLogger({
    run_id: 'run-42',
    case_id: 'case-7',
    provider_kind: 'openhands_sdk',
    model: 'claude-3',
  });
  const lines = captureStderr(() => logger.info('check fields'));
  const record = JSON.parse(lines[0]);
  assert.ok('ts' in record, 'ts missing');
  assert.ok('level' in record, 'level missing');
  assert.ok('msg' in record, 'msg missing');
  assert.ok('run_id' in record, 'run_id missing');
  assert.ok('case_id' in record, 'case_id missing');
  assert.ok('provider_kind' in record, 'provider_kind missing');
  assert.ok('model' in record, 'model missing');
});

test('context fields reflect initial context values', () => {
  const logger = createLogger({
    run_id: 'run-42',
    case_id: 'case-7',
    provider_kind: 'openhands_sdk',
    model: 'claude-3',
  });
  const lines = captureStderr(() => logger.info('ctx'));
  const record = JSON.parse(lines[0]);
  assert.equal(record.run_id, 'run-42');
  assert.equal(record.case_id, 'case-7');
  assert.equal(record.provider_kind, 'openhands_sdk');
  assert.equal(record.model, 'claude-3');
});

// ---------------------------------------------------------------------------
// Redaction applied
// ---------------------------------------------------------------------------

test('logger redacts secrets in message before emitting', () => {
  const logger = createLogger({});
  const key = 'sk-ant-api03-' + 'A'.repeat(40) + '1234567890AB';
  const lines = captureStderr(() => logger.info(`key=${key}`));
  const record = JSON.parse(lines[0]);
  assert.ok(!record.msg.includes('sk-ant-'), `key leaked in msg: ${record.msg}`);
  assert.ok(record.msg.includes('<redacted-anthropic-api-key>'));
});

test('logger redacts secrets in extra fields', () => {
  const logger = createLogger({});
  const key = 'sk-ant-api03-' + 'A'.repeat(40) + '1234567890AB';
  const lines = captureStderr(() => logger.info('err', { error_msg: key }));
  const record = JSON.parse(lines[0]);
  assert.ok(!record.error_msg.includes('sk-ant-'));
});

// ---------------------------------------------------------------------------
// Extra field merging
// ---------------------------------------------------------------------------

test('extra fields merge into emitted record', () => {
  const logger = createLogger({});
  const lines = captureStderr(() => logger.info('test', { foo: 'bar', count: 3 }));
  const record = JSON.parse(lines[0]);
  assert.equal(record.foo, 'bar');
  assert.equal(record.count, 3);
});

test('extra=null does not crash', () => {
  const logger = createLogger({});
  assert.doesNotThrow(() => {
    captureStderr(() => logger.info('test', null));
  });
});

test('extra=undefined does not crash', () => {
  const logger = createLogger({});
  assert.doesNotThrow(() => {
    captureStderr(() => logger.info('test'));
  });
});

// ---------------------------------------------------------------------------
// ts field is valid ISO 8601
// ---------------------------------------------------------------------------

test('ts field is valid ISO 8601', () => {
  const logger = createLogger({});
  const lines = captureStderr(() => logger.info('time'));
  const record = JSON.parse(lines[0]);
  const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/;
  assert.match(record.ts, ISO_8601, `ts not ISO 8601: ${record.ts}`);
});

// ---------------------------------------------------------------------------
// Empty / no initial context
// ---------------------------------------------------------------------------

test('logger works with empty initial context (nulls for required fields)', () => {
  const logger = createLogger();
  const lines = captureStderr(() => logger.info('minimal'));
  const record = JSON.parse(lines[0]);
  assert.equal(record.run_id, null);
  assert.equal(record.case_id, null);
  assert.equal(record.provider_kind, null);
  assert.equal(record.model, null);
});
