#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
MANIFEST_PATH="$SCRIPT_DIR/manifest.json"

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "未找到 manifest.json: $MANIFEST_PATH" >&2
  exit 1
fi

VERSION="$(python3 - <<'PY' "$MANIFEST_PATH"
import json
import sys

manifest_path = sys.argv[1]
with open(manifest_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
version = str(data.get("version", "")).strip()
if not version:
    raise SystemExit("manifest.json 缺少 version")
print(version)
PY
)"

ARCHIVE_NAME="RedBox-Capture-${VERSION}.zip"
OUTPUT_PATH="$DIST_DIR/$ARCHIVE_NAME"
TMP_DIR="$(mktemp -d)"
TMP_ARCHIVE="$TMP_DIR/$ARCHIVE_NAME"

mkdir -p "$DIST_DIR"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$SCRIPT_DIR"
zip -r "$TMP_ARCHIVE" . \
  -x 'dist/*' \
  -x '.git/*' \
  -x 'node_modules/*' \
  -x '__MACOSX/*'

mv "$TMP_ARCHIVE" "$OUTPUT_PATH"

echo "打包完成: $OUTPUT_PATH"
