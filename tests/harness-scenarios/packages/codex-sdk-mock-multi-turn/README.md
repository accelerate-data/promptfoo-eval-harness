# codex-sdk-mock-multi-turn

Layer 4 mock-mode scenario for `provider_kind=codex_sdk` (Phase 12 / VD-2174-11).

Validates the in-proc `@openai/codex-sdk` provider end-to-end through
the single `file://` Promptfoo bridge without a live Codex API key or
network call. The provider's `require('@openai/codex-sdk')` is rewired
to the deterministic mock under
[`tests/_mock_codex_sdk/`](../../../_mock_codex_sdk/) by a CJS resolver
hook (`register.js`) that the runtime installs via
`NODE_OPTIONS=--require …/register.js`.

## Coverage

| Case | Turns | What it locks |
| --- | --- | --- |
| `[single-turn] greeting yields Hi there!` | 1 (`hello`) | Single-turn `thread.run` path. Asserts the assistant text surfaces through the bridge. |
| `[multi-turn] 3-turn session must recall the number remembered in turn 1` | 3 (`Please remember 42 for me.` → `Thanks, log that for later.` → `what number was it?`) | Multi-turn path. Verifies the provider reuses the same `Thread` across turns so turn 3 can recall `42` from turn 1's mock state. Asserts all three turn outputs surface (split by `\n---\n`). |

## Running locally

```sh
NODE_OPTIONS="--require $PWD/tests/_mock_codex_sdk/register.js" \
  node bin/ad-evals.js run tests/harness-scenarios/packages/codex-sdk-mock-multi-turn
```

`NODE_OPTIONS` must include the mock register file so the
`Module._resolveFilename` patch takes over `@openai/codex-sdk`
resolution before the provider loads it. Without it the scenario will
attempt to require the real `@openai/codex-sdk`, which in turn spawns
the `@openai/codex` CLI and contacts the network.

## Nightly CI

Wired into [`.github/workflows/nightly-scenarios.yml`](../../../../.github/workflows/nightly-scenarios.yml).
A dedicated step sets `NODE_OPTIONS` only for this scenario so the
mock resolver does not leak into the other scenarios (which expect the
real provider modules).
