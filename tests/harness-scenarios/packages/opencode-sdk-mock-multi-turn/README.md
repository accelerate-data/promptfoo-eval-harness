# opencode-sdk-mock-multi-turn

Layer 4 mock-mode scenario for `provider_kind=opencode_sdk` (Phase 11 / VD-2174-10).

Validates the in-proc `@opencode-ai/sdk` provider end-to-end through the
single `file://` Promptfoo bridge without a live OpenCode server or
network call. The provider's `await import('@opencode-ai/sdk')` is
rewired to the deterministic mock under
[`tests/_mock_opencode_sdk/`](../../../_mock_opencode_sdk/) by an ESM
loader hook (`register.mjs`) that the runtime registers via
`NODE_OPTIONS=--import …/register.mjs`.

## Coverage

| Case | Turns | What it locks |
| --- | --- | --- |
| `[single-turn] greeting yields Hi there!` | 1 (`hello`) | Single-turn `client.session.prompt` path. Asserts the assistant text surfaces through the bridge. |
| `[multi-turn] 3-turn session must recall the number remembered in turn 1` | 3 (`Please remember 42 for me.` → `Thanks, log that for later.` → `what number was it?`) | Multi-turn path. Verifies the provider reuses the same session across turns so turn 3 can recall `42` from turn 1's history. Asserts all three turn outputs surface (split by `\n---\n`). |

## Running locally

```sh
NODE_OPTIONS="--import $PWD/tests/_mock_opencode_sdk/register.mjs" \
  node bin/ad-evals.js run tests/harness-scenarios/packages/opencode-sdk-mock-multi-turn
```

`NODE_OPTIONS` must include the mock register file so the loader hook
takes over `@opencode-ai/sdk` imports before the provider loads it.
Without it the scenario will attempt to boot a real OpenCode server and
fail.

## Nightly CI

Wired into [`.github/workflows/nightly-scenarios.yml`](../../../../.github/workflows/nightly-scenarios.yml).
A dedicated step sets `NODE_OPTIONS` only for this scenario so the mock
loader does not leak into the other scenarios (which expect the real
provider modules).
