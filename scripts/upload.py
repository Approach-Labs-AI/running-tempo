#!/usr/bin/env python3
"""Upload val/*.ts to the Tempo Val Town project.

Usage:
    export VALTOWN_TOKEN=vtwn_...
    export VALTOWN_PROJECT=<project-id>
    export VALTOWN_BRANCH=<branch-id>
    python3 scripts/upload.py            # upload all
    python3 scripts/upload.py db engine  # upload a subset (basenames, no .ts)

Val Town: POST creates a new file, PUT updates an existing one; both need
branch_id. http vals export `default app.fetch`; interval vals export a cron
handler; everything else is a plain script. We infer the type from the filename.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = os.environ["VALTOWN_TOKEN"]
PROJECT = os.environ["VALTOWN_PROJECT"]
BRANCH = os.environ["VALTOWN_BRANCH"]
VAL_DIR = Path(__file__).resolve().parent.parent / "val"

# filename (no ext) -> Val Town file type. Single HTTP entrypoint (app.ts);
# api/dashboard/strava register routes onto it and stay plain scripts.
HTTP_VALS = {"app"}
INTERVAL_VALS = {"nudges", "weekly"}


def file_type(stem: str) -> str:
    if stem in HTTP_VALS:
        return "http"
    if stem in INTERVAL_VALS:
        return "interval"
    return "script"


def api(method: str, path: str, body: dict | None = None) -> dict:
    url = f"https://api.val.town/v2/vals/{PROJECT}/files?path={path}&branch_id={BRANCH}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read() or b"{}")


def existing_files() -> set[str]:
    url = (
        f"https://api.val.town/v2/vals/{PROJECT}/files"
        f"?path=/&branch_id={BRANCH}&recursive=true"
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req) as resp:
        payload = json.loads(resp.read())
    return {f["path"] for f in payload.get("data", payload.get("files", []))}


def main() -> None:
    only = {a.removesuffix(".ts") for a in sys.argv[1:]}
    existing = existing_files()
    files = sorted(VAL_DIR.glob("*.ts"))
    for f in files:
        if f.name.endswith(".test.ts"):
            continue
        stem = f.stem
        if only and stem not in only:
            continue
        path = f.name  # upload as flat basename, e.g. db.ts
        content = f.read_text()
        ftype = file_type(stem)
        method = "PUT" if path in existing else "POST"
        try:
            api(method, path, {"content": content, "type": ftype})
            print(f"  {method:4} {path:18} ({ftype})")
        except urllib.error.HTTPError as e:
            print(f"  FAIL {path}: {e.code} {e.read().decode()[:200]}")
    print("Done. Set env vars in the Val Town web UI, then POST /api/plan/seed-houston.")


if __name__ == "__main__":
    main()
