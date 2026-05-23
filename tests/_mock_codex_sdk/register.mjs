/**
 * Phase 12 — Module.register entry point invoked via:
 *
 *   node --import ./tests/_mock_codex_sdk/register.mjs <script>
 *
 * Wires up the ESM loader hook in loader.mjs so that any subsequent
 * `import('@openai/codex-sdk')` resolves to the mock at
 * tests/_mock_codex_sdk/sdk.mjs. Used by provider.test.js
 * (--import), _node_bridge.codex_sdk.test.js (--import on child), and
 * the nightly mock-mode scenario step in
 * .github/workflows/nightly-scenarios.yml.
 *
 * v1.3.1 hotfix: the real `@openai/codex-sdk@0.133.0` is ESM-only — its
 * package.json `exports` block declares only the `import` condition, so
 * the previous CJS `Module._resolveFilename` patch could only succeed for
 * the mock and would never have worked against the live SDK. This file
 * switches the mock plumbing to match the real package's ESM-only shape.
 */

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
