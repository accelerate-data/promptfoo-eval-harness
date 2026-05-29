# opencode-cli-compatibility

Layer 4 regression scenario that locks the existing OpenCode CLI provider behavior
(spec §7.4, §C.15). Runs 3 single-turn cases through the full bridge → provider
→ opencode-binary dispatch path, verifying no behavioral regression.

## What this scenario verifies

- The bridge (`_node_bridge.js`) correctly routes `provider_kind = opencode_cli`
  to `opencode-cli-provider.js` in-process.
- All five §7.4 behaviors survive refactoring:
  - **B1** env passthrough: `OPENCODE_CONFIG` and `XDG_STATE_HOME` reach the child.
  - **B2** argv shape: `opencode run --agent ... --dir ... --format ... --log-level ... <prompt>`.
  - **B3** exit-code mapping: non-zero exit propagates as a `provider_error`.
  - **B4** mock-mode bypass: `OPENCODE_MOCK_MODE=1` short-circuits the binary spawn.
  - **B5** redaction: no secret-shaped env values appear in error messages.
- Three single-turn cases cover the greet / summarize / extract prompt patterns.
- Multi-turn rejection (`vars.turns.length > 1`) is tested by the contract test
  (`scripts/framework/opencode-cli-provider.contract.test.js`) and the validator
  (`scripts/framework/validate-package-config.js`), NOT in this scenario.

## Running locally (no live API key)

```bash
# From the harness repo root:
bash tests/harness-scenarios/packages/opencode-cli-compatibility/run.sh
```

The `run.sh` script prepends `tests/_mock_opencode/` to `PATH` so the mock
`opencode` binary is used. All three cases receive canned responses; the scenario
exits 0 without any network call.

## Running with a real opencode installation

```bash
ANTHROPIC_API_KEY=sk-... node bin/ad-evals.js run \
  tests/harness-scenarios/packages/opencode-cli-compatibility/promptfooconfig.json
```

Requires a valid `ANTHROPIC_API_KEY` and the `opencode` binary on `PATH`.

## Mock binary

`tests/_mock_opencode/opencode` is a shell script that echoes the prompt as a
`[mock] <prompt>` line and exits 0. It never reads `ANTHROPIC_API_KEY` or makes
network calls.

## Matrix

1 tier × 1 model (`claude-sonnet-4-6`) × 3 cases = **3 provider invocations**.

All provider entries dispatch through `provider-shim.js`, which wraps
`scripts/framework/_node_bridge.js` (the canonical bridge per spec §2.2 + §4.3).
The shim exists solely to add a string `label` property that Promptfoo 0.121.x's
`usesExampleProvider` telemetry path requires; all dispatch logic runs in the bridge.
