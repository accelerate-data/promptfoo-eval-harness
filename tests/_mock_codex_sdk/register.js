'use strict';

/**
 * Phase 12 — Module._resolveFilename hook that swaps `@openai/codex-sdk`
 * for the local CJS mock (tests/_mock_codex_sdk/index.js).
 *
 * Invoked via:
 *
 *   node --require ./tests/_mock_codex_sdk/register.js <script>
 *
 * The codex_sdk provider does `require('@openai/codex-sdk')` lazily inside
 * the create() factory; this hook intercepts the resolve so the real package
 * does not need to be installed during tests/CI mock runs. Idempotent — a
 * single `globalThis.__codexMockResolverInstalled` flag prevents stacking
 * the patch across nested `--require` chains.
 */

const path = require('node:path');
const Module = require('node:module');

const TARGET = '@openai/codex-sdk';
const MOCK_PATH = path.resolve(__dirname, 'index.js');

if (!globalThis.__codexMockResolverInstalled) {
  globalThis.__codexMockResolverInstalled = true;

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function _patchedResolveFilename(request, parent, isMain, options) {
    if (request === TARGET) {
      return MOCK_PATH;
    }
    return origResolve.call(this, request, parent, isMain, options);
  };
}
