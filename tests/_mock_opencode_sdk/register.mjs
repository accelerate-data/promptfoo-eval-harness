/**
 * Phase 11 — Module.register entry point invoked via:
 *
 *   node --import ./tests/_mock_opencode_sdk/register.mjs <script>
 *
 * Wires up the ESM loader hook in loader.mjs so that any subsequent
 * `import('@opencode-ai/sdk')` resolves to the mock at tests/_mock_opencode_sdk/sdk.mjs.
 * Used by provider.test.js and the nightly mock-mode scenario step in
 * .github/workflows/nightly-scenarios.yml.
 */

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
