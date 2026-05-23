# Harness Scenarios

Framework-shipped end-to-end scenarios for the promptfoo eval harness.

## Layout

```text
tests/harness-scenarios/packages/
├── index.json                    # Scenario registry (source of truth)
├── minimal-smoke/                # 1-turn opencode_cli smoke test
├── opencode-cli-compatibility/   # Multi-case opencode_cli compat lock
└── openhands-mock-multi-turn/    # 3-turn openhands_sdk scenario
```

## Contract

Every scenario MUST follow this layout:

```text
packages/<name>/
├── promptfooconfig.json   # REQUIRED — Promptfoo v1 config
├── prompts/               # REQUIRED — prompt template files
├── tests/test.csv         # REQUIRED — test cases
└── README.md              # optional — run instructions
```

### index.json schema

Every entry in `index.json` MUST have these fields and MUST be kept in sync when adding or removing scenarios:

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Unique scenario name, matches directory name |
| `path` | string | Path relative to repo root |
| `provider_kinds` | string[] | Provider kinds used (`opencode_cli`, `openhands_sdk`) |
| `requires_live_key` | boolean | Whether a real API key is required |
| `expected_runtime_seconds` | number | Expected wall-clock time in seconds |

Entries are sorted alphabetically by `name` to keep additive merges conflict-free.

## Running scenarios

### Single scenario (mock mode)

```bash
# opencode_cli scenarios
OPENCODE_MOCK_MODE=1 node bin/ad-evals.js run tests/harness-scenarios/packages/minimal-smoke

# openhands_sdk scenarios
PYTHONPATH=tests/_mock_openhands_sdk node bin/ad-evals.js run tests/harness-scenarios/packages/openhands-mock-multi-turn
```

### All scenarios in parallel

```bash
OPENCODE_MOCK_MODE=1 PYTHONPATH=tests/_mock_openhands_sdk \
  node bin/ad-evals.js run tests/harness-scenarios/packages
```

## Adding a scenario

1. Create `packages/<name>/` with the required files above.
2. Add an entry to `index.json` in alphabetical order by `name`.
3. Verify the scenario runs with mock mode locally before opening a PR.
