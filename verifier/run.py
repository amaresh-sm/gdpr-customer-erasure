"""Run PayFlow's private TypeScript checks against an already-started stack.

The normal PayFlow Docker scorer starts the stack itself. This adapter provides the black-box
interface expected by the ASTRA task shape while reusing the same hidden TypeScript verifier.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path


GROUPS: dict[str, tuple[str, ...]] = {
    "api-contract": ("api.", "workflow.completed"),
    "active-store-erasure": ("normal.",),
    "financial-retention": ("financial.retention", "financial.anonymous_retained_link"),
    "post-erasure-financial-work": ("financial.post_erasure_", "delayed.work_processes"),
    "failure-retry": ("async.request_accepted", "async.completion_gate"),
    "delayed-work": ("async.pending_payloads", "delayed.work_processes"),
    "replay-suppression": ("replay.",),
    "isolation-and-survivors": ("security.", "scope.", "security.survivor_"),
}


def status_for(checks: list[dict[str, object]], prefixes: tuple[str, ...]) -> dict[str, object]:
    selected = [
        check for check in checks
        if any(str(check.get("id", "")).startswith(prefix) for prefix in prefixes)
    ]
    if not selected:
        return {"status": "blocked", "score": 0.0, "evidence": "no mapped verifier checks"}
    states = {str(check.get("state", "blocked")) for check in selected}
    if "fail" in states:
        result = "fail"
    elif "blocked" in states:
        result = "blocked"
    else:
        result = "pass"
    return {
        "status": result,
        "score": 1.0 if result == "pass" else 0.0,
        "evidence": "; ".join(str(check.get("evidence")) for check in selected if check.get("evidence")),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1]
    raw_score = args.report.with_name("payflow-hidden.score.json")
    junit = args.report.with_name("payflow-hidden.junit.xml")
    environment = {
        **os.environ,
        "GATEWAY_URL": args.base_url,
        "JUNIT_PATH": str(junit),
        "ERASURE_SCORE_PATH": str(raw_score),
    }
    completed = subprocess.run(
        ["node", "--import", "tsx", "verifier/hidden-tests/run.ts"],
        cwd=root,
        env=environment,
        check=False,
    )
    if not raw_score.is_file():
        args.report.write_text(json.dumps({
            "status": "blocked",
            "exit_code": completed.returncode,
            "criteria": {
                criterion: {"status": "blocked", "score": 0.0}
                for criterion in GROUPS
            },
        }, indent=2) + "\n", encoding="utf-8")
        return 1

    raw = json.loads(raw_score.read_text(encoding="utf-8"))
    checks = raw.get("checks", []) if isinstance(raw, dict) else []
    criteria = {
        criterion: status_for(checks, prefixes)
        for criterion, prefixes in GROUPS.items()
    }
    overall = all(value["status"] == "pass" for value in criteria.values())
    args.report.write_text(json.dumps({
        "status": "pass" if overall else "fail",
        "exit_code": completed.returncode,
        "criteria": criteria,
        "source_score": raw,
    }, indent=2) + "\n", encoding="utf-8")
    return 0 if overall else 1


if __name__ == "__main__":
    raise SystemExit(main())
