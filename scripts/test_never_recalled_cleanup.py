#!/usr/bin/env python3
"""
Tests for the never-recalled-cleanup script.

Uses mock data — no live Qdrant instance required.
Run: python3 -m pytest test_never_recalled_cleanup.py -v
  or: python3 test_never_recalled_cleanup.py
"""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch, MagicMock

# Import the module under test (hyphenated filename requires importlib)
import importlib.util
_spec = importlib.util.spec_from_file_location(
    "never_recalled_cleanup",
    os.path.join(os.path.dirname(__file__), "never-recalled-cleanup.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
parse_recalled_point_ids = _mod.parse_recalled_point_ids
generate_report = _mod.generate_report
MAX_CANDIDATES = _mod.MAX_CANDIDATES


class TestParseRecalledPointIds(unittest.TestCase):
    def test_parses_point_ids_from_jsonl(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            jsonl_path = os.path.join(tmpdir, "recall-events-2026-03.jsonl")
            events = [
                {"point_ids": ["aaa", "bbb"], "found": 2},
                {"point_ids": ["ccc"], "found": 1},
                {"point_ids": ["aaa"], "found": 1},  # duplicate
            ]
            with open(jsonl_path, "w") as f:
                for e in events:
                    f.write(json.dumps(e) + "\n")

            recalled = parse_recalled_point_ids(tmpdir)
            self.assertEqual(recalled, {"aaa", "bbb", "ccc"})

    def test_handles_multiple_jsonl_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            for month in ["2026-01", "2026-02", "2026-03"]:
                path = os.path.join(tmpdir, f"recall-events-{month}.jsonl")
                with open(path, "w") as f:
                    f.write(json.dumps({"point_ids": [f"id-{month}"]}) + "\n")

            recalled = parse_recalled_point_ids(tmpdir)
            self.assertEqual(recalled, {"id-2026-01", "id-2026-02", "id-2026-03"})

    def test_skips_malformed_lines(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "recall-events-2026-03.jsonl")
            with open(path, "w") as f:
                f.write(json.dumps({"point_ids": ["good"]}) + "\n")
                f.write("this is not json\n")
                f.write(json.dumps({"point_ids": ["also-good"]}) + "\n")

            recalled = parse_recalled_point_ids(tmpdir)
            self.assertEqual(recalled, {"good", "also-good"})

    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            recalled = parse_recalled_point_ids(tmpdir)
            self.assertEqual(recalled, set())

    def test_events_with_no_point_ids_field(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "recall-events-2026-03.jsonl")
            with open(path, "w") as f:
                f.write(json.dumps({"found": 0}) + "\n")  # gap event, no point_ids

            recalled = parse_recalled_point_ids(tmpdir)
            self.assertEqual(recalled, set())


class TestCandidateIdentification(unittest.TestCase):
    """Test the diff logic (old points minus recalled = candidates)."""

    def test_identifies_never_recalled_points(self):
        recalled = {"aaa", "bbb"}
        old_points = [
            {"id": "aaa", "payload": {"createdAt": "2026-01-01"}},
            {"id": "ccc", "payload": {"createdAt": "2026-01-01"}},
            {"id": "ddd", "payload": {"createdAt": "2026-01-01"}},
        ]
        candidates = [p for p in old_points if p["id"] not in recalled]
        self.assertEqual(len(candidates), 2)
        self.assertEqual([c["id"] for c in candidates], ["ccc", "ddd"])

    def test_no_candidates_when_all_recalled(self):
        recalled = {"aaa", "bbb"}
        old_points = [
            {"id": "aaa", "payload": {}},
            {"id": "bbb", "payload": {}},
        ]
        candidates = [p for p in old_points if p["id"] not in recalled]
        self.assertEqual(candidates, [])

    def test_caps_at_max_candidates(self):
        recalled = set()
        old_points = [{"id": f"p-{i}", "payload": {}} for i in range(200)]
        candidates = [p for p in old_points if p["id"] not in recalled]
        capped = candidates[:MAX_CANDIDATES]
        self.assertEqual(len(capped), MAX_CANDIDATES)


class TestGenerateReport(unittest.TestCase):
    def test_generates_markdown_report(self):
        candidates = [
            {
                "id": "abc-123",
                "payload": {
                    "createdAt": "2026-01-15T10:00:00Z",
                    "userId": "jamebob",
                    "data": "User prefers dark mode in all applications",
                },
            },
            {
                "id": "def-456",
                "payload": {
                    "createdAt": "2026-01-20T14:30:00Z",
                    "userId": "family",
                    "data": "Family dinner is usually on Sundays",
                },
            },
        ]
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            output_path = f.name

        try:
            generate_report(candidates, 30, output_path)
            with open(output_path) as f:
                content = f.read()

            self.assertIn("Never-Recalled Memory Candidates", content)
            self.assertIn("abc-123", content)
            self.assertIn("def-456", content)
            self.assertIn("jamebob", content)
            self.assertIn("family", content)
            self.assertIn("dark mode", content)
            self.assertIn("Sundays", content)
            self.assertIn("2 (capped at 100)", content)
        finally:
            os.unlink(output_path)


if __name__ == "__main__":
    unittest.main()
