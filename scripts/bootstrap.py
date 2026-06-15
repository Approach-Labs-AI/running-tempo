#!/usr/bin/env python3
"""One-shot: create the running-tempo Val Town project and upload all val/*.ts.

Requires network access to api.val.town (allowlisted egress, or run locally).

    export VALTOWN_TOKEN=vtwn_...        # your Val Town API token
    python3 scripts/bootstrap.py         # creates project + uploads everything

Idempotent-ish: if a project named running-tempo already exists, pass its id:
    VALTOWN_PROJECT=<id> python3 scripts/bootstrap.py

After this finishes, set secrets in the Val Town web UI (NOT available via API):
  TEMPO_API_SECRET, DASHBOARD_PASSWORD, ANTHROPIC_API_KEY,
  STRAVA_CLIENT_ID/SECRET, GOOGLE_CLIENT_ID/SECRET.
Then open the app URL printed below and POST /api/plan/seed-houston.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

TOKEN = os.environ["VALTOWN_TOKEN"]
VAL_DIR = Path(__file__).resolve().parent.parent / "val"
NAME = "running-tempo"

HTTP_VALS = {"app"}
INTERVAL_VALS = {"nudges", "weekly"}


def req(method: str, url: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read() or b"{}")


def file_type(stem: str) -> str:
    return "http" if stem in HTTP_VALS else "interval" if stem in INTERVAL_VALS else "script"


def main() -> None:
    project_id = os.environ.get("VALTOWN_PROJECT")
    if not project_id:
        print(f"Creating project '{NAME}' …")
        created = req("POST", "https://api.val.town/v2/vals",
                      {"name": NAME, "privacy": "unlisted"})
        project_id = created["id"]
        print(f"  project id: {project_id}")

    branches = req("GET", f"https://api.val.town/v2/vals/{project_id}/branches?limit=100")
    items = branches.get("data", branches if isinstance(branches, list) else [])
    main_branch = next((b for b in items if b.get("name") == "main"), items[0])
    branch_id = main_branch["id"]
    print(f"  branch id:  {branch_id}")

    # Upload val/*.ts (skip tests). POST to create, PUT to update.
    existing = set()
    try:
        listing = req("GET",
                      f"https://api.val.town/v2/vals/{project_id}/files?path=/&branch_id={branch_id}&recursive=true")
        existing = {f["path"] for f in listing.get("data", [])}
    except urllib.error.HTTPError:
        pass

    for f in sorted(VAL_DIR.glob("*.ts")):
        if f.name.endswith(".test.ts"):
            continue
        method = "PUT" if f.name in existing else "POST"
        url = f"https://api.val.town/v2/vals/{project_id}/files?path={f.name}&branch_id={branch_id}"
        try:
            req(method, url, {"content": f.read_text(), "type": file_type(f.stem)})
            print(f"  {method:4} {f.name:16} ({file_type(f.stem)})")
        except urllib.error.HTTPError as e:
            print(f"  FAIL {f.name}: {e.code} {e.read().decode()[:200]}")

    print("\nDone.")
    print(f"  Project:  https://www.val.town/x/<username>/{NAME}")
    print("  Next: set secrets in the Val Town web UI, then map the app.ts http val")
    print("        to tempo.kevinjsuh.com and POST /api/plan/seed-houston.")


if __name__ == "__main__":
    main()
