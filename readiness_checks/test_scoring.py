"""Tests for the private single-scorer manifest validation gate."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from check_scoring import check_scoring


class ScoringReadinessTests(unittest.TestCase):
    def _package(self) -> tuple[Path, Path]:
        root = Path(tempfile.mkdtemp())
        task = root / "tasks"
        verifier = root / "verifier"
        task.mkdir()
        verifier.mkdir()
        (task / "task.toml").write_text('id = "example-task"\nprofile = "greenfield"\ntitle = "Example"\n')
        (verifier / "acceptance-criteria.yml").write_text(
            "task_id: example-task\ncriteria:\n"
            "  - id: api\n    requirement: The API works.\n    hidden_test: backend.api\n"
            "    mutant: api-noop\n"
        )
        (verifier / "scoring.yml").write_text(json.dumps({
            "task_id": "example-task",
            "schema_version": 1,
            "scale": "normalized_1",
            "blocked_policy": "zero",
            "criteria": [{"id": "api", "check_ids": ["api.check"]}],
            "checks": [{
                "id": "api.check", "label": "API check", "maximum": 1.0, "criterion": "api"
            }],
        }) + "\n")
        return task, verifier

    def test_valid_manifest_passes(self) -> None:
        task, verifier = self._package()
        self.assertTrue(check_scoring(task, verifier)["ok"])

    def test_weight_drift_fails(self) -> None:
        task, verifier = self._package()
        manifest = json.loads((verifier / "scoring.yml").read_text())
        manifest["checks"][0]["maximum"] = 0.5
        (verifier / "scoring.yml").write_text(json.dumps(manifest))
        result = check_scoring(task, verifier)
        self.assertFalse(result["ok"])
        self.assertTrue(any("sum to" in failure for failure in result["failures"]))


if __name__ == "__main__":
    unittest.main()
