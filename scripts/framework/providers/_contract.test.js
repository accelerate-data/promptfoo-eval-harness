'use strict';

/**
 * Parity test for provider contract files (spec §1.2, §8.2).
 *
 * Strategy: no Python parser, no TS compiler — just regex over source text.
 * - Parse docs/provider-contract.md parity table for ground truth.
 * - Scan _contract.py for Python class field declarations.
 * - Scan _contract.ts for TypeScript interface field declarations.
 * - Assert every table row exists in BOTH source files.
 * - Assert no extra fields in either source file that are not in the table.
 *
 * This is deliberately dumb: readable, fast, zero dependencies.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS_DIR = __dirname;
const DOCS_DIR = path.join(PROVIDERS_DIR, '..', '..', '..', 'docs');

const PY_CONTRACT = path.join(PROVIDERS_DIR, '_contract.py');
const TS_CONTRACT = path.join(PROVIDERS_DIR, '_contract.ts');
const MD_CONTRACT = path.join(DOCS_DIR, 'provider-contract.md');

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse the parity table from provider-contract.md.
 * Returns an array of { type, field } objects for each data row.
 * Table section is bounded by <!-- parity-table-start --> / <!-- parity-table-end --> comments.
 */
function parseMdTable(src) {
  const startMarker = '<!-- parity-table-start -->';
  const endMarker = '<!-- parity-table-end -->';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  assert.ok(start >= 0, 'provider-contract.md must contain <!-- parity-table-start -->');
  assert.ok(end > start, 'provider-contract.md must contain <!-- parity-table-end --> after start');

  const tableSection = src.slice(start + startMarker.length, end);
  const rows = [];

  for (const line of tableSection.split('\n')) {
    // Skip header, separator, and empty lines
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || trimmed.startsWith('|---') || trimmed.startsWith('| Type')) {
      continue;
    }
    // | Type | Field | ... |
    const cols = trimmed.split('|').map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2) {
      rows.push({ type: cols[0], field: cols[1] });
    }
  }

  return rows;
}

/**
 * Extract field names declared inside Python dataclasses from _contract.py source.
 * Strategy: look for lines matching `    fieldname: type` or `    fieldname: type = ...`
 * inside class bodies. Returns a Set of "ClassName.fieldname" strings.
 *
 * We deliberately skip Protocol methods (def lines) and class-level comments.
 */
function parsePyFields(src) {
  const fields = new Set();
  let currentClass = null;

  for (const line of src.split('\n')) {
    // Detect class definition
    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch) {
      currentClass = classMatch[1];
      continue;
    }

    // Detect end of class body (next top-level definition)
    if (currentClass && /^[^\s#]/.test(line) && !line.startsWith('class ')) {
      currentClass = null;
    }

    if (!currentClass) continue;

    // Field declaration: 4-space indent, identifier, colon
    // e.g.: `    provider_kind: str  # ...`
    // e.g.: `    extra: dict[str, Any] = field(default_factory=dict)`
    const fieldMatch = line.match(/^\s{4}(\w+)\s*:/);
    if (fieldMatch) {
      const name = fieldMatch[1];
      // Skip dunder fields and method bodies that start with 'self'
      if (!name.startsWith('_') && name !== 'self') {
        fields.add(`${currentClass}.${name}`);
      }
    }
  }

  return fields;
}

/**
 * Extract field names declared inside TypeScript interfaces from _contract.ts source.
 * Strategy: look for lines matching `  fieldname:` or `  fieldname?:` inside interface bodies.
 * Returns a Set of "InterfaceName.fieldname" strings.
 */
