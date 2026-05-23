'use strict';

/**
 * migrate-from-v0.js — in-place v0 → v1 TOML rewriter (spec §6.6, G.29).
 *
 * Usage as library:
 *   const { migrate } = require('./migrate-from-v0');
 *   const { changed, diff, warnings } = await migrate('/path/to/eval-tiers.toml');
 *
 * Usage as CLI (prints diff + writes in-place):
 *   node scripts/framework/migrate-from-v0.js config/eval-tiers.toml
 *
 * Rules:
 * - v0 shape: has [tiers.X] with `agent = "..."` keys (no providers array).
 * - v1 shape: has version = "v1" OR tiers with [[tiers.X.providers]] arrays.
 * - Already-v1 → no-op, returns { changed: false, warnings: ['already-v1'] }.
 * - In-place rewrite: NO shadow file (.v1 or similar).
 * - Idempotent: re-running on v1 output is a no-op.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parse, stringify } = require('smol-toml');

// ---------------------------------------------------------------------------
// V0/V1 detection helpers (mirrors eval-tier-config.js logic but for raw TOML)
// ---------------------------------------------------------------------------

function _isV1(raw) {
  if (raw.version === 'v1') return true;
  if (!raw.tiers || typeof raw.tiers !== 'object') return false;
  return Object.values(raw.tiers).some(
    (t) => t && Array.isArray(t.providers),
  );
}

function _isV0(raw) {
  if (!raw.tiers || typeof raw.tiers !== 'object') return false;
  return Object.values(raw.tiers).some(
    (t) => t && typeof t.agent === 'string',
  );
}

// ---------------------------------------------------------------------------
// V0 → V1 transformation
// ---------------------------------------------------------------------------

/**
 * Build a v1-shaped object from a v0 raw config.
 * Preserves any runtime fields; injects provider_kind = "opencode_cli".
 *
 * @param {object} raw - Deserialized v0 TOML.
 * @returns {object} v1-shaped object suitable for smol-toml stringify.
 */
function _buildV1(raw) {
  const out = { version: 'v1' };

  // Build tiers section.
  const tiers = {};
  for (const [tierName, tier] of Object.entries(raw.tiers || {})) {
    if (!tier || typeof tier.agent !== 'string') {
      throw new Error(
        `migrate-from-v0: tier "${tierName}" is missing a valid agent field`,
      );
    }
    tiers[tierName] = {
      providers: [
        {
          provider_kind: 'opencode_cli',
          label: tier.agent,
          // Preserve model/agent_config from runtime if present.
          ...(raw.runtime && raw.runtime.opencode_config
            ? { agent_config: raw.runtime.opencode_config }
            : {}),
        },
      ],
    };
  }
  out.tiers = tiers;

  // Preserve concurrency if present.
  if (raw.concurrency && typeof raw.concurrency === 'object') {
    out.concurrency = raw.concurrency;
  }

  // Drop the legacy [runtime] block — v1 does not use it.
  // (Consumers can add runtime fields at the tier level if needed.)
  return out;
}

// ---------------------------------------------------------------------------
// Minimal unified diff (no external dep)
// ---------------------------------------------------------------------------

/**
 * Produce a minimal unified diff string between two text strings.
 *
 * @param {string} before - Original text.
 * @param {string} after - New text.
 * @param {string} [label] - File label for the diff header.
 * @returns {string} Unified diff (empty string if no change).
 */
function _unifiedDiff(before, after, label = 'eval-tiers.toml') {
  if (before === after) return '';

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const lines = [];
  lines.push(`--- a/${label}`);
  lines.push(`+++ b/${label}`);

  // Simple line-by-line diff without LCS (sufficient for config files).
  const beforeSet = new Map(beforeLines.map((l, i) => [i, l]));
  const afterSet = new Map(afterLines.map((l, i) => [i, l]));

  // Use a naive approach: emit a single hunk showing the full diff.
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  lines.push(`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`);
  for (let i = 0; i < beforeLines.length; i++) {
    lines.push(`-${beforeLines[i]}`);
  }
  for (let i = 0; i < afterLines.length; i++) {
    lines.push(`+${afterLines[i]}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate a v0 eval-tiers.toml to v1 in place.
 *
 * @param {string} tierConfigPath - Absolute or relative path to the TOML file.
 * @returns {Promise<{changed: boolean, diff: string, warnings: string[]}>}
 */
async function migrate(tierConfigPath) {
  const absPath = path.resolve(tierConfigPath);

  let source;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    throw new Error(`migrate-from-v0: cannot read ${absPath}: ${err.message}`);
  }

  let raw;
  try {
    raw = parse(source);
  } catch (err) {
    throw new Error(`migrate-from-v0: failed to parse TOML at ${absPath}: ${err.message}`);
  }

  // Already v1 — idempotent no-op.
  if (_isV1(raw)) {
    return { changed: false, diff: '', warnings: ['already-v1'] };
  }

  if (!_isV0(raw)) {
    throw new Error(
      `migrate-from-v0: cannot determine config version at ${absPath}. ` +
      'Expected v0 shape (tiers.<name>.agent) or v1 shape (version="v1" or providers array).',
    );
  }

  const v1 = _buildV1(raw);

  // Serialize back to TOML.
  let newSource;
  try {
    newSource = stringify(v1);
  } catch (err) {
    throw new Error(`migrate-from-v0: failed to serialize v1 TOML: ${err.message}`);
  }

  const label = path.relative(process.cwd(), absPath) || path.basename(absPath);
  const diff = _unifiedDiff(source, newSource, label);

  // Print diff before writing (spec §6.6 — diff is printed to stdout).
  if (diff) {
    process.stdout.write(diff + '\n');
  }

  fs.writeFileSync(absPath, newSource, 'utf8');

  return { changed: true, diff, warnings: [] };
}

module.exports = { migrate, _buildV1, _isV1, _isV0 };

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const [, , configPath] = process.argv;
  if (!configPath) {
    console.error('Usage: node scripts/framework/migrate-from-v0.js <path/to/eval-tiers.toml>');
    process.exit(2);
  }

  migrate(configPath).then(
    ({ changed, warnings }) => {
      if (!changed) {
        console.error(`migrate-from-v0: ${warnings.join(', ')} — no changes written`);
      } else {
        console.error(`migrate-from-v0: migration applied to ${configPath}`);
      }
      process.exit(0);
    },
    (err) => {
      console.error(`migrate-from-v0: ${err.message}`);
      process.exit(1);
    },
  );
}
