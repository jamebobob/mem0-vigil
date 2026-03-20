#!/usr/bin/env python3
"""
A6: Never-Recalled Cleanup — Candidate Report Generator (Vigil)

Identifies Qdrant memory points that have NEVER appeared in any recall
event and are older than a configurable threshold. Outputs a markdown
report for human review. NEVER deletes anything automatically.

Usage:
    python3 never-recalled-cleanup.py --jsonl-dir ~/.openclaw/workspace/memory
    python3 never-recalled-cleanup.py --threshold-days 60 --qdrant-url http://localhost:6333

Requires: requests (pip install requests)
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from glob import glob
from pathlib import Path

try:
    import requests
except ImportError:
    print("Error: 'requests' package required. Install with: pip install requests", file=sys.stderr)
    sys.exit(1)

MAX_CANDIDATES = 100
COLLECTION = "memories"


def parse_recalled_point_ids(jsonl_dir: str) -> set[str]:
    """Parse all recall-events JSONL files and collect every point_id that was ever recalled."""
    recalled = set()
    pattern = os.path.join(jsonl_dir, "recall-events-*.jsonl")
    for path in sorted(glob(pattern)):
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    for pid in event.get("point_ids", []):
                        recalled.add(pid)
                except json.JSONDecodeError:
                    continue
    return recalled


def fetch_old_points(qdrant_url: str, threshold_days: int) -> list[dict]:
    """Scroll through Qdrant for all points with createdAt older than threshold."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=threshold_days)).isoformat()
    url = f"{qdrant_url}/collections/{COLLECTION}/points/scroll"

    all_points = []
    offset = None

    while True:
        body: dict = {
            "filter": {
                "must": [
                    {"key": "createdAt", "range": {"lt": cutoff}}
                ]
            },
            "limit": 100,
            "with_payload": ["createdAt", "data", "userId"],
        }
        if offset is not None:
            body["offset"] = offset

        resp = requests.post(url, json=body, timeout=30)
        resp.raise_for_status()
        result = resp.json().get("result", {})
        points = result.get("points", [])

        all_points.extend(points)
        next_offset = result.get("next_page_offset")
        if not next_offset or not points:
            break
        offset = next_offset

    return all_points


def generate_report(candidates: list[dict], threshold_days: int, output_path: str) -> None:
    """Write a markdown report of never-recalled candidates."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    with open(output_path, "w") as f:
        f.write(f"# Never-Recalled Memory Candidates\n\n")
        f.write(f"Generated: {now}\n")
        f.write(f"Threshold: {threshold_days} days with zero recalls\n")
        f.write(f"Candidates: {len(candidates)} (capped at {MAX_CANDIDATES})\n\n")
        f.write("**Action required:** Review each candidate. Approve deletions with the operator before any bulk action.\n\n")
        f.write("---\n\n")

        for i, point in enumerate(candidates, 1):
            pid = point.get("id", "unknown")
            payload = point.get("payload", {})
            created = payload.get("createdAt", "unknown")
            pool = payload.get("userId", "unknown")
            data = payload.get("data", "")
            preview = data[:120] + ("..." if len(data) > 120 else "")
            f.write(f"### {i}. `{pid}`\n")
            f.write(f"- **Pool:** {pool}\n")
            f.write(f"- **Created:** {created}\n")
            f.write(f"- **Memory:** {preview}\n\n")


def main():
    parser = argparse.ArgumentParser(
        description="Identify never-recalled Qdrant memories for review (report only, no deletions)"
    )
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="Report only, no deletions (default: true, always true)")
    parser.add_argument("--threshold-days", type=int, default=30,
                        help="Minimum age in days for a point to be a candidate (default: 30)")
    parser.add_argument("--jsonl-dir", type=str, default=os.path.expanduser("~/.openclaw/workspace/memory"),
                        help="Directory containing recall-events-*.jsonl files")
    parser.add_argument("--qdrant-url", type=str, default="http://localhost:6333",
                        help="Qdrant REST API URL (default: http://localhost:6333)")
    parser.add_argument("--output", type=str, default=None,
                        help="Output report path (default: never-recalled-candidates-YYYY-MM-DD.md)")
    args = parser.parse_args()

    # Step 1: Collect all recalled point IDs from telemetry
    print(f"Parsing recall events from: {args.jsonl_dir}")
    recalled_ids = parse_recalled_point_ids(args.jsonl_dir)
    print(f"  Found {len(recalled_ids)} unique recalled point IDs")

    # Step 2: Fetch old points from Qdrant
    print(f"Querying Qdrant for points older than {args.threshold_days} days...")
    old_points = fetch_old_points(args.qdrant_url, args.threshold_days)
    print(f"  Found {len(old_points)} points older than threshold")

    # Step 3: Diff — points that are old but never recalled
    candidates = [p for p in old_points if p.get("id") not in recalled_ids]
    print(f"  {len(candidates)} points were never recalled")

    # Step 4: Cap at MAX_CANDIDATES
    if len(candidates) > MAX_CANDIDATES:
        print(f"  Capping at {MAX_CANDIDATES} candidates (from {len(candidates)})")
        candidates = candidates[:MAX_CANDIDATES]

    # Step 5: Generate report
    if not candidates:
        print("No candidates found. Nothing to report.")
        return

    output_path = args.output or f"never-recalled-candidates-{datetime.now().strftime('%Y-%m-%d')}.md"
    generate_report(candidates, args.threshold_days, output_path)
    print(f"Report written to: {output_path}")
    print(f"\nNext step: Review the report. Approve deletions with the operator before any bulk action.")


if __name__ == "__main__":
    main()
