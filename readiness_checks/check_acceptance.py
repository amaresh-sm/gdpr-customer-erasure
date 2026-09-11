#!/usr/bin/env python3
"""Check that acceptance criteria are complete and reference private checks."""

from __future__ import annotations

import argparse
import sys
import tomllib
from pathlib import Path
from typing import Any

try:
    from astra_harness.acceptance import read_acceptance
    from .common import emit_result
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from astra_harness.acceptance import read_acceptance
    from common import emit_result


REQUIRED_FIELDS = ("id", "requirement", "hidden_test", "mutant")


def task_id(task_dir: Path) -> str:
    """Read the task's stable ID without relying on its directory name."""

    try:
        data = tomllib.loads((task_dir / "task.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise SystemExit(f"cannot read task.toml: {exc}") from exc
    value = data.get("id")
    if not isinstance(value, str) or not value:
        raise SystemExit("task.toml has no valid id")
    return value


def check_acceptance(task_dir: Path, verifier_dir: Path) -> dict[str, Any]:
    """Validate acceptance completeness independently of score weights."""

    result: dict[str, Any] = {"check": "acceptance-criteria-completeness", "failures": []}
    try:
        expected_task_id = task_id(task_dir)
        acceptance_task_id, criteria = read_acceptance(verifier_dir / "acceptance-criteria.yml")
    except SystemExit as exc:
        result["failures"].append(str(exc))
        result["ok"] = False
        return result

    result.update({"task_id": expected_task_id, "criterion_count": len(criteria)})
    if acceptance_task_id != expected_task_id:
        result["failures"].append(
            f"acceptance task_id {acceptance_task_id!r} does not match task.toml id {expected_task_id!r}"
        )

    acceptance_by_id: dict[str, dict[str, object]] = {}
    for index, criterion in enumerate(criteria, start=1):
        missing = [field for field in REQUIRED_FIELDS if field not in criterion]
        if missing:
            result["failures"].append(f"criterion #{index} is missing: {', '.join(missing)}")
            continue
        criterion_id = criterion.get("id")
        if not isinstance(criterion_id, str) or not criterion_id.strip():
            result["failures"].append(f"criterion #{index} has no valid id")
            continue
        if criterion_id in acceptance_by_id:
            result["failures"].append(f"duplicate acceptance criterion id: {criterion_id}")
            continue
        for field in ("requirement", "hidden_test", "mutant"):
            if not isinstance(criterion.get(field), str) or not str(criterion[field]).strip():
                result["failures"].append(f"criterion {criterion_id!r} has no valid {field}")
        acceptance_by_id[criterion_id] = criterion
    result["ok"] = not result["failures"]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-dir", type=Path, default=Path("tasks"))
    parser.add_argument("--verifier-dir", type=Path, default=Path("verifier"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = check_acceptance(args.task_dir.resolve(), args.verifier_dir.resolve())
    emit_result(result, args.json)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
