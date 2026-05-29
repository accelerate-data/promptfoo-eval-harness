/**
 * Phase 12 — ESM loader hook that swaps `@openai/codex-sdk` for the local mock.
 *
 * Registered via `Module.register('./loader.mjs', import.meta.url)` from
 * register.mjs (invoked by `node --import .../register.mjs`).
 *
 * Only the bare specifier `@openai/codex-sdk` is rewritten; subpath imports
 * (`@openai/codex-sdk/<subpath>`, etc.) fall through to the default
 * resolver. The mock module exposes the same public surface the provider
 * touches: a `Codex` constructor that returns objects with a `startThread`
 * method, where each thread has an async `run(message)` method.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __HERE__ = path.dirname(fileURLToPath(import.meta.url));
const MOCK_URL = pathToFileURL(path.join(__HERE__, 'sdk.mjs')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@openai/codex-sdk') {
    return { url: MOCK_URL, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
