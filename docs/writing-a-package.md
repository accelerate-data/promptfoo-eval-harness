# Writing an Eval Package

An eval package is a directory under `tests/evals/packages/` that contains a
Promptfoo config and, optionally, a prompt file, fixtures, and assertion
helpers.

## Minimum Package

```text
tests/evals/packages/my-feature/
├─ promptfooconfig.json
└─ prompt.txt            # only when the config references it
```

## Config Requirements

Every package config needs two things:

**1. `metadata.eval_tier`** — selects which OpenCode agent tier runs this
package. Valid values are `light`, `standard`, `high`, and `x_high`. Do not
declare a `providers` block; the framework injects the correct provider at run
time based on this field.

**2. At least one `[smoke]` test** — the test description must start with the
literal `[smoke]` prefix. This is how `npm run eval:smoke` identifies the
minimal runnable scenario for every package. Every package must have exactly
one smoke test.

```json
{
  "description": "Behaviour of the my-feature prompt.",
  "metadata": {
    "eval_tier": "standard"
  },
  "prompts": ["file://prompt.txt"],
  "tests": [
    {
      "description": "[smoke] my-feature returns non-empty output",
      "assert": [
        { "type": "javascript", "value": "output.trim().length > 0" }
      ]
    },
    {
      "description": "my-feature handles edge case X",
      "assert": [
        { "type": "javascript", "value": "output.includes('expected token')" }
      ]
    }
  ]
}
```

## Prompt Files

Reference a prompt with `file://prompt.txt` inside the `prompts` array. The
path resolves relative to the package directory. You can also inline a prompt
directly in the config if it is short.

## Vars and Fixtures

Add a `vars` block to pass per-test inputs:

```json
{
  "tests": [
    {
      "description": "[smoke] my-feature with input A",
      "vars": { "input": "value A" },
      "assert": [
        { "type": "javascript", "value": "output.includes('A')" }
      ]
    }
  ]
}
```

For larger fixture payloads, load from a file:

```json
"vars": { "input": "file://fixtures/scenario-a.json" }
```

## Assertion Types

The most common types for agent output:

| Type | Use |
| --- | --- |
| `javascript` | Inline JS expression that evaluates against `output` |
| `contains` | Substring match |
| `regex` | Regex match |
| `llm-rubric` | Model-graded assertion with a rubric string |
| `is-json` | Validate that output parses as JSON |

## Tier Selection Guidelines

| Tier | Budget | When to use |
| --- | --- | --- |
| `light` | Minimal steps | Single-turn, structured-output prompts with no tool use |
| `standard` | Moderate | Most prompt evaluation scenarios |
| `high` | Generous | Multi-step research or generation tasks |
| `x_high` | Maximum | Full workflow runs or expensive grader scenarios |

## Smoke Coverage Rule

Every package must have exactly one `[smoke]` test. The smoke filter is not a
quality bar — it is an execution proof. A smoke test passes if the provider ran
without error and returned non-empty output. Keep the smoke assertion minimal
and deterministic.

## Adding the Package to the Scenario Inventory

After your package is working, add a row to your repo's
`tests/evals/docs/scenario-inventory.md` (or equivalent) so the package is
discoverable in code review and agent navigation.
