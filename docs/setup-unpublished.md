# Eval Harness Setup — Unpublished Branch

> **For coding agents:** Use this guide ONLY when you need to test a
> harness branch that is not yet on the npm registry. For the
> production / released flow, follow [`setup.md`](setup.md) instead.
> Read the whole document before executing. Pick **one** install method in
> Step 1, then follow Steps 2–4 in order. Run every verification command
> and confirm it passes before moving on.

Step-by-step guide to bootstrap `@accelerate-data/promptfoo-eval-harness`
into a consumer repo from a **local worktree** (e.g. a feature branch like
`feature/vd-2174-multi-sdk-plugin-contract`) instead of the published npm
version.

Differences from `setup.md`:

- **Step 1** picks an install method that points the consumer at the local
  worktree instead of the registry.
- **Step 2** runs the scaffolder directly from the worktree (skips `npx`).
- **Step 3** rewrites the runtime dep to match the chosen method.

Steps 4 onward (write a package, run, wire CI) are identical to
`setup.md` Step 3 onward and not repeated here.

---

## Prerequisites

Same as `setup.md`, plus:

- A local checkout of `promptfoo-eval-harness` on the branch you want to
  test, with **absolute** filesystem path.
- The branch's `package.json` `version` is what you will test against.
  Confirm: `jq -r .version <HARNESS_PATH>/package.json`.

Set the path once for the rest of the guide:

```bash
export HARNESS_PATH=/abs/path/to/worktrees/feature/vd-2174-multi-sdk-plugin-contract
```

**Install the worktree's own dependencies** (REQUIRED for Methods A and
B; harmless for Method C):

```bash
( cd "$HARNESS_PATH" && npm install )
```

Methods A and B both symlink the consumer into the worktree, and Node
then resolves the harness package's runtime deps (`smol-toml`,
`@opencode-ai/sdk`, `promptfoo`, …) from `$HARNESS_PATH/node_modules`.
If the worktree was never `npm install`-ed, Step 4 will fail with
`Cannot find module 'smol-toml'` or similar. Method C does NOT
symlink, so it does not need the worktree's `node_modules` populated —
`npm install "$HARNESS_TGZ"` resolves the harness's `dependencies` from
the registry into the consumer's `tests/evals/node_modules/`. The
tarball is therefore NOT self-contained for offline / air-gapped use
(this package does not declare `bundledDependencies`).

