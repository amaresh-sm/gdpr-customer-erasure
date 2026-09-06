"""Convert the PayFlow ASTRA verifier report to a normalized weighted score."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from astra_harness.score import read_scoring


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    parser.add_argument("--scoring", default=str(Path(__file__).with_name("scoring.yml")))
    args = parser.parse_args()
    report = json.loads(args.report.read_text(encoding="utf-8"))
    reported = report.get("criteria", {}) if isinstance(report, dict) else {}
    criteria: dict[str, dict[str, object]] = {}
    total = 0.0
    hard_pass = True
    for item in read_scoring(Path(args.scoring)):
        criterion_id = str(item["id"])
        value = reported.get(criterion_id, {})
        status = str(value.get("status", "blocked")) if isinstance(value, dict) else "blocked"
        fraction = 1.0 if status == "pass" else 0.0
        awarded = float(item["weight"]) * fraction
        total += awarded
        hard_pass = hard_pass and status == "pass"
        criteria[criterion_id] = {
            "status": status,
            "score": fraction,
            "weight": item["weight"],
            "awarded": round(awarded, 10),
        }
    print(json.dumps({
        "task_id": "gdpr-customer-erasure",
        "score": round(total, 10),
        "hard_pass": hard_pass,
        "criteria": criteria,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
