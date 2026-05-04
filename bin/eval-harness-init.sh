#!/usr/bin/env bash
#
# eval-harness-init: scaffold a Promptfoo/OpenCode eval suite into the current
# repository. Idempotent: existing files are left in place unless --force is
# passed.
#
# Usage:
#   eval-harness-init [--force] [--target tests/evals]
#
# What it does:
#   1. Creates <target>/ with packages/, scripts/, config/, docs/.
#   2. Copies opencode.json, eval-tiers.toml, package.json, contract test, and
#      a harness-smoke starter package into <target>.
#   3. Adds the .gitignore lines the runtime needs.
#   4. Installs promptfoo + the harness package via npm if a package.json was
#      generated (skipped when --no-install is passed).
#   5. Adds an npm Dependabot entry for <target> to .github/dependabot.yml so
#      the repo receives PRs when @accelerate-data/promptfoo-eval-harness releases a new
#      version (skipped when the entry already exists).

set -euo pipefail

FORCE=0
INSTALL=1
TARGET="tests/evals"

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "eval-harness-init: unknown option: $1" >&2
      exit 2
      ;;
  esac
done

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

copy_if_absent "$TEMPLATES/opencode.json"               "$DEST/opencode.json"
copy_if_absent "$TEMPLATES/config/eval-tiers.toml"      "$DEST/config/eval-tiers.toml"
copy_if_absent "$TEMPLATES/package.json"                "$DEST/package.json"
copy_if_absent "$TEMPLATES/scripts/eval-suite-contract.test.js" "$DEST/scripts/eval-suite-contract.test.js"
copy_if_absent "$EXAMPLES/harness-smoke/promptfooconfig.json"   "$DEST/packages/harness-smoke/promptfooconfig.json"

# .gitignore lines for the runtime artifacts.
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

# Add a Dependabot npm entry for the eval target so consumer repos get PRs
# when @accelerate-data/promptfoo-eval-harness releases a new version.
DEPENDABOT_DIR="$REPO_ROOT/.github"
DEPENDABOT="$DEPENDABOT_DIR/dependabot.yml"
DEPENDABOT_ENTRY="  - package-ecosystem: npm
    directory: /$TARGET
    schedule:
      interval: weekly"

mkdir -p "$DEPENDABOT_DIR"
if [ ! -f "$DEPENDABOT" ]; then
  printf 'version: 2\nupdates:\n%s\n' "$DEPENDABOT_ENTRY" > "$DEPENDABOT"
  echo "  create $DEPENDABOT"
elif grep -qF "directory: /$TARGET" "$DEPENDABOT"; then
  echo "  skip  $DEPENDABOT (/$TARGET entry already present)"
else
  printf '\n%s\n' "$DEPENDABOT_ENTRY" >> "$DEPENDABOT"
  echo "  update $DEPENDABOT (added /$TARGET npm entry)"
fi

cat <<EOM

==> Done.

Next steps:
  1. Make sure OpenCode CLI is available on PATH (e.g. \`opencode --version\`).
  2. Verify the smoke scenario:
       cd $TARGET
       npm run eval:harness-smoke
  3. Author your first package under $TARGET/packages/<name>/promptfooconfig.json.
     See https://github.com/accelerate-data/promptfoo-eval-harness/blob/main/docs/guides/authoring-evals.md
EOM
