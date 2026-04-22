#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <tag>"
  echo "Example: $0 v1.7.6"
  exit 1
fi

TAG="$1"
ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/private/scripts/hybrid-release"

SKIP_WIN="${REDBOX_SKIP_WIN:-0}"
SKIP_MAC="${REDBOX_SKIP_MAC:-0}"
SYNC_PUBLIC="${REDBOX_SYNC_PUBLIC:-0}"
GIT_PUSH="${REDBOX_GIT_PUSH:-1}"

if ! command -v gh >/dev/null 2>&1; then
  echo "[publish] gh CLI not found."
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "[publish] gh not authenticated. Run: gh auth login"
  exit 1
fi

echo "[publish] Start release pipeline for $TAG"

if [[ "$SKIP_WIN" != "1" ]]; then
  echo "[publish] Step 1/3: build Windows on remote host"
  "$SCRIPT_DIR/build-win-on-remote.sh"
fi

if [[ "$SKIP_MAC" != "1" ]]; then
  echo "[publish] Step 2/3: build macOS on local machine (signed + notarized)"
  REDBOX_MAC_MODE=full "$SCRIPT_DIR/build-mac-local.sh"
fi

echo "[publish] Step 3/3: upload artifacts to GitHub Release"
"$SCRIPT_DIR/upload-release.sh" "$TAG"

if [[ "$SYNC_PUBLIC" == "1" ]]; then
  echo "[publish] Step 4/5: public mirror sync is handled by .github/workflows/sync-public-assets.yml after git push"
  if [[ "$GIT_PUSH" != "1" ]]; then
    echo "[publish] WARNING: REDBOX_SYNC_PUBLIC=1 but REDBOX_GIT_PUSH!=1, so the cloud sync workflow will not be triggered."
  fi
fi

if [[ "$GIT_PUSH" == "1" ]]; then
  echo "[publish] Step 5/5: git tag + push (trigger cloud sync workflow)"
  CURRENT_BRANCH="$(git -C "$ROOT_DIR" branch --show-current)"
  if [[ -z "$CURRENT_BRANCH" ]]; then
    echo "[publish] ERROR: cannot detect current git branch"
    exit 1
  fi

  if ! git -C "$ROOT_DIR" rev-parse --verify "$TAG" >/dev/null 2>&1; then
    git -C "$ROOT_DIR" tag "$TAG"
    echo "[publish] Created local tag: $TAG"
  else
    echo "[publish] Local tag exists: $TAG"
  fi

  git -C "$ROOT_DIR" push origin "$CURRENT_BRANCH"
  git -C "$ROOT_DIR" push origin "$TAG"
fi

echo "[publish] Done: $TAG"
echo "[publish] Release URL: https://github.com/Jamailar/RedBox/releases/tag/$TAG"
