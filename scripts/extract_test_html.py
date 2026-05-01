#!/usr/bin/env python3
"""
Extract inline HTML strings from the Python test files into standalone
.html files plus an index.json mapping each case to its expected output.

Codex P1-4: triple-quoted HTML inside `.py` files has indentation and
escape quirks that the TS parsers will tokenize differently. Pulling
the strings into discrete `.html` files forces us to confront
normalization at port time, not test-write time.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from typing import Any

PM_ROOT = Path("/srv/projects/ProxyMiner")
TESTS_ROOT = PM_ROOT / "apps" / "api" / "tests"
OUT_DIR = Path(__file__).resolve().parent.parent / ".fixtures" / "test-cases" / "html"


HTML_OPEN_PATTERN = re.compile(r"<\s*[a-zA-Z!]")


def looks_like_html(value: str) -> bool:
    if "<" not in value or ">" not in value:
        return False
    return bool(HTML_OPEN_PATTERN.search(value))


def slugify(text: str) -> str:
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:80] or "case"


def walk_tests() -> list[dict[str, Any]]:
    inventory: list[dict[str, Any]] = []
    for test_file in sorted(TESTS_ROOT.glob("test_*extractor*.py")):
        # Only the extractor tests have meaningful inline HTML. Route /
        # display-filter tests carry mostly Python data structures.
        try:
            tree = ast.parse(test_file.read_text())
        except SyntaxError:
            continue

        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            if not node.name.startswith("test_"):
                continue

            # Walk the function body for string assignments / argument
            # literals that look like HTML.
            for sub in ast.walk(node):
                if isinstance(sub, ast.Assign):
                    if not isinstance(sub.value, (ast.Constant, ast.JoinedStr)):
                        continue
                    if isinstance(sub.value, ast.Constant) and isinstance(
                        sub.value.value, str
                    ):
                        value = sub.value.value
                        if looks_like_html(value):
                            inventory.append(
                                _record(test_file, node, sub.targets, value)
                            )
                elif isinstance(sub, ast.Call):
                    for arg in sub.args:
                        if (
                            isinstance(arg, ast.Constant)
                            and isinstance(arg.value, str)
                            and looks_like_html(arg.value)
                        ):
                            inventory.append(_record(test_file, node, None, arg.value))
    return inventory


def _record(
    test_file: Path,
    func: ast.FunctionDef,
    targets: list[ast.expr] | None,
    html: str,
) -> dict[str, Any]:
    target_name = ""
    if targets:
        head = targets[0]
        if isinstance(head, ast.Name):
            target_name = head.id
    case_id = slugify(f"{test_file.stem}__{func.name}__{target_name}".strip("_"))
    return {
        "case_id": case_id,
        "source_file": test_file.name,
        "test_function": func.name,
        "target_var": target_name,
        "html_size_bytes": len(html.encode("utf-8")),
        "html": html,
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    inventory = walk_tests()

    # Deduplicate identical HTML reused across helpers
    seen_html: dict[str, str] = {}
    case_index: list[dict[str, Any]] = []
    for entry in inventory:
        html = entry.pop("html")
        digest = str(hash(html))
        if digest in seen_html:
            entry["html_file"] = seen_html[digest]
        else:
            html_name = f"{entry['case_id']}.html"
            (OUT_DIR / html_name).write_text(html)
            seen_html[digest] = html_name
            entry["html_file"] = html_name
        case_index.append(entry)

    (OUT_DIR / "index.json").write_text(
        json.dumps(case_index, indent=2, sort_keys=True)
    )

    print(f"Wrote {len(seen_html)} unique HTML files, {len(case_index)} test-case entries")
    print(f"Output: {OUT_DIR}")


if __name__ == "__main__":
    main()
