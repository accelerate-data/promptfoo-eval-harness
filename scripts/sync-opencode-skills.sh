#!/usr/bin/env bash
#
# sync-skills.sh — Symlink the latest version of each skill from the
# Codex internal marketplace cache into .opencode/skills/.
#
# Usage:  bash scripts/sync-skills.sh
#
set -euo pipefail

MARKETPLACE="$HOME/.codex/plugins/cache/ad-internal-marketplace"
TARGET="$(cd "$(dirname "$0")/.." && pwd)/.opencode/skills"

if [[ ! -d "$MARKETPLACE" ]]; then
  echo "ERROR: Marketplace cache not found at $MARKETPLACE" >&2
  exit 1
fi

mkdir -p "$TARGET"

# Remove stale symlinks whose targets no longer exist
echo "Cleaning stale symlinks…"
for link in "$TARGET"/*; do
  [[ -L "$link" ]] && [[ ! -e "$link" ]] && rm "$link"
done

# Pick the highest semver directory; fall back to the only directory present.
latest_version_dir() {
  local plugin_dir="$1"
  local dirs=()
  for d in "$plugin_dir"/*/; do
    [[ -d "$d" ]] || continue
    dirs+=("$(basename "$d")")
  done

  if [[ ${#dirs[@]} -eq 0 ]]; then
    return 1
  fi

  # If there's a "local" dir, prefer it (dev / editable install).
  for d in "${dirs[@]}"; do
    if [[ "$d" == "local" ]]; then
      echo "$d"
      return 0
    fi
  done

  # Otherwise sort by semver and pick the last (highest).
  printf '%s\n' "${dirs[@]}" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1
}

linked=0
skipped=0

for plugin_dir in "$MARKETPLACE"/*/; do
  [[ -d "$plugin_dir" ]] || continue

  plugin="$(basename "$plugin_dir")"
  version="$(latest_version_dir "$plugin_dir")" || continue

  skills_src="$plugin_dir/$version/skills"
  [[ -d "$skills_src" ]] || continue

  echo "Plugin: $plugin (v$version)"

  for skill_dir in "$skills_src"/*/; do
    [[ -d "$skill_dir" ]] || continue

    skill="$(basename "$skill_dir")"
    target="$TARGET/$skill"

    # Skip if already pointing to the correct target
    if [[ -L "$target" ]]; then
      existing="$(readlink "$target")"
      if [[ "$existing" == "$(realpath "$skill_dir")" ]]; then
        skipped=$((skipped + 1))
        continue
      fi
      rm "$target"
    fi

    ln -s "$(realpath "$skill_dir")" "$target"
    linked=$((linked + 1))
    echo "  → $skill"
  done
done

echo ""
echo "Done: $linked linked, $skipped already up-to-date."
