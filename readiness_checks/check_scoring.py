#!/usr/bin/env python3
"""Validate the private score manifest used by the single PayFlow scorer."""

from __future__ import annotations

import argparse
import json
import math
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


def check_scoring(task_dir: Path, verifier_dir: Path) -> dict[str, Any]:
    """Validate manifest structure, acceptance coverage, and normalized weights."""

    result: dict[str, Any] = {"check": "scoring-manifest", "failures": []}
    manifest_path = verifier_dir / "scoring.yml"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        expected_task_id = task_id(task_dir)
        acceptance_task_id, criteria = read_acceptance(verifier_dir / "acceptance-criteria.yml")
    except (OSError, json.JSONDecodeError, SystemExit) as exc:
        result["failures"].append(str(exc))
        result["ok"] = False
        return result

    if not isinstance(manifest, dict):
        result["failures"].append("scoring manifest must be an object")
        result["ok"] = False
        return result

    result.update({
        "task_id": expected_task_id,
        "criterion_count": len(criteria),
        "check_count": len(manifest.get("checks", [])) if isinstance(manifest.get("checks"), list) else 0,
    })
    if manifest.get("task_id") != expected_task_id:
        result["failures"].append("scoring manifest task_id does not match task.toml")
    if acceptance_task_id != expected_task_id:
        result["failures"].append("acceptance criteria task_id does not match task.toml")
    if manifest.get("schema_version") != 1:
        result["failures"].append("scoring manifest schema_version must be 1")
    if manifest.get("scale") != "normalized_1":
        result["failures"].append("scoring manifest scale must be normalized_1")
    if manifest.get("blocked_policy") != "zero":
        result["failures"].append("scoring manifest blocked_policy must be zero")

    manifest_criteria = manifest.get("criteria")
    checks = manifest.get("checks")
    if not isinstance(manifest_criteria, list) or not isinstance(checks, list):
        result["failures"].append("scoring manifest must contain criteria and checks arrays")
        result["ok"] = False
        return result

    acceptance_ids = {criterion.get("id") for criterion in criteria if isinstance(criterion, dict)}
    criterion_ids: set[str] = set()
    criterion_check_ids: list[str] = []
    for criterion in manifest_criteria:
        if not isinstance(criterion, dict) or not isinstance(criterion.get("id"), str):
            result["failures"].append("each scoring criterion needs a string id")
            continue
        criterion_id = criterion["id"]
        if criterion_id in criterion_ids:
            result["failures"].append(f"duplicate scoring criterion id: {criterion_id}")
        criterion_ids.add(criterion_id)
        check_ids = criterion.get("check_ids")
        if not isinstance(check_ids, list) or not all(isinstance(item, str) for item in check_ids):
            result["failures"].append(f"criterion {criterion_id!r} needs a string check_ids list")
            continue
        if len(check_ids) != len(set(check_ids)):
            result["failures"].append(f"criterion {criterion_id!r} repeats a check id")
        criterion_check_ids.extend(check_ids)

    if criterion_ids != acceptance_ids:
        result["failures"].append("scoring criteria do not match acceptance criteria")

    canonical_ids: set[str] = set()
    alias_ids: set[str] = set()
    total = 0.0
    for check in checks:
        if not isinstance(check, dict):
            result["failures"].append("each scoring check must be an object")
            continue
        check_id = check.get("id")
        if not isinstance(check_id, str) or not check_id.strip():
            result["failures"].append("each scoring check needs a string id")
            continue
        if check_id in canonical_ids or check_id in alias_ids:
            result["failures"].append(f"duplicate scoring check id: {check_id}")
        canonical_ids.add(check_id)
        if not isinstance(check.get("label"), str) or not check["label"].strip():
            result["failures"].append(f"check {check_id!r} has no label")
        maximum = check.get("maximum")
        if isinstance(maximum, bool) or not isinstance(maximum, (int, float)) or not math.isfinite(maximum):
            result["failures"].append(f"check {check_id!r} has no finite numeric maximum")
        elif maximum < 0 or maximum > 1:
            result["failures"].append(f"check {check_id!r} maximum is outside [0, 1]")
        else:
            total += float(maximum)
        criterion = check.get("criterion")
        if criterion not in criterion_ids:
            result["failures"].append(f"check {check_id!r} references unknown criterion {criterion!r}")
        aliases = check.get("aliases", [])
        if not isinstance(aliases, list) or not all(isinstance(alias, str) and alias.strip() for alias in aliases):
            result["failures"].append(f"check {check_id!r} has invalid aliases")
            continue
        for alias in aliases:
            if alias == check_id or alias in canonical_ids or alias in alias_ids:
                result["failures"].append(f"duplicate scoring check alias: {alias}")
            alias_ids.add(alias)

    if abs(total - 1.0) > 0.0001:
        result["failures"].append(f"scoring maximums sum to {total:.4f}, expected 1.0000")
    if set(criterion_check_ids) != canonical_ids:
        result["failures"].append("criteria check_ids do not cover each canonical scoring check exactly")

    result["maximum_total"] = round(total, 4)
    result["ok"] = not result["failures"]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task-dir", type=Path, default=Path("tasks"))
    parser.add_argument("--verifier-dir", type=Path, default=Path("verifier"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = check_scoring(args.task_dir.resolve(), args.verifier_dir.resolve())
    emit_result(result, args.json)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
