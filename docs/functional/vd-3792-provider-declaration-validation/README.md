---
id: vd-3792-provider-declaration-validation
title: Reject package-declared providers instead of silently discarding them
shape: bugfix
---

## Goal

A package's `promptfooconfig.json`/`.yaml` must never be able to declare its own `providers`
field and have that field silently discarded. Today `resolveConfigFile()`
(`scripts/framework/resolve-promptfoo-config.js`) always overwrites `providers` with the
tier-derived provider block, regardless of what the package itself declared, with no warning.
This spec covers making that violation loud instead of silent.

## Inputs

- A package config (already parsed from YAML/JSON) passed into `resolveConfigFile(relativePath)`.
- The package's own `providers` field, if present — the value under scrutiny.
- `metadata.eval_tier`, already required by the existing contract.

## Outputs

- If the parsed package config has a `providers` field (any truthy value — array, object, or
  otherwise), `resolveConfigFile()` throws an `Error` before doing any v0/v1/multiturn
  resolution work. The error message:
  - names the normalized package config path,
  - states that the framework would otherwise have silently discarded the declared `providers`,
  - points at the fix: remove `providers`, rely on `metadata.eval_tier`, and (if an
    OpenHands-backed run is needed) migrate `config/eval-tiers.toml` to the v1 shape with a
    `provider_kind = "openhands_agent_server"` (or `openhands_sdk`) tier entry.
- If the parsed package config has no `providers` field, behavior is unchanged: `resolveConfigFile()`
  proceeds through the existing v0 / v1 / multiturn-auto-route resolution exactly as before.

## Invariants

- The check fires before any branching on tier-config shape (v0, v1, or the multi-turn
  auto-route path) — a package must never declare `providers`, independent of which shape
  `config/eval-tiers.toml` uses.
- The check only inspects the **package's own parsed config** (`parsed.providers`). It must
  never be confused with the tier-derived `providers` array `resolveConfigFile()` itself builds
  and returns — that field is added *after* this check passes and is a different value entirely.
- A config missing `metadata.eval_tier` still throws the pre-existing "missing metadata.eval_tier"
  error; the new check does not change or precede that behavior when both fields are absent
  together (providers-declared-without-eval_tier is not a case this spec needs to special-case —
  either error is an acceptable diagnostic).

## Acceptance Criteria

- **AC-1**: Given a package config with `metadata.eval_tier` set to a valid v0-shaped tier AND a
  package-level `providers` field, `resolveConfigFile()` throws before computing any tier-derived
  provider block.
- **AC-2**: Given a package config with `metadata.eval_tier` set to a valid v1-shaped tier AND a
  package-level `providers` field, `resolveConfigFile()` throws before computing any tier-derived
  provider block.
- **AC-3**: Given a package config with a multi-turn test (`vars.turns` present) AND a
  package-level `providers` field, `resolveConfigFile()` throws before the multi-turn auto-route
  path runs.
- **AC-4**: The thrown error's message includes the normalized package config path and mentions
  both `providers` and `metadata.eval_tier`, so a reader can identify the offending file and the
  required fix from the message alone.
- **AC-5**: A package config with `metadata.eval_tier` and **no** `providers` field continues to
  resolve exactly as before (v0, v1, and multiturn paths all unaffected) — this change adds a
  new failure mode without altering the existing success path.

## Cross-refs

- `docs/design.md` § Package Contract — states the underlying contract this spec enforces.
- Linear VD-3792 — origin issue.
- Linear VD-3793 — consumer-repo (`vibedata-data-engineering`) migration follow-up, out of scope here.
