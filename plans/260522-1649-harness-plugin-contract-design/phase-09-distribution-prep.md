# Phase 09 — Distribution Prep (H.33-H.36)

> **Sub-issue:** VD-2174-8. **Status:** pending. **Blocked by:** phase 08.
> Time budget: ~3 days.

## Context Links

- Spec: [`spec.md`](spec.md) §6.3 (Python packaging), §6.4 (sdk-pins.toml), §6.5 (distribution + npm tags), §6.6 (consumer dependabot), §8.4 (release-readiness checklist), §9.2 Steps H.33-H.36, §9.7 (Phase 1 success criteria).
- Predecessors: all prior phases. Cannot ship without nightly green for two consecutive nights (§8.4).

## Overview

- **Priority:** Cuts the v1.0.0 release of `@accelerate-data/promptfoo-eval-harness`. After this phase, consumer repos can `npm install @accelerate-data/promptfoo-eval-harness@latest` and use the OpenHands SDK in production.
- **Current status:** Pending.
- **Brief:** Author CHANGELOG, README provider matrix + scenario index, publish workflow (npm `latest` / `next` / `canary`), and the dependabot template for consumer repos. Final release-readiness check before tagging.

## Key Insights

- SemVer ^1.0.0; first non-canary publish is `1.0.0` to the `latest` tag (spec §6.5).
- Publish workflow uses `npm publish --tag <latest|next|canary>` based on branch + tag.
- Consumer dependabot template watches `npm` + `github-actions` ONLY (spec §6.4 + §6.6). SDK pins are FRAMEWORK-owned via `config/sdk-pins.toml` — consumer repos do NOT install `openhands-sdk` directly, so adding it to the consumer dependabot config is alert-noise. PyPI watching stays in THIS harness repo's own `.github/dependabot.yml`.
- DO NOT RAISE A PR (user directive). This phase ends with the worktree clean; the user merges/tags manually.

## Requirements

### Functional

1. **H.33 — CHANGELOG entry:** `CHANGELOG.md` — new `## 1.0.0 — 2026-MM-DD` section summarizing the refactor, listing breaking changes (single bridge URL, v1 tier shape), and migration pointer to `docs/migration-v0-to-v1.md`.
2. **H.34 — README provider matrix + scenario index:**
   - `README.md` — top-level provider matrix (`provider_kind`, status, model alias examples).
   - Scenario index (auto-linked to `tests/harness-scenarios/packages/`).
   - `docs/release-readiness.md` — checklist per §8.4.
3. **H.35 — Publish workflow:** `.github/workflows/publish.yml`:
   - Trigger on tag `v*.*.*` → npm publish with appropriate tag.
   - Pre-publish: `npm test`, `pytest`, run all `requires_live_key=false` scenarios.
   - Verify nightly green for two consecutive nights via GitHub API check.
4. **H.36 — Consumer dependabot template:** `templates/dependabot.yml`:
   - Watches npm `@accelerate-data/promptfoo-eval-harness`.
   - Watches `github-actions` for the harness workflows.
   - DOES NOT watch PyPI — SDK pins are framework-owned in `config/sdk-pins.toml` per spec §6.4 + §6.6; consumers do not install `openhands-sdk` directly. PyPI watching for SDKs lives in this repo's own `.github/dependabot.yml`, not the template.
   - Copied into consumer repos at `eval-harness-init` time (extend G.31 logic to also drop a sample dependabot.yml).

### Non-functional

- README diff is reviewable (no unrelated rewrites).
- Publish workflow rejects publish if any `requires_live_key=false` scenario fails.
- Worktree ends in a clean state. **No PR raised** per user directive.

## Architecture

```text
.github/workflows/
├── nightly-scenarios.yml   # from phase 08
└── publish.yml             # NEW — H.35

templates/
└── dependabot.yml          # NEW — H.36 (consumer-repo template)

docs/
└── release-readiness.md    # NEW — §8.4 checklist

CHANGELOG.md                # NEW or appended — H.33
README.md                   # UPDATED — H.34
```

