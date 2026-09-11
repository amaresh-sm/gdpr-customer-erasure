"""Tests for acceptance-criteria completeness validation."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from check_acceptance import check_acceptance


class AcceptanceReadinessTests(unittest.TestCase):
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
        return task, verifier

    def test_complete_acceptance_passes(self) -> None:
        task, verifier = self._package()
        self.assertTrue(check_acceptance(task, verifier)["ok"])

    def test_task_id_mismatch_fails(self) -> None:
        task, verifier = self._package()
        (verifier / "acceptance-criteria.yml").write_text(
            "task_id: wrong-task\ncriteria:\n"
            "  - id: api\n    requirement: The API works.\n    hidden_test: backend.api\n"
            "    mutant: api-noop\n"
        )
        result = check_acceptance(task, verifier)
        self.assertFalse(result["ok"])
        self.assertTrue(any("does not match" in failure for failure in result["failures"]))


if __name__ == "__main__":
    unittest.main()
