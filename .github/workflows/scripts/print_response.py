#!/usr/bin/env python3
"""Pretty-print /tmp/ingest-resp.json, capped at 4000 chars.

Used by .github/workflows/recover-cohort.yml. The admin ingest endpoint
returns a small JSON object on success but can return a multi-KB error
payload (Drizzle/Postgres stacks, SEC HTML snippets); the cap keeps the
GitHub Actions log readable.
"""
import json


def main() -> None:
    try:
        with open("/tmp/ingest-resp.json", "r", encoding="utf-8") as f:
            body = f.read()[:4000]
    except FileNotFoundError:
        print("(no response body file)")
        return
    try:
        parsed = json.loads(body)
        print(json.dumps(parsed, indent=2)[:4000])
    except json.JSONDecodeError:
        print(body)


if __name__ == "__main__":
    main()
