#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        values[key.strip()] = value
    return values


def default_env_paths() -> list[Path]:
    script_path = Path(__file__).resolve()
    repo_root = script_path.parents[4]
    cwd = Path.cwd().resolve()
    paths = []
    explicit = os.environ.get("REDCONVERT_FEEDBACK_ENV")
    if explicit:
        paths.append(Path(explicit).expanduser())
    paths.extend(
        [
            cwd / ".redbox-dev" / "feedback-admin.env",
            cwd.parent / ".redbox-dev" / "feedback-admin.env",
            repo_root / ".redbox-dev" / "feedback-admin.env",
        ]
    )
    seen = set()
    unique = []
    for path in paths:
        normalized = str(path)
        if normalized not in seen:
            seen.add(normalized)
            unique.append(path)
    return unique


def load_config() -> dict[str, str]:
    config = dict(os.environ)
    loaded_path = None
    for path in default_env_paths():
        values = parse_env_file(path)
        if values:
            config.update(values)
            loaded_path = path
            break
    missing = [
        key
        for key in ("API_BASE", "FEEDBACK_ADMIN_API_KEY")
        if not config.get(key, "").strip()
    ]
    if missing:
        searched = "\n".join(f"- {path}" for path in default_env_paths())
        raise SystemExit(
            "Missing feedback admin configuration: "
            + ", ".join(missing)
            + "\nSearched:\n"
            + searched
        )
    if loaded_path:
        config["REDCONVERT_FEEDBACK_ENV_LOADED"] = str(loaded_path)
    return config


def build_url(base: str, path: str, query: dict[str, str | int | None]) -> str:
    base = base.rstrip("/")
    query_string = urlencode(
        {key: value for key, value in query.items() if value not in (None, "")}
    )
    url = f"{base}{path}"
    return f"{url}?{query_string}" if query_string else url


def request_json(config: dict[str, str], method: str, path: str, query: dict[str, str | int | None]):
    url = build_url(config["API_BASE"], path, query)
    request = Request(
        url,
        method=method,
        headers={
            "Authorization": f"Bearer {config['FEEDBACK_ADMIN_API_KEY']}",
            "Accept": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=30) as response:
            data = response.read().decode("utf-8")
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {error.code} from feedback API: {body}") from error
    except URLError as error:
        raise SystemExit(f"Failed to reach feedback API: {error}") from error
    return json.loads(data)


def compact_list(payload):
    items = payload.get("items") or payload.get("data") or payload.get("results") or []
    if not isinstance(items, list):
        return payload
    compact_items = []
    for item in items:
        if not isinstance(item, dict):
            compact_items.append(item)
            continue
        compact_items.append(
            {
                "id": item.get("id") or item.get("feedback_id"),
                "status": item.get("status"),
                "priority": item.get("priority"),
                "title": item.get("title"),
                "category": item.get("category"),
                "created_at": item.get("created_at") or item.get("createdAt"),
                "updated_at": item.get("updated_at") or item.get("updatedAt"),
                "summary": item.get("summary") or item.get("body") or item.get("content"),
            }
        )
    result = dict(payload)
    for key in ("items", "data", "results"):
        if key in result:
            result[key] = compact_items
            break
    return result


def compact_detail(payload):
    if not isinstance(payload, dict):
        return payload
    result = dict(payload)
    item = result.get("item")
    if not isinstance(item, dict):
        return result
    compact_item = dict(item)
    context = compact_item.get("context")
    if isinstance(context, dict):
        compact_context = dict(context)
        bug_report = compact_context.get("bug_report")
        if isinstance(bug_report, dict):
            compact_bug_report = dict(bug_report)
            log_text = compact_bug_report.pop("log_text", None)
            if isinstance(log_text, str):
                compact_bug_report["log_text_omitted"] = True
                compact_bug_report["log_text_chars"] = len(log_text)
                compact_bug_report["log_text_lines"] = len(log_text.splitlines())
            compact_context["bug_report"] = compact_bug_report
        compact_item["context"] = compact_context
    result["item"] = compact_item
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Read RedBox feedback admin issues.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="List feedback issues.")
    list_parser.add_argument("--page", type=int, default=1)
    list_parser.add_argument("--page-size", type=int, default=20)
    list_parser.add_argument("--status")
    list_parser.add_argument("--priority")
    list_parser.add_argument("--q")
    list_parser.add_argument("--app-slug")
    list_parser.add_argument("--app-id")
    list_parser.add_argument("--raw", action="store_true")

    detail_parser = subparsers.add_parser("detail", help="Read one feedback issue.")
    detail_parser.add_argument("feedback_id")
    detail_parser.add_argument("--app-slug")
    detail_parser.add_argument("--app-id")
    detail_parser.add_argument("--raw", action="store_true")

    args = parser.parse_args()
    config = load_config()
    app_slug = getattr(args, "app_slug", None) or config.get("FEEDBACK_APP_SLUG")
    app_id = getattr(args, "app_id", None) or config.get("FEEDBACK_APP_ID")

    if not app_slug and not app_id:
        raise SystemExit("Missing FEEDBACK_APP_SLUG or FEEDBACK_APP_ID.")

    if args.command == "list":
        payload = request_json(
            config,
            "GET",
            "/api/v1/platform-admin/feedback-issues",
            {
                "app_slug": app_slug,
                "app_id": app_id,
                "page": args.page,
                "page_size": args.page_size,
                "status": args.status,
                "priority": args.priority,
                "q": args.q,
            },
        )
        if not args.raw:
            payload = compact_list(payload)
    else:
        payload = request_json(
            config,
            "GET",
            f"/api/v1/platform-admin/feedback-issues/{args.feedback_id}",
            {"app_slug": app_slug, "app_id": app_id},
        )
        if not args.raw:
            payload = compact_detail(payload)

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
