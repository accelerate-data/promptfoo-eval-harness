#!/usr/bin/env bash
#
# eval-harness-init: scaffold a Promptfoo/OpenCode eval suite into the current
# repository. Idempotent: existing files are left in place unless --force is
# passed.
#
# Usage:
#   eval-harness-init [--force] [--upgrade] [--migrate-from-v0] [--target tests/evals]
#
# What it does:
#   1. Creates <target>/ with packages/, scripts/, config/, docs/.
#   2. Copies AGENTS.md, opencode.json, eval-tiers.toml, package.json, contract
#      test, and a harness-smoke starter package into <target>.
#   3. Scaffolds tests/harness-scenarios/packages/ skeleton index.json.
#   4. Scaffolds tests/evals/.tmp/workspaces/.gitkeep.
#   5. Copies config/sdk-pins.toml from framework if absent.
#   6. Appends tests/evals/.tmp/ to repo .gitignore (idempotent).
#   7. Adds the .gitignore lines the runtime needs.
#   8. Installs promptfoo + the harness package via npm if a package.json was
#      generated (skipped when --no-install is passed).
#   9. Adds an npm Dependabot entry for <target> to .github/dependabot.yml.
#
# Flags:
#   --upgrade           Re-run scaffolding against an existing init'd repo (no overwrite).
#   --migrate-from-v0   Requires --upgrade. Rewrites config/eval-tiers.toml v0→v1 in place.
#   --force             Overwrite existing files (without --force, existing files are skipped).

set -euo pipefail

FORCE=0
INSTALL=1
TARGET="tests/evals"
UPGRADE=0
MIGRATE_V0=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    --upgrade) UPGRADE=1; shift ;;
    --migrate-from-v0) MIGRATE_V0=1; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "eval-harness-init: unknown option: $1" >&2
      exit 2
      ;;
  esac
done

# Validate flag combinations.
if [ "$MIGRATE_V0" -eq 1 ] && [ "$UPGRADE" -eq 0 ]; then
  echo "eval-harness-init: --migrate-from-v0 requires --upgrade" >&2
  exit 2
fi

# Locate the harness package root regardless of how this script was invoked
# (npx, node_modules/.bin, direct path).
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$0")"
HARNESS_ROOT="$(cd -- "$(dirname "$SCRIPT_PATH")/.." && pwd)"
TEMPLATES="$HARNESS_ROOT/templates"
EXAMPLES="$HARNESS_ROOT/examples"

# Resolve the target inside the consumer repo.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DEST="$REPO_ROOT/$TARGET"

echo "==> Initialising eval harness in: $DEST"
mkdir -p "$DEST/config" "$DEST/packages/harness-smoke" "$DEST/scripts" "$DEST/docs"

copy_if_absent() {
  src="$1"; dst="$2"
  if [ -e "$dst" ] && [ "$FORCE" -ne 1 ]; then
    echo "  skip  $dst (exists; use --force to overwrite)"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "  copy  $dst"
}

copy_if_absent "$TEMPLATES/AGENTS.md"                   "$DEST/AGENTS.md"
copy_if_absent "$TEMPLATES/opencode.json"               "$DEST/opencode.json"
copy_if_absent "$TEMPLATES/config/eval-tiers.toml"      "$DEST/config/eval-tiers.toml"
copy_if_absent "$TEMPLATES/package.json"                "$DEST/package.json"
copy_if_absent "$TEMPLATES/scripts/eval-suite-contract.test.js" "$DEST/scripts/eval-suite-contract.test.js"
copy_if_absent "$EXAMPLES/harness-smoke/promptfooconfig.json"   "$DEST/packages/harness-smoke/promptfooconfig.json"

# ---------------------------------------------------------------------------
# G.31 — new layout scaffolding
# ---------------------------------------------------------------------------

# 1. Scaffold tests/harness-scenarios/packages/ skeleton.
SCENARIOS_DIR="$REPO_ROOT/tests/harness-scenarios/packages"
if [ ! -d "$SCENARIOS_DIR" ]; then
  mkdir -p "$SCENARIOS_DIR"
  echo "  create  $SCENARIOS_DIR/"
fi
SCENARIOS_INDEX="$SCENARIOS_DIR/index.json"
if [ ! -f "$SCENARIOS_INDEX" ]; then
  cat > "$SCENARIOS_INDEX" <<'JSON'
{
  "scenarios": [],
  "note": "Framework-shipped scenarios live in @accelerate-data/promptfoo-eval-harness; consumer-specific scenarios go here."
}
JSON
  echo "  create  $SCENARIOS_INDEX"
else
  echo "  skip    $SCENARIOS_INDEX (exists)"
fi

# 2. Scaffold tests/evals/.tmp/workspaces/.gitkeep.
WORKSPACES_GITKEEP="$REPO_ROOT/tests/evals/.tmp/workspaces/.gitkeep"
if [ ! -f "$WORKSPACES_GITKEEP" ]; then
  mkdir -p "$(dirname "$WORKSPACES_GITKEEP")"
  touch "$WORKSPACES_GITKEEP"
  echo "  create  $WORKSPACES_GITKEEP"
else
  echo "  skip    $WORKSPACES_GITKEEP (exists)"
fi