function parseTsFields(src) {
  const fields = new Set();
  let currentInterface = null;

  for (const line of src.split('\n')) {
    // Detect interface definition
    const ifaceMatch = line.match(/^export\s+interface\s+(\w+)/);
    if (ifaceMatch) {
      currentInterface = ifaceMatch[1];
      continue;
    }

    // Detect closing brace at top level (end of interface)
    if (currentInterface && /^\}/.test(line)) {
      currentInterface = null;
      continue;
    }

    if (!currentInterface) continue;

    // Field declaration: 2-space indent, identifier (optional ?), colon
    // e.g.: `  provider_kind: string;`
    // e.g.: `  error?: ProviderError;`
    const fieldMatch = line.match(/^\s{2}(\w+)\??:/);
    if (fieldMatch) {
      const name = fieldMatch[1];
      if (!name.startsWith('_')) {
        fields.add(`${currentInterface}.${name}`);
      }
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provider contract parity', () => {
  const pySource = fs.readFileSync(PY_CONTRACT, 'utf8');
  const tsSource = fs.readFileSync(TS_CONTRACT, 'utf8');
  const mdSource = fs.readFileSync(MD_CONTRACT, 'utf8');

  const tableRows = parseMdTable(mdSource);
  const pyFields = parsePyFields(pySource);
  const tsFields = parseTsFields(tsSource);

  test('parity table has at least one row', () => {
    assert.ok(tableRows.length > 0, 'parity table must have at least one data row');
  });

  test('every parity table row exists in _contract.py', () => {
    const missing = [];
    for (const { type, field } of tableRows) {
      const key = `${type}.${field}`;
      if (!pyFields.has(key)) {
        missing.push(key);
      }
    }
    assert.deepStrictEqual(
      missing,
      [],
      `Fields in parity table missing from _contract.py:\n  ${missing.join('\n  ')}`,
    );
  });

  test('every parity table row exists in _contract.ts', () => {
    const missing = [];
    for (const { type, field } of tableRows) {
      const key = `${type}.${field}`;
      if (!tsFields.has(key)) {
        missing.push(key);
      }
    }
    assert.deepStrictEqual(
      missing,
      [],
      `Fields in parity table missing from _contract.ts:\n  ${missing.join('\n  ')}`,
    );
  });

  test('no extra fields in _contract.py that are absent from the parity table', () => {
    const tableKeys = new Set(tableRows.map(({ type, field }) => `${type}.${field}`));
    // Only check dataclass types listed in the table (skip Protocol / alias lines)
    const tableTypes = new Set(tableRows.map(({ type }) => type));
    const extra = [];
    for (const key of pyFields) {
      const typeName = key.split('.')[0];
      if (tableTypes.has(typeName) && !tableKeys.has(key)) {
        extra.push(key);
      }
    }
    assert.deepStrictEqual(
      extra,
      [],
      `_contract.py has fields not in parity table:\n  ${extra.join('\n  ')}\n` +
        'Add them to docs/provider-contract.md or remove from _contract.py.',
    );
  });

  test('no extra fields in _contract.ts that are absent from the parity table', () => {
    const tableKeys = new Set(tableRows.map(({ type, field }) => `${type}.${field}`));
    const tableTypes = new Set(tableRows.map(({ type }) => type));
    const extra = [];
    for (const key of tsFields) {
      const typeName = key.split('.')[0];
      if (tableTypes.has(typeName) && !tableKeys.has(key)) {
        extra.push(key);
      }
    }
    assert.deepStrictEqual(
      extra,
      [],
      `_contract.ts has fields not in parity table:\n  ${extra.join('\n  ')}\n` +
        'Add them to docs/provider-contract.md or remove from _contract.ts.',
    );
  });

  test('parity table covers all expected contract types', () => {
    const tableTypes = new Set(tableRows.map(({ type }) => type));
    const expectedTypes = ['ProviderConfig', 'ToolCallRecord', 'ProviderError', 'TurnResult', 'FinalResult'];
    const missing = expectedTypes.filter((t) => !tableTypes.has(t));
    assert.deepStrictEqual(missing, [], `parity table missing types: ${missing.join(', ')}`);
  });
});
