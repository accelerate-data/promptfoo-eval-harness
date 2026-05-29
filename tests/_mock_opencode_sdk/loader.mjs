/**
 * Phase 11 — ESM loader hook that swaps `@opencode-ai/sdk` for the local mock.
 *
 * Registered via `Module.register('./loader.mjs', import.meta.url)` from
 * register.mjs (invoked by `node --import .../register.mjs`).
 *
 * Only the bare specifier `@opencode-ai/sdk` is rewritten; subpath imports
 * (`@opencode-ai/sdk/server`, etc.) fall through to the default resolver.
 * The mock module exposes the same public surface the provider touches:
 * createOpencodeServer + createOpencodeClient + a session subclient.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __HERE__ = path.dirname(fileURLToPath(import.meta.url));
const MOCK_URL = pathToFileURL(path.join(__HERE__, 'sdk.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@opencode-ai/sdk') {
    return { url: MOCK_URL, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
