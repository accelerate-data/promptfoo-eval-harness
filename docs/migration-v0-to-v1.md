# Migration Guide: v0 → v1

This guide walks consumer repos through upgrading their eval harness configuration from the legacy v0 shape (OpenCode CLI only, flat `[tiers.X]` with `agent` fields) to the v1 shape (multi-provider, `[[tiers.X.providers]]` arrays with `provider_kind`).

---

## Section 1 — Preconditions

Before running the migration, verify:

- **Node ≥ 18** — `node --version`
- **Python ≥ 3.12** — `python3 --version`
- **uv installed** — `uv --version` (see <https://docs.astral.sh/uv/getting-started/installation/>)
- **Git working tree is clean** — `git status` (the migrator rewrites `config/eval-tiers.toml` in place; a clean tree makes rollback trivial)

---

## Section 2 — Step-by-step

### Step 1 — Update the harness package

In your consumer repo:

```bash
npm install --save-dev @accelerate-data/promptfoo-eval-harness@latest
```

### Step 2 — Re-scaffold and migrate

```bash
npx eval-harness-init --upgrade --migrate-from-v0
```

This command:

1. Re-runs the scaffolding step (adds `tests/harness-scenarios/packages/`, `tests/evals/.tmp/workspaces/`, `config/sdk-pins.toml` if absent) — existing files are skipped.
2. Detects the v0 shape in `config/eval-tiers.toml`.
3. Rewrites the file **in place** to v1 shape.
4. Prints a unified diff to stdout so you can review the change.

### Step 3 — Review the diff

The migrator prints the diff before writing. Example output:

```diff
--- a/config/eval-tiers.toml
+++ b/config/eval-tiers.toml
@@ -1,18 +1,17 @@
-[runtime]
-provider_id = "framework://opencode-cli-provider.js"
-opencode_config = "opencode.json"
-...
-[tiers.light]
-agent = "eval_light"
+version = "v1"
+
+[[tiers.light.providers]]
+provider_kind = "opencode_cli"
+label = "eval_light"
+agent_config = "opencode.json"
 ...
```

The migrator is **in-place** (no shadow `.v1` file) and **idempotent** — re-running on an already-v1 config is a no-op with a warning.

### Step 4 — Verify

Run the doctor to confirm provider runtime paths are ready:

```bash
npx ad-evals doctor
```

Or run a quick smoke scenario (from the harness package, no live key needed):

```bash
OPENCODE_MOCK_MODE=1 npx ad-evals run tests/harness-scenarios/packages/minimal-smoke
```

### Step 5 — Commit

```bash
git add config/eval-tiers.toml
git commit -m "chore: migrate eval-tiers.toml v0 → v1"
```

---

## Section 3 — Common gotchas

### Model alias mismatch

v0 configs used short agent names (e.g. `eval_light`, `opencode-sonnet`). v1 resolves model aliases via the `model_resolver` module (see `scripts/framework/providers/openhands_sdk/model_resolver.py`). If your v0 agent names don't map to a valid model, add an explicit `model` field to the migrated provider entry.

### Tool registry overrides

v0 had no concept of `provider_kind`. The migrator automatically injects `provider_kind = "opencode_cli"` into every tier — no manual edit required for OpenCode CLI users.

If you were routing to a different provider via the legacy `runtime.provider_id` field, that field is dropped during migration. Update the migrated config manually to set the correct `provider_kind` per tier.

### env_allowlist

v1 introduces per-SDK environment variable allowlists in `config/sdk-pins.toml` (spec §7.1). Review the `env_allowlist` entries for each SDK:

```toml
[openhands_sdk]
env_allowlist = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  ...
]
```

Add any custom environment variables your eval scenarios require.

### Idempotent re-runs

Running `--migrate-from-v0` on an already-v1 config is a no-op:

```text
migrate-from-v0: already-v1 — no changes written
```

It is safe to script or run in CI gating.

---

## Section 4 — Rollback

If you need to revert:

```bash
# Restore the original v0 config from git.
git checkout HEAD -- config/eval-tiers.toml

# Downgrade the harness to the previous version.
npm install --save-dev @accelerate-data/promptfoo-eval-harness@<previous-version>
```

The migrator never creates shadow files, so there is nothing else to clean up.
