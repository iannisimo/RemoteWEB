#!/usr/bin/env bash
# Commit everything and push. If remoteweb.user.js changed since the last commit,
# its @version is bumped first, so installed copies auto-update from GitHub.
#
# Usage: ./push.sh "commit message" [patch|minor|major]   (default: patch)
set -euo pipefail
cd "$(dirname "$0")"

msg="${1:?Usage: ./push.sh \"commit message\" [patch|minor|major]}"
part="${2:-patch}"
script=remoteweb.user.js

if ! git diff --quiet HEAD -- "$script"; then
  read -r major minor patch < <(sed -nE 's#^// @version[[:space:]]+([0-9]+)\.([0-9]+)\.([0-9]+).*#\1 \2 \3#p' "$script" | head -1)
  case "$part" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) echo "Unknown version part: $part (use patch, minor or major)" >&2; exit 1 ;;
  esac
  sed -i -E "0,/^\/\/ @version/s#^(// @version[[:space:]]+).*#\1$major.$minor.$patch#" "$script"
  echo "Version bumped to $major.$minor.$patch"
fi

git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit"
else
  git commit -m "$msg"
fi
git push
