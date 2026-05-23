# minimal-smoke

Single-turn opencode_cli smoke test. Verifies the bridge can dispatch a prompt and receive a response using the mock binary — no live API key required.

## Run

```bash
# From repo root
OPENCODE_MOCK_MODE=1 node bin/ad-evals.js run tests/harness-scenarios/packages/minimal-smoke
```

The mock `opencode` binary lives at `tests/_mock_opencode/opencode`. `OPENCODE_MOCK_MODE=1` instructs the OpenCode CLI provider to prepend that directory to `PATH`.

## Expected outcome

- Exit 0
- 1 test case passes
- Output is a non-empty string (mock binary echoes the prompt)
- Runtime < 90 s on any machine
