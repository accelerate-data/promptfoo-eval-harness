'use strict';

/**
 * readme-provider-matrix.test.js — Layer 1 parity test (H.34).
 *
 * Asserts that the README "## Providers" table and KIND_REGISTRY in
 * _node_bridge.js are in sync. Catches drift when a new SDK lands
 * without updating the README (or vice versa).
 *
 * Rules:
 *  - Every row in the README Providers table must correspond to a key in
 *    KIND_REGISTRY (stable or planned — both count).
 *  - Every key in KIND_REGISTRY must have a row in the README table.
 *  - Planned kinds (no shipped provider yet) appear in the table but NOT
 *    in KIND_REGISTRY — the test treats a row whose Status column is
 *    "planned" as a README-only entry and does NOT require a registry key.
 *    Conversely, all actual KIND_REGISTRY keys must appear as a row.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, describe } = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const BRIDGE_PATH = path.join(REPO_ROOT, 'scripts', 'framework', '_node_bridge.js');

// ---------------------------------------------------------------------------
// Parse README Providers table
// ---------------------------------------------------------------------------

/**
 * Find the "## Providers" section in README.md and parse the first markdown
 * table inside it. Returns an array of objects keyed by column header.
 *
 * Handles the standard GFM pipe-table format:
 *   | col1 | col2 | ...
 *   | --- | --- | ...
 *   | val1 | val2 | ...
 */
function parseReadmeProviderTable(readmePath) {
  const content = fs.readFileSync(readmePath, 'utf8');
  const lines = content.split('\n');

  // Find the "## Providers" heading.
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Providers\s*$/.test(lines[i])) {
      sectionStart = i;
      break;
    }
  }
  assert.ok(
    sectionStart >= 0,
    'README.md must contain a "## Providers" section for the provider matrix',
  );

  // Find the next table inside this section (before the next ## heading).
  let tableStart = -1;
  let tableEnd = -1;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break; // next section — stop
    if (lines[i].trimStart().startsWith('|') && tableStart === -1) {
      tableStart = i;
    }
    if (tableStart !== -1 && !lines[i].trimStart().startsWith('|')) {
      tableEnd = i;
      break;
    }
  }
  if (tableStart !== -1 && tableEnd === -1) tableEnd = lines.length;

  assert.ok(tableStart >= 0, 'No pipe table found in the "## Providers" section of README.md');

  const tableLines = lines.slice(tableStart, tableEnd).filter((l) => l.trimStart().startsWith('|'));

  // First row = headers, second row = separator (---|---), rest = data.
  const headers = tableLines[0]
    .split('|')
    .map((h) => h.trim())
    .filter(Boolean);

  const rows = [];
  for (let i = 2; i < tableLines.length; i++) {
    const cells = tableLines[i]
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length === 0) continue;
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Extract KIND_REGISTRY keys from _node_bridge.js
// ---------------------------------------------------------------------------

/**
 * Load the bridge module and read its exported _KIND_REGISTRY map.
 * The bridge exports `makeBridge._KIND_REGISTRY = KIND_REGISTRY` at the bottom.
 */
function loadKindRegistry() {
  // The bridge attaches KIND_REGISTRY to the exported function.
  const bridge = require(BRIDGE_PATH);
  const registry = bridge._KIND_REGISTRY;
  assert.ok(
    registry && typeof registry === 'object',
    '_node_bridge.js must export _KIND_REGISTRY via makeBridge._KIND_REGISTRY',
  );
  return Object.keys(registry);
}

// ---------------------------------------------------------------------------
// Extract provider_kind from README rows
// ---------------------------------------------------------------------------

function extractProviderKind(row) {
  // Column header is "`provider_kind`" with backtick formatting.
  // The cell value is also backtick-wrapped, e.g. "`opencode_cli`".
  const raw = row['`provider_kind`'] || row['provider_kind'] || '';
  return raw.replace(/`/g, '').trim();
}

function extractStatus(row) {
  const raw = row['Status'] || row['status'] || '';
  return raw.toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('README Providers matrix ↔ KIND_REGISTRY parity (H.34)', () => {
  let tableRows;
  let registryKeys;

  test('README has a parseable Providers table', () => {
    tableRows = parseReadmeProviderTable(README_PATH);
    assert.ok(tableRows.length > 0, 'Providers table must have at least one data row');
  });

  test('KIND_REGISTRY is loadable from _node_bridge.js', () => {
    registryKeys = loadKindRegistry();
    assert.ok(registryKeys.length > 0, 'KIND_REGISTRY must have at least one key');
  });

  test('every KIND_REGISTRY key has a row in the README Providers table', () => {
    // Ensure both lookups succeeded.
    if (!tableRows) tableRows = parseReadmeProviderTable(README_PATH);
    if (!registryKeys) registryKeys = loadKindRegistry();

    const readmeKinds = tableRows.map(extractProviderKind);

    for (const key of registryKeys) {
      assert.ok(
        readmeKinds.includes(key),
        `KIND_REGISTRY key "${key}" is missing from the README Providers table. ` +
          `Add a row with provider_kind="${key}" (status=stable or planned).`,
      );
    }
  });

  test('every stable/beta README row has a matching KIND_REGISTRY key', () => {
    if (!tableRows) tableRows = parseReadmeProviderTable(README_PATH);
    if (!registryKeys) registryKeys = loadKindRegistry();

    for (const row of tableRows) {
      const kind = extractProviderKind(row);
      const status = extractStatus(row);
      if (!kind) continue;

      // Planned kinds are not yet in KIND_REGISTRY — that is expected.
      if (status === 'planned') continue;

      assert.ok(
        registryKeys.includes(kind),
        `README Providers row "${kind}" (status=${status}) is not in KIND_REGISTRY. ` +
          `Either add it to KIND_REGISTRY or mark its status as "planned".`,
      );
    }
  });

  test('planned kinds are NOT in KIND_REGISTRY (Phase 1 guard)', () => {
    if (!tableRows) tableRows = parseReadmeProviderTable(README_PATH);
    if (!registryKeys) registryKeys = loadKindRegistry();

    for (const row of tableRows) {
      const kind = extractProviderKind(row);
      const status = extractStatus(row);
      if (!kind || status !== 'planned') continue;

      assert.ok(
        !registryKeys.includes(kind),
        `README Providers row "${kind}" is marked "planned" but already exists in KIND_REGISTRY. ` +
          `Update its status to "stable" (or "beta") in the README.`,
      );
    }
  });
});
