'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ALLOWED_RUNTIME_FIELDS, ALLOWED_TIER_FIELDS } = require('./eval-tier-config');
const { EVAL_ROOT } = require('./roots');

// Wrappers receive cfg merged from [runtime] + [tiers.X] + scenario. Tier
// fields (currently {agent}) are validated by ALLOWED_TIER_FIELDS — they are
// legitimate cfg reads even though they are not in ALLOWED_RUNTIME_FIELDS.
const ALLOWED_CFG_FIELDS = new Set([
  ...ALLOWED_RUNTIME_FIELDS,
  ...ALLOWED_TIER_FIELDS,
]);

// Wrapper provider files port runtime fields onto cfg.<field>. Every cfg.<field>
// they read MUST appear in ALLOWED_RUNTIME_FIELDS so tier-config validation
// keeps consumer YAML honest. New optional fields require a phase-01 allowlist
// bump first; this static scan is the guard rail.
const WRAPPER_FILES = [
  'codex-sdk-provider.js',
  'claude-agent-sdk-provider.js',
  'opencode-cli-plugin-provider.js',
];

// Symbols that look like `cfg.<ident>` in source code but are NOT runtime fields
// (e.g. `cfg.provider_id` shows up as `provider_id` which IS in allowlist;
// destructuring patterns like `cfg = {}` are not match targets). The regex
// already excludes these because they don't follow `cfg.<ident>` shape.
const CFG_FIELD_RE = /\bcfg\.([A-Za-z_][A-Za-z0-9_]*)\b/g;

function stripLineComment(line) {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

function extractCfgFields(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const found = new Set();
  for (const rawLine of src.split('\n')) {
    const line = stripLineComment(rawLine);
    let m;
    CFG_FIELD_RE.lastIndex = 0;
    while ((m = CFG_FIELD_RE.exec(line)) !== null) {
      found.add(m[1]);
    }
  }
  return found;
}

test('Wrapper providers only read cfg.<field>s that pass tier-config validation', () => {
  const offenders = [];
  for (const file of WRAPPER_FILES) {
    const abs = path.join(EVAL_ROOT, 'scripts', 'framework', file);
    const fields = extractCfgFields(abs);
    for (const field of fields) {
      if (!ALLOWED_CFG_FIELDS.has(field)) {
        offenders.push(`${file}: cfg.${field} is not in ALLOWED_RUNTIME_FIELDS or ALLOWED_TIER_FIELDS`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Wrapper providers read fields outside the validated cfg set. Either remove the read or extend phase-01:\n  ${offenders.join('\n  ')}`,
  );
});

test('ALLOWED_RUNTIME_FIELDS exposes the 14 phase-01 optional keys', () => {
  const expectedOptional = [
    'empty_output_retries',
    'agent_id',
    'agent_entrypoint_file',
    'bootstrap_prompt',
    'auto_reply_text',
    'max_auto_replies',
    'idle_turn_stop',
    'plugin_subdirs',
    'opencode_runner_command',
    'opencode_plugin_link_path',
    'model',
    'capture_on_failure',
    'write_run_metadata',
    'load_local_env',
    'opencode_parser_module',
  ];
  for (const key of expectedOptional) {
    assert.ok(
      ALLOWED_RUNTIME_FIELDS.has(key),
      `phase-01 optional key "${key}" missing from ALLOWED_RUNTIME_FIELDS`,
    );
  }
});

test('ALLOWED_RUNTIME_FIELDS preserves the 6 phase-00 required keys', () => {
  for (const key of [
    'provider_id',
    'opencode_config',
    'project_dir',
    'format',
    'log_level',
    'print_logs',
  ]) {
    assert.ok(
      ALLOWED_RUNTIME_FIELDS.has(key),
      `phase-00 required key "${key}" missing from ALLOWED_RUNTIME_FIELDS`,
    );
  }
});
