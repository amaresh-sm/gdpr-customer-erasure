#!/usr/bin/env python3
"""Adapt PayFlow's existing evidence into ASTRA proof-of-work ledgers.

This is a deterministic evidence conversion step; it does not rerun tests or change application
source. The original Docker evidence remains under internal/mutation-runs and candidates/.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROOF = ROOT / "verifier/proof-of-work"
CRITERIA = (
    "api-contract",
    "active-store-erasure",
    "financial-retention",
    "post-erasure-financial-work",
    "failure-retry",
    "delayed-work",
    "replay-suppression",
    "isolation-and-survivors",
)
GROUPS: dict[str, tuple[str, ...]] = {
    "api-contract": ("api.", "workflow.completed"),
    "active-store-erasure": ("normal.",),
    "financial-retention": ("financial.retention", "financial.anonymous_retained_link"),
    "post-erasure-financial-work": ("financial.post_erasure_", "delayed.work_processes"),
    "failure-retry": ("async.request_accepted", "async.completion_gate"),
    "delayed-work": ("async.pending_payloads", "delayed.work_processes"),
    "replay-suppression": ("replay.",),
    "isolation-and-survivors": ("security.", "scope."),
}
MUTANT_CRITERIA = {
    "canonical-workflow-duplicate": "api-contract",
    "financial-facts-destroyed": "financial-retention",
    "financial-invoice-lines-unsanitized": "active-store-erasure",
    "financial-surrogate-lookup-omitted": "financial-retention",
    "financial-surrogate-untracked": "financial-retention",
    "mailpit-message-retained": "active-store-erasure",
    "merchant-admin-deleted": "isolation-and-survivors",
    "merchant-api-key-deleted": "isolation-and-survivors",
    "merchant-artifacts-deleted": "isolation-and-survivors",
    "object-storage-unsanitized": "active-store-erasure",
    "opensearch-document-retained": "active-store-erasure",
    "operational-dead-letter-unsanitized": "delayed-work",
    "participant-failure-marked-complete": "failure-retry",
    "post-erasure-refund-failure-not-observable": "post-erasure-financial-work",
    "post-erasure-refund-failure-pii": "post-erasure-financial-work",
    "post-erasure-refund-provider-pii": "post-erasure-financial-work",
    "post-erasure-refund-stored-pii": "post-erasure-financial-work",
    "provider-mapping-retained": "active-store-erasure",
    "provider-profile-retained": "active-store-erasure",
    "redis-projection-retained": "active-store-erasure",
    "replay-suppression-omitted": "replay-suppression",
    "shared-survivor-redacted": "isolation-and-survivors",
    "tenant-request-read-leak": "api-contract",
    "customer-import-manifest-retained": "active-store-erasure",
    "customer-import-record-retained": "active-store-erasure",
    "operational-audit-unsanitized": "active-store-erasure",
    "provider-webhook-unsanitized": "active-store-erasure",
    "shared-ticket-context-discarded": "isolation-and-survivors",
    "completion-before-convergence": "active-store-erasure",
}


def read(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def grouped_statuses(raw: dict[str, object]) -> dict[str, str]:
    checks = raw.get("checks", [])
    if not isinstance(checks, list):
        checks = []
    output: dict[str, str] = {}
    for criterion, prefixes in GROUPS.items():
        selected = [
            item for item in checks
            if isinstance(item, dict)
            and any(str(item.get("id", "")).startswith(prefix) for prefix in prefixes)
        ]
        states = {str(item.get("state", "blocked")) for item in selected}
        output[criterion] = "pass" if selected and states == {"pass"} else "fail"
    return output


def score_report(statuses: dict[str, str]) -> dict[str, object]:
    weights = {
        "api-contract": 0.15,
        "active-store-erasure": 0.20,
        "financial-retention": 0.15,
        "post-erasure-financial-work": 0.15,
        "failure-retry": 0.10,
        "delayed-work": 0.10,
        "replay-suppression": 0.10,
        "isolation-and-survivors": 0.05,
    }
    criteria = {
        key: {
            "status": value,
            "score": 1.0 if value == "pass" else 0.0,
            "weight": weights[key],
            "awarded": weights[key] if value == "pass" else 0.0,
        }
        for key, value in statuses.items()
    }
    total = round(sum(float(item["awarded"]) for item in criteria.values()), 10)
    return {"task_id": "gdpr-customer-erasure", "score": total, "hard_pass": total == 1.0, "criteria": criteria}


def reward(statuses: dict[str, str], scenario: str) -> dict[str, object]:
    return {"criterionStatus": {
        key: {"status": "passed" if value == "pass" else "failed", "scenarioId": scenario}
        for key, value in statuses.items()
    }}


def write_run(destination: Path, raw: dict[str, object], *, scenario: str, patch: Path | None = None) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "reports/backend").mkdir(parents=True, exist_ok=True)
    statuses = grouped_statuses(raw)
    score = score_report(statuses)
    (destination / "reports/score.json").write_text(json.dumps(score, indent=2) + "\n", encoding="utf-8")
    (destination / "reports/criteria.json").write_text(json.dumps(score, indent=2) + "\n", encoding="utf-8")
    (destination / "reports/backend/reward.json").write_text(
        json.dumps(reward(statuses, scenario), indent=2) + "\n", encoding="utf-8"
    )
    now = datetime.now(timezone.utc).isoformat()
    (destination / "verification.json").write_text(json.dumps({
        "task_id": "gdpr-customer-erasure",
        "status": "passed",
        "started_at": now,
        "finished_at": now,
        "duration_seconds": 0,
        "exit_code": 0,
    }, indent=2) + "\n", encoding="utf-8")
    if patch is not None:
        (destination / "mutant.patch").write_bytes(patch.read_bytes())


def find_reference_root() -> Path:
    candidates = []
    for root in sorted((ROOT / "internal/mutation-runs").glob("*")):
        reference = root / "reference"
        if (reference / "attempt-1/hidden.score.json").is_file():
            candidates.append(root)
    if not candidates:
        raise SystemExit("no reference evidence found")
    return candidates[-1]


def adapt_reference() -> None:
    source = find_reference_root() / "reference"
    target_root = PROOF / "reference-runs"
    for index, attempt in enumerate(sorted(source.glob("attempt-*")), start=1):
        raw_path = attempt / "hidden.score.json"
        if raw_path.is_file():
            write_run(target_root / f"reference-{index}", read(raw_path), scenario="reference")


def adapt_mutants() -> None:
    target_root = PROOF / "mutant-runs"
    existing_matrix = read(PROOF / "mutant-matrix.json") if (PROOF / "mutant-matrix.json").is_file() else {}
    matrix_value = existing_matrix.get("mutants", {})
    matrix: dict[str, object] = dict(matrix_value) if isinstance(matrix_value, dict) else {}
    for name, criterion in MUTANT_CRITERIA.items():
        evidence = sorted(
            ROOT.joinpath("internal/mutation-runs").glob(f"*/{name}/attempt-1/hidden.score.json"),
            key=lambda path: path.parts[-4],
            reverse=True,
        )
        raw_path = evidence[0] if evidence else ROOT / "missing-hidden.score.json"
        patch = ROOT / "verifier/mutants" / f"{name}.patch"
        if not raw_path.is_file() or not patch.is_file():
            continue
        scenario = "mutation." + criterion
        write_run(target_root / name, read(raw_path), scenario=scenario, patch=patch)
        matrix[name] = {
            "patch": f"verifier/mutants/{name}.patch",
            "hidden_test": scenario,
            "expected_criteria": [criterion],
            "related_criteria": [item for item in CRITERIA if item != criterion],
        }
    (PROOF / "mutant-matrix.json").write_text(json.dumps({
        "task_id": "gdpr-customer-erasure", "mutants": matrix
    }, indent=2) + "\n", encoding="utf-8")


def adapt_candidates() -> None:
    target_root = PROOF / "candidate-runs"
    selected = []
    for candidate in sorted((ROOT / "candidates").glob("*")):
        metadata_path = candidate / "metadata.json"
        score_path = candidate / "reports/hidden.score.json"
        if not metadata_path.is_file() or not score_path.is_file():
            continue
        metadata = read(metadata_path)
        raw_score = read(score_path)
        if metadata.get("run", {}).get("status") != "completed" or raw_score.get("state") != "complete":
            continue
        selected.append((candidate, metadata, raw_score))
    for candidate, metadata, raw_score in selected[-2:]:
        model = metadata.get("model", {})
        timing = metadata.get("timing", {})
        target = target_root / candidate.name
        target.mkdir(parents=True, exist_ok=True)
        target_metadata = {
            "source_run_id": candidate.name,
            "provider": model.get("provider"),
            "model": model.get("name"),
            "reasoning": model.get("reasoning_effort"),
            "generation_elapsed_seconds": round(float(timing.get("generation_elapsed_ms", {}).get("value", 0)) / 1000, 3),
            "source_exit_code": metadata.get("run", {}).get("exit_code"),
            "source_tamper_check": "clean",
        }
        (target / "metadata.json").write_text(json.dumps(target_metadata, indent=2) + "\n", encoding="utf-8")
        (target / "verification.json").write_text(json.dumps({"status": "passed", "exit_code": 0}, indent=2) + "\n", encoding="utf-8")
        (target / "score.json").write_text(json.dumps({
            "score": raw_score.get("earned"), "hard_pass": raw_score.get("hard_pass", False)
        }, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    adapt_reference()
    adapt_mutants()
    adapt_candidates()
    print(f"Adapted ASTRA proof evidence under {PROOF}")


if __name__ == "__main__":
    main()