## Related Code Files

- **Create:**
  - `CHANGELOG.md` (if not present; else append section)
  - `docs/release-readiness.md`
  - `.github/workflows/publish.yml`
  - `templates/dependabot.yml`
- **Modify:**
  - `README.md` — provider matrix + scenario index + new install/usage section.
  - `bin/eval-harness-init.sh` — drop `templates/dependabot.yml` into the consumer's `.github/`.
  - `package.json` — bump to `1.0.0`; confirm `publishConfig.access = "public"` (if scoped); confirm `files` includes everything in `scripts/framework/`, `config/`, `bin/`, `templates/`.
- **Delete:** none.

## Implementation Steps

### H.33 — CHANGELOG entry

1. Create or open `CHANGELOG.md`. If new, use Keep-a-Changelog format.
2. Add section `## 1.0.0 — <release-date>`:
   - Summary paragraph.
   - **Added:** OpenHands SDK provider, scenario harness, dir-walk run mode, migrate-from-v0 command, structured logger, secret redactor, workspace guard, doctor --install-providers, sdk-pins.toml.
   - **Changed:** single Promptfoo bridge URL (was per-provider); v1 tier shape (v0 still accepted with auto-normalization).
   - **Breaking:** any consumer relying on private exports from `scripts/framework/opencode-cli-provider.js` directly — migration pointer to `docs/migration-v0-to-v1.md`.
3. Commit: `docs(vd-2174-8): CHANGELOG entry for 1.0.0 (H.33)`.

### H.34 — README + scenario index + release-readiness doc

4. Update `README.md`:
   - Top-level provider matrix (table): `provider_kind`, status (`stable`/`beta`/`planned`), model alias examples, link to provider README.
   - "Scenarios" section linking to each `tests/harness-scenarios/packages/*/README.md`.
   - "Quickstart" section: `npx ad-evals run tests/harness-scenarios/packages/minimal-smoke`.
   - "Migration from v0" pointer.
5. Author `docs/release-readiness.md` with the §8.4 checklist:
   - `npm test` green.
   - `pytest` green ≥70 % coverage on Python.
   - All non-live scenarios green locally.
   - Nightly green for two consecutive nights.
   - `bench/spawn-cost.js` p95 within budget.
   - `docs/migration-v0-to-v1.md` up to date.
   - `CHANGELOG.md` entry present.
6. Commit: `docs(vd-2174-8): provider matrix + scenario index + release-readiness checklist (H.34)`.

### H.35 — Publish workflow

7. Author `.github/workflows/publish.yml`:
   - `on: push: tags: ['v*.*.*']`.
   - `jobs.publish` runs on `ubuntu-latest`; matrix `python: [3.12, 3.13]`.
   - Steps: checkout (with tags) → Node setup → uv setup → `npm ci` → `uv sync --frozen` → `npm test` → `pytest` → run every scenario with `requires_live_key=false` → query nightly workflow last-2-runs status via `gh api` and abort if not green → derive npm tag from version (`X.Y.Z-canary.N` → `canary`, `X.Y.Z-next.N` → `next`, else `latest`) → `npm publish --provenance --access public --tag $TAG` (uses `NPM_TOKEN` secret).
   - No `--no-verify` flags; respects pre-publish hooks.
8. Validate YAML with `actionlint`.
9. Commit: `ci(vd-2174-8): publish workflow with nightly-gate + npm tag derivation (H.35)`.

### H.36 — Consumer dependabot template

10. Author `templates/dependabot.yml`:
    - `package-ecosystem: npm` watching `@accelerate-data/promptfoo-eval-harness` (weekly).
    - `package-ecosystem: github-actions` for the harness workflows.
    - DO NOT include `package-ecosystem: pip` watching `openhands-sdk` — that pin is framework-owned per spec §6.4 and belongs in this repo's own `.github/dependabot.yml`, not the consumer template.
