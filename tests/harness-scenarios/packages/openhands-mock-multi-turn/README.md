# openhands-mock-multi-turn

3-turn openhands_sdk scenario using the mock SDK. Verifies the bridge can drive a multi-turn conversation via the subprocess/NDJSON IPC protocol — no live API key required.

## Run

```bash
# From repo root
PYTHONPATH=tests/_mock_openhands_sdk \
  node bin/ad-evals.js run tests/harness-scenarios/packages/openhands-mock-multi-turn
```

`PYTHONPATH=tests/_mock_openhands_sdk` makes Python import `sdk.py` from the mock package instead of the real `openhands-sdk` wheel. The mock emits deterministic echo responses.

## Expected outcome

- Exit 0
- 1 test case passes
- Output contains 3 turn responses joined by `\n---\n`
- transcript length = 3 (one entry per turn)

## How it works

`vars.turns` is a JSON-encoded array of 3 strings. The bridge's `parseTurns` decodes it, then calls the openhands_sdk provider once per turn via the NDJSON IPC channel. Each turn calls `send_message()` + `run()` on the mock `LocalConversation`, which emits a deterministic event sequence keyed on the message text.
