#!/usr/bin/env python3
"""Append a WWUD learning event to a local RedConvert model file."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path


DEFAULT_MODEL = Path.home() / "Library" / "Application Support" / "RedBox" / "wwud" / "user-model.md"


def main() -> int:
    parser = argparse.ArgumentParser(description="Record a RedConvert WWUD learning event.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--decision", required=True)
    parser.add_argument("--chosen", required=True)
    parser.add_argument("--rejected", default="n/a")
    parser.add_argument("--principle", required=True)
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--confidence", choices=("high", "medium", "low"), default="medium")
    parser.add_argument("--expires", default=None)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    args = parser.parse_args()

    event = {
        "source": args.source,
        "decision": args.decision,
        "chosen": args.chosen,
        "rejected": args.rejected,
        "principle": args.principle,
        "confidence": args.confidence,
        "evidence": args.evidence,
        "createdAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "expires": args.expires,
    }
    model = args.model.expanduser()
    model.parent.mkdir(parents=True, exist_ok=True)
    existing = model.read_text(encoding="utf-8") if model.exists() else "# WWUD RedConvert User Model\n\n## Learning Events\n"
    if "## Learning Events" not in existing:
        existing = existing.rstrip() + "\n\n## Learning Events\n"
    existing = existing.rstrip() + "\n- " + json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n"
    model.write_text(existing, encoding="utf-8")
    print(f"Recorded WWUD event in {model}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