11. Ensure this repo's own `.github/dependabot.yml` (separate from `templates/dependabot.yml`) watches `pip` for `openhands-sdk` plus any future SDK pins listed in `config/sdk-pins.toml`; add an entry if not present.
12. Update `bin/eval-harness-init.sh` to drop `templates/dependabot.yml` at `.github/dependabot.yml` in the consumer (do not overwrite if it already exists; create `.github/dependabot.harness.example.yml` instead).
13. Layer 2 test: run init in a tmp dir; assert dependabot template materialized AND assert the consumer template contains NO `pip` ecosystem entry.
13. Commit: `feat(vd-2174-8): consumer dependabot template + init drop (H.36)`.

### Final release-readiness check (no PR)

14. Bump `package.json` version to `1.0.0`.
15. Run the §8.4 / `docs/release-readiness.md` checklist locally:
    - `npm test`, `pytest`, all non-live scenarios, `bench/spawn-cost.js`, `npm run lint:md`.
16. Confirm two nightly runs green on `main` (or on this branch if the user has merged it; per directive, we do not raise the PR — the user does the merge).
17. Do NOT raise a PR. Leave the branch and worktree clean for the user.
18. Final commit (only if changes from steps 14-15): `chore(vd-2174-8): bump to 1.0.0 + release-readiness verification`.

## Todo List

- [ ] H.33: CHANGELOG 1.0.0 entry with Added / Changed / Breaking.
- [ ] H.34: README provider matrix + scenario index + release-readiness doc.
- [ ] H.35: publish.yml with nightly gate + tag derivation.
- [ ] H.36: consumer dependabot.yml template (npm + github-actions only — no pip) + harness-repo dependabot watches PyPI for SDK pins + init drop logic + Layer 2 test that asserts the template lacks a pip entry.
- [ ] Version bump to 1.0.0.
- [ ] Final release-readiness checklist green locally.
- [ ] DO NOT raise a PR.

## Success Criteria

- All H.33-H.36 commits land on the feature branch.
- `CHANGELOG.md` 1.0.0 section is complete and accurate.
- `README.md` provider matrix shows OpenCode CLI (stable) + OpenHands SDK (stable); SDK 3+4 marked planned.
- `publish.yml` is syntactically valid and references `NPM_TOKEN` secret (not committed).
- Consumer dependabot template materializes via `eval-harness-init`.
- Final release-readiness checklist boxes all tick.
- Worktree is clean; **no PR is raised** (user directive).

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Publish workflow runs before nightly is green | M | H | `gh api` gate inside the workflow aborts the publish step. |
| README matrix drifts from `KIND_REGISTRY` | M | M | A Layer 1 test reads `README.md` matrix table + asserts every row exists in `KIND_REGISTRY` and vice versa. |
| `npm publish` requires 2FA token interactively | L | M | Use `--provenance` + `NPM_TOKEN` (CI-only, no interactive prompt). |
| Consumer dependabot template clashes with consumer's existing dependabot config | M | L | init drops a sibling `.github/dependabot.harness.example.yml` if dependabot.yml already exists. |
| Accidental PR raise (against directive) | L | H | Final step explicitly skips `gh pr create`; commit history left clean for user-driven merge. |

## Security Considerations

- `NPM_TOKEN` referenced only via `${{ secrets.NPM_TOKEN }}` — never echoed in workflow logs.
- `--provenance` enables npm package provenance for supply-chain integrity.
- Consumer dependabot template watches only npm + github-actions. SDK security patches surface through THIS repo's `.github/dependabot.yml` and ship to consumers via a harness version bump (spec §6.4 framework-owned pins).
- No live API keys in any committed file (README examples use placeholders).

## Next Steps

- After release-readiness checklist is green and worktree clean: the user merges the feature branch and tags `v1.0.0` manually.
- Future Phase 2 (Claude Agent SDK), Phase 3 (OpenCode SDK), Phase 4 (Codex SDK) reuse this distribution scaffolding — each adds a `KIND_REGISTRY` entry + provider module + scenario + CHANGELOG entry, no new workflow.