> Heads-up: `bin/ad-evals.js` runs `npm install` at startup with
> `cwd: AD_EVALS_ROOT` (the consumer's `tests/evals/`). On macOS this
> can prune Linux-only `@swc/core-linux-*` optional deps and dirty
> `tests/evals/package-lock.json`. The re-pin step in the cleanup
> section at the end of this guide rewrites that lockfile cleanly, so
> no manual restore is needed for the consumer side. (The harness
> lockfile at `$HARNESS_PATH/package-lock.json` is NOT touched by the
> consumer flow.)

---

## Step 1 — Pick an install method

Three options. Pick **one** and stick with it through Step 3.

| Method | When to use | Tradeoff |
| --- | --- | --- |
| **A. `npm install <path>`** (file: dep) | Active development — you keep editing the worktree | Cleanest commands; lives in `package.json` as `file:` link |
| **B. `npm link`** (symlink) | Quick iteration; you want zero re-install on every edit | Symlinks are fragile — and the `npm link` does NOT persist in `package.json`, so `ad-evals` startup `npm install` (Step 4) can wipe it and silently reinstall the published `^0.1.x` (see Method B warning below) |
| **C. `npm pack` + tarball** | CI, code review, or a teammate reproducing a specific failure | Frozen snapshot of harness code — re-pack after every edit. Tarball is NOT self-contained: `npm install "$HARNESS_TGZ"` still pulls deps from the registry (no `bundledDependencies`). |

All three point the consumer at the unpublished branch, but they
differ in linkage semantics:

- **Methods A and B** install a LIVE link — `node_modules/@accelerate-data/promptfoo-eval-harness/`
  resolves to `$HARNESS_PATH`, so subsequent worktree edits are visible
  to the consumer immediately (no re-install needed).
- **Method C** installs a FROZEN SNAPSHOT — `npm install
  "$HARNESS_TGZ"` copies the tarball contents into the consumer's
  `node_modules/`. Worktree edits after `npm pack` are NOT visible
  until you re-pack and re-install the tarball.

They also differ in how the override is persisted (Methods A/C write a
`file:` entry to `package.json`/`package-lock.json`; Method B's symlink
is `node_modules`-only and can be wiped by `npm install`).

### Method A — `npm install <path>` (recommended)

No prep needed before bootstrap. You will run the install in Step 3.

### Method B — `npm link`

Register the worktree as a globally linkable package once per machine:

```bash
cd "$HARNESS_PATH"
npm link             # creates a global symlink → this worktree
```

Verify the global symlink:

```bash
npm ls -g --depth=0 --link=true | grep promptfoo-eval-harness
# expect: @accelerate-data/promptfoo-eval-harness@<version> -> /abs/path/.../worktree
```

### Method C — `npm pack` + tarball

Build a frozen tarball:

```bash
cd "$HARNESS_PATH"
npm pack             # writes accelerate-data-promptfoo-eval-harness-<v>.tgz
```

Move the tgz to a stable absolute path and export it:

```bash
mv accelerate-data-promptfoo-eval-harness-*.tgz /tmp/harness.tgz
export HARNESS_TGZ=/tmp/harness.tgz
```

Re-run `npm pack` whenever you change the worktree — the tarball does not
auto-update.

---

## Step 2 — Bootstrap from the worktree

Run from the consumer repo root (same regardless of which method you
picked in Step 1):

```bash
bash "$HARNESS_PATH/bin/eval-harness-init.sh"
```

This produces the same `tests/evals/` layout as the published flow. The
auto-install step inside the scaffolder still pins
`@accelerate-data/promptfoo-eval-harness: ^0.1.x` from the registry —
Step 3 corrects this.

Verify the scaffold landed:

```bash
ls tests/evals/packages/harness-smoke/promptfooconfig.json
```

---

## Step 3 — Wire the runtime to the worktree

Pick the matching subsection for your Step 1 method.

### Method A — `npm install <path>`

```bash
cd tests/evals
npm install "$HARNESS_PATH"
```

`npm` rewrites `tests/evals/package.json` so the dep entry becomes a
`file:` link to your absolute path. Live edits in the worktree are
visible to the consumer immediately — no re-install needed unless
`node_modules` is wiped.

### Method B — `npm link`

```bash
cd tests/evals
npm link @accelerate-data/promptfoo-eval-harness
```

This creates a symlink in `tests/evals/node_modules/` pointing at the
global symlink created in Step 1. **The link is NOT persisted in
`package.json`/`package-lock.json` — those still pin
`@accelerate-data/promptfoo-eval-harness: ^0.1.x` from the registry.**

> ⚠️ **`ad-evals` will wipe this symlink.** `bin/ad-evals.js` runs
> `ensureDepsInstalled()` at startup. When the
> `tests/evals/node_modules/.install-stamp` file is missing or its
> content (a sha256 of `package-lock.json`) does not match the current
> lockfile, that step runs `npm install`, which re-resolves the
> unchanged registry pin and replaces your symlink with the published
> `^0.1.x` package. Step 4 will then silently verify the WRONG
> version. Recommended workarounds:
>
> 1. **Switch to Method A or C** (preferred). Both persist the
>    override via a `file:` entry in `package.json`/`package-lock.json`
>    and survive every subsequent `npm install`.
> 2. **Re-link after every wipe.** If you must stay on Method B, run
>    `npm link @accelerate-data/promptfoo-eval-harness` from
>    `tests/evals/` again after each `ad-evals` invocation that
>    triggered `npm install`, then re-verify with `npm ls`.

### Method C — `npm pack` + tarball

```bash
cd tests/evals
npm install "$HARNESS_TGZ"
```

`npm` rewrites `tests/evals/package.json` so the dep entry becomes a
`file:` link to the tarball. Edits to the worktree do NOT affect the
consumer until you re-pack and re-install.

### Common verification (all three methods)

```bash
cd tests/evals
npm ls @accelerate-data/promptfoo-eval-harness
```

Expected output for each method:

| Method | `npm ls` line ends with |
| --- | --- |
| A | `-> /abs/path/.../worktrees/feature/...` |
| B | `-> /abs/path/.../worktrees/feature/...` (via global link) |
| C | `<no link arrow>` (version matches worktree, source is the tarball) |

---

## Step 3.5 — Configure secrets

Step 4's `eval:harness-smoke` hits a real model — same auth model as the
published flow.

> **Return to the consumer repo root first.** Step 3 left your shell
> inside `tests/evals/`. The paths in `setup.md` Step 1.5 (and in
> Step 4 below) are repo-root-relative — running them from
> `tests/evals/` would point at non-existent `tests/evals/tests/evals/…`
> paths and silently leave `process.env` without API keys.
>
> ```bash
> cd "$(git rev-parse --show-toplevel)"
> ```

Then follow [`setup.md`](setup.md) **Step 1.5 — Configure secrets** to:

1. Create `tests/evals/.env` and add `tests/evals/.env` to `.gitignore`
   (the bootstrap does NOT auto-ignore it).
2. Populate keys per the `provider_kind`s referenced in
   `tests/evals/config/eval-tiers.toml` (see the table in `setup.md`
   Step 1.5).
3. Either `set -a; . tests/evals/.env; set +a` before running `ad-evals`,
   or set `load_local_env = true` in `[runtime]` if your `provider_id`
   points at `framework://opencode-cli-plugin-provider.js`.

Worktree-specific reminder: keys live in `process.env`, not in
`$HARNESS_PATH`. None of the three install methods change auth — you
configure `.env` once on the consumer side and it works against every
method.

Watch out for the leaked `OPENHANDS_BASE_URL` gotcha — same workaround
applies (`OPENHANDS_BASE_URL= npm run eval:smoke`).

---

## Step 4 — Verify the install

```bash
cd tests/evals
npm test                    # framework contract tests — no API calls
npm run doctor              # prints resolved repo, state, and cache paths
npm run eval:harness-smoke  # one live run using the starter package
```

All three must pass before continuing. If `eval:harness-smoke` fails,
check that OpenCode CLI is on `PATH` and your `opencode.json` agent
definitions are correct.

---

## Step 5 — Continue with `setup.md`

The worktree override is now transparent to the rest of the workflow.
Return to the consumer **repo root** before continuing — `setup.md`
Step 3 onwards uses paths like `tests/evals/packages/...` that assume
your shell sits at the consumer repo root, not inside `tests/evals/`:

```bash
cd "$(git rev-parse --show-toplevel)"   # back to consumer repo root
```

Then pick up at [`setup.md`](setup.md) Step 3 to write a package, run
the suite, and wire CI as documented there.

---

## When you are done testing

Two things to clean up before committing or merging the consumer repo:

1. **Revert the local dep override.** The `file:` path (Method A or C) or
   symlink (Method B) in `tests/evals/package.json` and
   `tests/evals/package-lock.json` is machine-specific — do NOT commit it.

   The cleanup depends on whether `tests/evals/` was already tracked in
   git before you started.

   **Case 1 — `tests/evals/package.json` was tracked already** (you ran
   the unpublished flow against an existing consumer repo): roll back to
   the committed state.

   ```bash
   cd tests/evals
   # Method B only: drop the symlink first WITHOUT touching package.json.
   # (`npm unlink <pkg>` aliases `npm uninstall <pkg>` and saves by default;
   # `--no-save` keeps the manifest/lockfile pristine for the restore below.)
   npm unlink @accelerate-data/promptfoo-eval-harness --no-save || true
   # Then restore the committed package.json/package-lock.json — this
   # brings back the registry pin (`@accelerate-data/...@^0.1.x`).
   git checkout -- package.json package-lock.json
   # Re-populate node_modules from the restored lockfile.
   npm install
   ```

   **Case 2 — first-time scaffold** (`eval-harness-init.sh` just created
   `tests/evals/` and the files are still untracked): `git checkout`
   would fail with a pathspec error, leaving the local override in
   place. Re-pin to the published version directly — `npm install`
   rewrites the dep entry from `file:` back to a registry range:

   ```bash
   cd tests/evals
   # Method B only: unlink the consumer side BEFORE re-pinning
   npm unlink @accelerate-data/promptfoo-eval-harness || true
   # Re-pin to the latest published version (or pin to a specific one
   # once the harness branch lands on npm).
   npm install @accelerate-data/promptfoo-eval-harness@latest
   ```

   Confirm the dep is no longer a `file:` link before committing:

   ```bash
   grep '"@accelerate-data/promptfoo-eval-harness"' package.json
   # expect a semver range like "^0.1.3", NOT "file:..." or a tarball path
   ```

2. **Method B only — clear the global symlink** when you are done
   testing this branch (especially if switching to another branch):

   ```bash
   ( cd "$HARNESS_PATH" && npm unlink -g @accelerate-data/promptfoo-eval-harness ) || true
   ```

> The consumer's `tests/evals/package-lock.json` is rewritten by the
> re-pin command in step 1 above, so no separate lockfile-restore
> command is needed. Do NOT blindly `git restore
> $HARNESS_PATH/package-lock.json` — the unpublished branch may have
> legitimate lockfile changes you should keep.

---

## Reference

See [`setup.md`](setup.md) — commands, tier selection, assertion types,
and common failures are unchanged when running against a worktree.
