#!/usr/bin/env python3
"""Create a starter WWUD model from local RedConvert app data.

The script is optional support for operators and developers. It scans only local
plain-text app artifacts and writes a compact markdown model that can be reviewed
before being copied into a workspace skill or profile.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path


APP_SUPPORT = Path.home() / "Library" / "Application Support" / "RedBox"
DEFAULT_OUTPUT = APP_SUPPORT / "wwud" / "user-model.md"

PREFERENCE_HINTS = (
    "默认",
    "不要",
    "必须",
    "优先",
    "更喜欢",
    "下次",
    "以后",
    "太",
    "删掉",
    "继续",
    "执行",
    "修复",
    "approve",
    "reject",
    "approval",
    "prefer",
    "always",
    "never",
)


def read_text(path: Path, limit: int = 200_000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")[:limit]
    except OSError:
        return ""


def candidate_files(root: Path, max_files: int) -> list[Path]:
    if not root.exists():
        return []
    allowed = {".md", ".txt", ".json", ".jsonl"}
    files = [
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in allowed
        and "node_modules" not in path.parts
        and "target" not in path.parts
    ]
    files.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return files[:max_files]


def extract_lines(path: Path, per_file: int = 12) -> list[str]:
    text = read_text(path)
    if not text:
        return []
    lines: list[str] = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip()
        if len(line) < 8 or len(line) > 220:
            continue
        if any(hint.lower() in line.lower() for hint in PREFERENCE_HINTS):
            lines.append(line)
        if len(lines) >= per_file:
            break
    return lines


def source_label(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def build_model(root: Path, output: Path, max_files: int) -> str:
    files = candidate_files(root, max_files)
    observations: list[tuple[str, str]] = []
    for path in files:
        for line in extract_lines(path):
            observations.append((source_label(path, root), line))
    seen: set[str] = set()
    deduped: list[tuple[str, str]] = []
    for source, line in observations:
        key = line.lower()[:160]
        if key in seen:
            continue
        seen.add(key)
        deduped.append((source, line))
        if len(deduped) >= 80:
            break

    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    rows = "\n".join(f"- source={source} | evidence={line}" for source, line in deduped)
    if not rows:
        rows = "- no preference-like app artifacts found"
    metadata = {
        "generatedAt": now,
        "appSupport": str(root),
        "scannedFileCount": len(files),
        "observationCount": len(deduped),
    }
    return f"""# WWUD RedConvert User Model

## Metadata

```json
{json.dumps(metadata, ensure_ascii=False, indent=2)}
```

## Decision Defaults

- Prefer fresh explicit user instruction over this model.
- Prefer app-local evidence over generic assumptions.
- Escalate restricted actions.

## Observed Evidence

{rows}

## Learning Events

- none yet
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap a RedConvert WWUD model from app data.")
    parser.add_argument("--app-support", type=Path, default=APP_SUPPORT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--max-files", type=int, default=200)
    args = parser.parse_args()

    output = args.output.expanduser()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(build_model(args.app_support.expanduser(), output, args.max_files), encoding="utf-8")
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
