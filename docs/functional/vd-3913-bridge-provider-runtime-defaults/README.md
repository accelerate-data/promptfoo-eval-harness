---
id: vd-3913-bridge-provider-runtime-defaults
title: Bridge-provider resolver merges [runtime] shared defaults into v1-tier provider entries
shape: bugfix
---

## Goal

Under the v1 tier-config shape (`config/eval-tiers.toml`'s `[tiers.*].providers[]`), every
resolved bridge provider entry must inherit the shared `[runtime]` defaults
(`opencode_config`, `project_dir`, `format`, `log_level`, and any other `[runtime]`-level field)
unless the provider entry itself already declares that field. Today `resolveMultiProviderConfig()`
normalizes the raw tier config (which carries `.runtime` when present) but never passes that
`runtime` object into `_buildBridgeProviderEntry()` — so a v1 tier's `providers[]` entries, which
are meant to declare only `provider_kind`/`agent`/etc. and rely on `[runtime]` for the rest, resolve
to a config missing those shared fields entirely. This breaks every v1-tier package that follows the
config format's own documented shape, surfacing as `OpenCode CLI provider requires agent,
opencode_config, project_dir, format, and log_level` at eval-run time.

## Inputs

- The raw tier config object parsed from `config/eval-tiers.toml` (or an injected
  `rawTierConfig`), which may declare a top-level `[runtime]` table.
- One tier's provider entry from `tiers.<name>.providers[]` — the fields it declares itself
  (`provider_kind`, `model`, `label`, and optionally any of the same field names `[runtime]`
  provides).

## Outputs

- `resolveMultiProviderConfig()` (and therefore `resolveConfigFile()` for the v1 path) returns a
  provider entry whose `config` object contains every `[runtime]` field the tier's own provider
  entry did not already declare, merged in as a default.
- A provider entry that explicitly sets a field also present in `[runtime]` (e.g. a tier overriding
  `format`) keeps its own value — entry declarations always win over `[runtime]` defaults.
- A tier config with no `[runtime]` table resolves exactly as before (no defaults to merge, entry
  fields pass through unchanged) — this is not a breaking change for tier configs that don't use
  `[runtime]`.
- The resolver-owned identity fields (`provider_kind`, `model`, `run_id`, `case_id`, and
  `provider_label` when a `label` is set) are still exclusively resolver-controlled: neither the
  provider entry nor `[runtime]` can override them.

## Invariants

- Merge order is entry-first, `[runtime]`-as-fallback: `{ ...runtimeDefaults, ...providerEntryRest,
  ...resolverOwnedFields }`. `[runtime]` values only fill gaps the entry itself leaves open.
- `[runtime].provider_id` is a v0-only field (it selects the legacy CLI provider path) and is not a
  per-provider config field for v1 bridge entries — it must not be merged into the resolved
  `config` object.
- The `openhands_agent_server` wrapper-style provider branch is a distinct code path from the
  standard bridge branch (`_buildBridgeProviderEntry`'s two branches) but is subject to the same
  merge rule: it also currently builds its `config` purely from the provider entry's own `...rest`
  with no `[runtime]` merge, so it has the same gap and this spec's fix covers it too.
- This spec does not touch VD-3912's fix (top-level field placement instead of nesting under
  `provider_options`) — merging `[runtime]` defaults happens at the same top level VD-3912
  established.

## Acceptance Criteria

- **AC-1** Given a v1 tier config with a `[runtime]` table declaring `opencode_config`,
  `project_dir`, `format`, and `log_level`, and a tier provider entry that declares none of those
  fields, the resolved provider's `config` object contains all four fields with the `[runtime]`
  values.
- **AC-2** Given the same setup as AC-1, but the tier provider entry itself declares `format`
  (overriding the `[runtime]` default), the resolved provider's `config.format` is the entry's own
  value, not the `[runtime]` value.
- **AC-3** Given a v1 tier config with no `[runtime]` table at all, resolution succeeds unchanged —
  the resolved provider's `config` contains only the fields the entry itself declared plus the
  resolver-owned fields (no error, no spurious keys).
- **AC-4** `[runtime].provider_id` never appears as a key in a resolved v1 bridge provider's `config`
  object, even when `[runtime]` declares it (it is a v0-only field, not a bridge config field).
- **AC-5** The `openhands_agent_server` branch of `_buildBridgeProviderEntry` also merges
  `[runtime]` defaults under the same entry-first-fallback rule as AC-1/AC-2.
- **AC-6** Running `run-evals-local.js run` against a package whose `metadata.eval_tier` selects a
  v1 tier relying on `[runtime]` for shared defaults (e.g. `skill-validating-against-baseline-contract`
  under this repo's `config/eval-tiers.toml`) no longer throws `OpenCode CLI provider requires
  agent, opencode_config, project_dir, format, and log_level`.

## Cross-refs

- `docs/functional/vd-3792-provider-declaration-validation/README.md` — the previous spec against
  the same file; that fix (rejecting package-declared `providers`) is a distinct, unaffected
  concern.
- Linear VD-3912 — established top-level field placement (`...rest` spread order) that this fix
  preserves and builds on.
- Linear VD-3894 — the consumer-repo package whose broken eval run surfaced this bug.
- Linear VD-3913 — origin issue for this spec.