# 3. Append tests/evals/.tmp/ to repo .gitignore (idempotent).
REPO_GITIGNORE="$REPO_ROOT/.gitignore"
EVALS_TMP_ENTRY="tests/evals/.tmp/"
if [ -f "$REPO_GITIGNORE" ]; then
  if grep -qxF "$EVALS_TMP_ENTRY" "$REPO_GITIGNORE" 2>/dev/null; then
    echo "  skip    $REPO_GITIGNORE ($EVALS_TMP_ENTRY already present)"
  else
    echo "$EVALS_TMP_ENTRY" >> "$REPO_GITIGNORE"
    echo "  update  $REPO_GITIGNORE (added $EVALS_TMP_ENTRY)"
  fi
else
  echo "$EVALS_TMP_ENTRY" > "$REPO_GITIGNORE"
  echo "  create  $REPO_GITIGNORE"
fi

# 4. Copy config/sdk-pins.toml from framework if absent in consumer repo.
CONSUMER_SDK_PINS="$REPO_ROOT/config/sdk-pins.toml"
if [ ! -f "$CONSUMER_SDK_PINS" ]; then
  mkdir -p "$(dirname "$CONSUMER_SDK_PINS")"
  # Try templates first; fall back to framework config.
  if [ -f "$TEMPLATES/sdk-pins.toml" ]; then
    cp "$TEMPLATES/sdk-pins.toml" "$CONSUMER_SDK_PINS"
  elif [ -f "$HARNESS_ROOT/config/sdk-pins.toml" ]; then
    cp "$HARNESS_ROOT/config/sdk-pins.toml" "$CONSUMER_SDK_PINS"
  else
    echo "  warn    sdk-pins.toml source not found; skipping" >&2
  fi
  if [ -f "$CONSUMER_SDK_PINS" ]; then
    echo "  create  $CONSUMER_SDK_PINS"
  fi
else
  echo "  skip    $CONSUMER_SDK_PINS (exists)"
fi

# .gitignore lines for the runtime artifacts (eval-target-local .gitignore).
GITIGNORE="$DEST/.gitignore"
ensure_line() {
  line="$1"; file="$2"
  grep -qxF "$line" "$file" 2>/dev/null || echo "$line" >>"$file"
}
touch "$GITIGNORE"
ensure_line ".cache/"  "$GITIGNORE"
ensure_line ".tmp/"    "$GITIGNORE"
ensure_line "output/"  "$GITIGNORE"
ensure_line "results/" "$GITIGNORE"
ensure_line "node_modules/" "$GITIGNORE"
echo "  ensure $GITIGNORE has runtime artifact entries"

if [ "$INSTALL" -eq 1 ] && [ -f "$DEST/package.json" ]; then
  echo "==> Installing dependencies in $DEST"
  ( cd "$DEST" && npm install --no-audit --no-fund )
else
  echo "==> Skipping npm install. Run: cd $DEST && npm install"
fi

# ---------------------------------------------------------------------------
# G.29 — --upgrade --migrate-from-v0: in-place v0→v1 rewrite
# ---------------------------------------------------------------------------
if [ "$MIGRATE_V0" -eq 1 ]; then
  CONSUMER_TIER_CONFIG="$DEST/config/eval-tiers.toml"
  if [ ! -f "$CONSUMER_TIER_CONFIG" ]; then
    echo "eval-harness-init: --migrate-from-v0: no config found at $CONSUMER_TIER_CONFIG" >&2
    exit 1
  fi
  echo "==> Migrating $CONSUMER_TIER_CONFIG (v0 → v1)..."
  node "$HARNESS_ROOT/scripts/framework/migrate-from-v0.js" "$CONSUMER_TIER_CONFIG"
  echo "  done  migration complete (idempotent: re-running is safe)"
fi

# ---------------------------------------------------------------------------
# H.36 — Drop templates/dependabot.yml into consumer .github/dependabot.yml.
#
# The template watches npm (@accelerate-data/promptfoo-eval-harness) and
# github-actions only. No pip block — SDK pin security patches ship via
# harness version bumps (spec §6.4 + §6.6).
#
# Logic:
#   - Consumer has NO .github/dependabot.yml → copy template verbatim.
#   - Consumer HAS an existing .github/dependabot.yml → drop a sibling
#     .github/dependabot.harness.example.yml and print a notice to merge.
# ---------------------------------------------------------------------------
DEPENDABOT_DIR="$REPO_ROOT/.github"
DEPENDABOT="$DEPENDABOT_DIR/dependabot.yml"
DEPENDABOT_TEMPLATE="$TEMPLATES/dependabot.yml"

mkdir -p "$DEPENDABOT_DIR"
if [ ! -f "$DEPENDABOT_TEMPLATE" ]; then
  echo "  warn    dependabot template not found at $DEPENDABOT_TEMPLATE; skipping" >&2
elif [ ! -f "$DEPENDABOT" ]; then
  cp "$DEPENDABOT_TEMPLATE" "$DEPENDABOT"
  echo "  create  $DEPENDABOT (from harness template)"
else
  DEPENDABOT_EXAMPLE="$DEPENDABOT_DIR/dependabot.harness.example.yml"
  cp "$DEPENDABOT_TEMPLATE" "$DEPENDABOT_EXAMPLE"
  echo "  notice  $DEPENDABOT already exists; harness template dropped at $DEPENDABOT_EXAMPLE"
  echo "          Manually merge the npm + github-actions entries into $DEPENDABOT"
fi

cat <<EOM

==> Done.

Next steps:
  1. Make sure OpenCode CLI is available on PATH (e.g. \`opencode --version\`).
  2. Verify the smoke scenario:
       cd $TARGET
       npm run eval:harness-smoke
  3. Author your first package under $TARGET/packages/<name>/promptfooconfig.json.
     See https://github.com/accelerate-data/promptfoo-eval-harness/blob/main/docs/writing-a-package.md
EOM
