# Promptfoo file-provider option-shape spike

**THROWAWAY** — this directory is a one-shot behavioral probe. Do not build on it.

## Purpose

Verify the exact shape Promptfoo passes to a `file://` provider's
`callApi(prompt, context, options)`. Specifically: does `options.config`
contain the per-provider `config:` block verbatim, including nested objects
and arrays? See spec §2.2 critical-assumption callout and §9.2 Step A.0.B.

## How to run

From the repo root:

```bash
npx promptfoo eval -c spikes/promptfoo-file-provider-shape/promptfooconfig.yaml \
  --output /tmp/probe-result.json 2>&1
```

Captured JSON written to `/tmp/probe-call-<timestamp>.json` per invocation.

## Verdict

See `plans/260522-1649-harness-plugin-contract-design/spike-promptfoo-file-provider-shape.md`.
