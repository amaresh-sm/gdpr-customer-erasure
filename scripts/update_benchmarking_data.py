#!/usr/bin/env python3
"""Archive invalid candidate runs and regenerate the benchmarking Markdown report.

The report intentionally contains only completed runs with numeric verifier scores.
Runs without metadata, failed runs, timed-out runs, and completed-but-unscored runs
are moved under ``benchmarking-candidates/failed`` so they cannot be mistaken for
benchmark results.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CANDIDATE_ROOT = ROOT / "benchmarking-candidates"
RUNS_ROOT = ROOT / "benchmarking-runs"
FAILED_ROOT = CANDIDATE_ROOT / "failed"
REPORT_PATH = ROOT / "benchmarking-data.md"
GATEWAY_SRC = ROOT.parent / "hackerrank-openhands-gateway" / "src"

if GATEWAY_SRC.is_dir():
    sys.path.insert(0, str(GATEWAY_SRC))

try:
    from hackerrank_openhands.pricing import estimate_custom_cost
except ImportError as exc:  # pragma: no cover - environment/setup guard
    raise SystemExit(
        f"Cannot load gateway pricing logic from {GATEWAY_SRC}. "
        "Clone hackerrank-openhands-gateway beside this repository first."
    ) from exc


MODEL_NAMES = {
    "claude-opus-5": "Claude Opus 5",
    "claude-sonnet-5": "Claude Sonnet 5",
    "deepseek-v4-pro": "DeepSeek V4 Pro",
    "gemini-3.7-flash": "Gemini 3.7 Flash",
    "glm-5.2": "GLM-5.2",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "gpt-5.6-terra": "GPT-5.6 Terra",
    "grok-4.5": "Grok 4.5",
    "grok-4.6": "Grok 4.6",
    "kimi-k3": "Kimi K3",
    "minimax-m3": "Minimax M3",
    "qwen-3.8": "Qwen 3.8",
}

EXCLUDED_PARTS = {
    ".git",
    ".cache",
    ".pytest_cache",
    "artifacts",
    "cache",
    "coverage",
    "dist",
    "build",
    "fixtures",
    "logs",
    "migrations",
    "node_modules",
    "reports",
    "snapshots",
    "tmp",
    "vendor",
}
EXCLUDED_NAMES = {
    ".dockerignore",
    ".env",
    ".env.docker",
    ".env.example",
    ".gitattributes",
    ".gitignore",
    "Dockerfile",
    "Cargo.lock",
    "Gemfile.lock",
    "go.sum",
    "docker-compose.yml",
    "eslint.config.js",
    "metadata.json",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "Pipfile.lock",
    "tsconfig.json",
    "yarn.lock",
}
CODE_OR_CONTENT_SUFFIXES = {
    ".bash",
    ".c",
    ".cc",
    ".cpp",
    ".css",
    ".go",
    ".h",
    ".hpp",
    ".html",
    ".java",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".mdx",
    ".mjs",
    ".mts",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".scss",
    ".sh",
    ".sql",
    ".svelte",
    ".ts",
    ".tsx",
    ".vue",
    ".yaml",
    ".yml",
}


def numeric(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def nested_value(document: dict[str, Any], *path: str) -> Any:
    value: Any = document
    for key in path:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def first_number(*values: Any) -> int | float | None:
    for value in values:
        parsed = numeric(value)
        if parsed is not None:
            return parsed
    return None


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def first_existing(run_dir: Path, *relative_paths: str) -> Path | None:
    """Return the first available artifact path in the canonical or legacy layout."""
    for relative_path in relative_paths:
        path = run_dir / relative_path
        if path.is_file():
            return path
    return None


def gateway_usages(run_dir: Path) -> list[dict[str, Any]]:
    path = first_existing(run_dir, "logs/openhands-gateway_responses.jsonl")
    if path is None:
        return []
    usages: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        usage = nested_value(record, "response", "usage")
        if isinstance(usage, dict) and first_number(usage.get("prompt_tokens"), usage.get("input_tokens")) is not None:
            usages.append(usage)
    return usages


def aggregate_gateway_usage(usages: list[dict[str, Any]]) -> dict[str, int] | None:
    if not usages:
        return None
    total = {"input_tokens": 0, "cached_input_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0, "total_tokens": 0}
    for usage in usages:
        input_tokens = int(first_number(usage.get("prompt_tokens"), usage.get("input_tokens")) or 0)
        output_tokens = int(first_number(usage.get("completion_tokens"), usage.get("output_tokens")) or 0)
        details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
        completion_details = usage.get("completion_tokens_details") or usage.get("output_tokens_details") or {}
        cached = int(first_number(
            usage.get("cached_input_tokens"),
            usage.get("cache_read_tokens"),
            usage.get("cached_tokens"),
            details.get("cached_tokens") if isinstance(details, dict) else None,
        ) or 0)
        reasoning = int(first_number(
            usage.get("reasoning_tokens"),
            completion_details.get("reasoning_tokens") if isinstance(completion_details, dict) else None,
        ) or 0)
        total["input_tokens"] += input_tokens
        total["cached_input_tokens"] += cached
        total["output_tokens"] += output_tokens
        total["reasoning_tokens"] += reasoning
        total["total_tokens"] += int(first_number(usage.get("total_tokens")) or input_tokens + output_tokens)
    return total


def score_for(run_dir: Path) -> float | None:
    score_path = first_existing(run_dir, "score/hidden.score.json", "reports/hidden.score.json")
    score = read_json(score_path) if score_path else None
    return numeric(score.get("earned")) if score else None


def archive_invalid_runs(*, dry_run: bool) -> list[str]:
    FAILED_ROOT.mkdir(parents=True, exist_ok=True)
    archived: list[str] = []
    for run_dir in sorted(CANDIDATE_ROOT.iterdir()):
        if not run_dir.is_dir() or run_dir.name == FAILED_ROOT.name:
            continue
        metadata = read_json(run_dir / "metadata.json")
        score = score_for(run_dir)
        completed = metadata and nested_value(metadata, "run", "status") == "completed"
        if metadata and completed and score is not None:
            continue
        destination = FAILED_ROOT / run_dir.name
        if destination.exists():
            raise SystemExit(f"Refusing to overwrite existing failed run: {destination}")
        archived.append(run_dir.name)
        if not dry_run:
            shutil.move(str(run_dir), str(destination))
    return archived


def format_count(value: int | float | None) -> str:
    if value is None:
        return "—"
    value = float(value)
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(int(value))


def format_cost(value: int | float | None) -> str:
    return "—" if value is None else f"${value:.4f}"


def format_duration(milliseconds: int | float | None) -> str:
    if milliseconds is None:
        return "—"
    seconds = max(0, int(round(milliseconds / 1000)))
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"


def markdown(value: Any) -> str:
    return str(value if value not in (None, "") else "—").replace("|", "\\|").replace("\n", " ")


def dependency_count(source: Path) -> int | None:
    package = read_json(source / "package.json")
    if not package:
        return None
    dependencies = package.get("dependencies") or {}
    dev_dependencies = package.get("devDependencies") or {}
    if not isinstance(dependencies, dict) or not isinstance(dev_dependencies, dict):
        return None
    return len(dependencies) + len(dev_dependencies)


def actual_largest_file(source: Path) -> str | None:
    """Find the largest eligible core file by line count.

    Benchmark metadata should describe the candidate's substantive source/content,
    not generated artifacts, dependency manifests, database migrations/dumps, logs,
    caches, or lockfiles.  Line count is used instead of byte size so formatting or
    minification cannot make an incidental file appear to be the largest.
    """
    if not source.is_dir():
        return None
    candidates: list[tuple[int, Path]] = []
    for path in source.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        if any(part in EXCLUDED_PARTS for part in relative.parts) or path.name in EXCLUDED_NAMES:
            continue
        if path.suffix.lower() not in CODE_OR_CONTENT_SUFFIXES:
            continue
        try:
            with path.open("r", encoding="utf-8", errors="replace") as handle:
                line_count = sum(1 for _ in handle)
        except (OSError, UnicodeError):
            continue
        candidates.append((line_count, relative))
    if not candidates:
        return None
    line_count, relative = max(candidates, key=lambda item: (item[0], str(item[1])))
    return f"{relative} ({line_count} LOC)"


def test_summary(run_dir: Path) -> str:
    path = run_dir / "reports" / "hidden.junit.xml"
    if not path.is_file():
        return "—"
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError:
        return "—"
    tests = int(root.attrib.get("tests", 0))
    failures = int(root.attrib.get("failures", 0)) + int(root.attrib.get("errors", 0)) + int(root.attrib.get("skipped", 0))
    return f"{max(0, tests - failures)}/{tests}" if tests else "—"


def run_row(run_dir: Path) -> dict[str, Any] | None:
    metadata = read_json(run_dir / "metadata.json")
    score = score_for(run_dir)
    if not metadata or nested_value(metadata, "run", "status") != "completed" or score is None:
        return None
    model_slug = str(nested_value(metadata, "model", "name") or "").removeprefix("openai/")
    model = MODEL_NAMES.get(model_slug, model_slug)
    reasoning = nested_value(metadata, "model", "reasoning_effort") or "—"
    telemetry_path = first_existing(run_dir, "telemetry/openhands-telemetry.json", "logs/openhands-telemetry.json")
    telemetry = read_json(telemetry_path) if telemetry_path else {}
    telemetry = telemetry or {}
    usage = telemetry.get("usage") if isinstance(telemetry.get("usage"), dict) else {}
    input_tokens = first_number(usage.get("input_tokens"), nested_value(metadata, "tokens", "input", "value"))
    output_tokens = first_number(usage.get("output_tokens"), nested_value(metadata, "tokens", "output", "value"))
    reasoning_tokens = first_number(usage.get("reasoning_tokens"), nested_value(metadata, "tokens", "reasoning", "value"))
    cache_read_tokens = first_number(
        usage.get("cache_read_tokens"),
        usage.get("cached_input_tokens"),
        nested_value(metadata, "tokens", "cached_input", "value"),
    )
    openhands_usage = {
        "input_tokens": input_tokens or 0,
        "output_tokens": output_tokens or 0,
        "reasoning_tokens": reasoning_tokens or 0,
        "cached_input_tokens": cache_read_tokens or 0,
        "cache_read_tokens": cache_read_tokens or 0,
    }
    # Use the canonical telemetry/metadata usage so cache backfills affect the
    # estimate. Raw gateway logs may predate the backfill and are not preferred.
    estimated = estimate_custom_cost(model_slug, gateway_usages=(), openhands_usage=openhands_usage)
    gateway_reported = first_number(nested_value(telemetry, "cost", "gateway", "amount_usd"), nested_value(metadata, "tokens", "gateway_cost_usd", "value"))
    openhands_reported = first_number(nested_value(telemetry, "cost", "openhands", "amount_usd"), nested_value(metadata, "tokens", "cost_usd", "value"))
    reported = gateway_reported if gateway_reported and gateway_reported > 0 else openhands_reported if openhands_reported and openhands_reported > 0 else None
    files_total = first_number(nested_value(telemetry, "workspace", "files", "total_changed"))
    loc_total = first_number(nested_value(telemetry, "workspace", "lines", "changed"))
    tools_total = first_number(nested_value(telemetry, "tools", "total"), nested_value(metadata, "tool_usage", "total", "value"))
    iteration_steps = first_number(nested_value(telemetry, "trace", "event_count"))
    source = CANDIDATE_ROOT / run_dir.name / "source"
    return {
        "run": run_dir.name,
        "model": model,
        "reasoning": reasoning,
        "score": f"{score:.4f}",
        "tokens": f"{format_count(input_tokens)}/{format_count(output_tokens)}/{format_count(reasoning_tokens)}/{format_count(cache_read_tokens)}",
        "estimated": estimated.get("amount_usd"),
        "reported": reported,
        "duration": format_duration(first_number(nested_value(metadata, "timing", "generation_elapsed_ms"), nested_value(telemetry, "timing", "duration_ms"))),
        "files": int(files_total) if files_total is not None else None,
        "loc": int(loc_total) if loc_total is not None else None,
        "tests": test_summary(run_dir),
        "deps": dependency_count(source),
        "largest": actual_largest_file(source),
        "tools": int(tools_total) if tools_total is not None else None,
        "iteration_steps": int(iteration_steps) if iteration_steps is not None else None,
        "status": "completed",
    }


def render(rows: list[dict[str, Any]]) -> str:
    groups: defaultdict[tuple[str, str], int] = defaultdict(int)
    for row in rows:
        groups[(row["model"], row["reasoning"])] += 1
    complete_groups = sum(count >= 3 for count in groups.values())
    qwen_medium = groups.get(("Qwen 3.8", "medium"), 0)
    needs = max(0, 3 - qwen_medium)
    needs_text = f"needs **{needs} additional scored run**" if needs == 1 else f"needs **{needs} additional scored runs**"
    lines = [
        "# PayFlow benchmarking data",
        "",
        f"Coverage: **{complete_groups} of {len(groups)} model/reasoning groups have three scored runs**. `Qwen 3.8 · medium` has **{qwen_medium} scored runs** and {needs_text}. Failed and timed-out attempts are archived under `benchmarking-candidates/failed/`.",
        "",
        "Generated by `python3 scripts/update_benchmarking_data.py`.",
        "",
        "| Run-name (unique Id) | Model Name | Reasoning | Score | Token (input/output/reasoning/cache-read) | Tool calls | Iteration steps | Est cost | Reported cost | Duration | Total Files | LOC | Deps | Largest file |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        values = [
            row["run"], row["model"], row["reasoning"], row["score"], row["tokens"],
            row["tools"], row["iteration_steps"], format_cost(row["estimated"]),
            format_cost(row["reported"]), row["duration"], row["files"], row["loc"],
            row["deps"], row["largest"],
        ]
        lines.append("| " + " | ".join(markdown(value) for value in values) + " |")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="List invalid runs without moving them or writing the report")
    args = parser.parse_args()
    archived = archive_invalid_runs(dry_run=args.dry_run)
    if archived:
        print("Archived invalid runs:")
        for name in archived:
            print(f"- {name}")
    run_root = RUNS_ROOT if RUNS_ROOT.is_dir() else CANDIDATE_ROOT
    paths = sorted(run_root.glob("*/*/*")) if run_root == RUNS_ROOT else sorted(CANDIDATE_ROOT.iterdir())
    rows = [row for path in paths if path.is_dir() and path.name != FAILED_ROOT.name for row in [run_row(path)] if row]
    rows.sort(key=lambda row: row["run"])
    if not args.dry_run:
        REPORT_PATH.write_text(render(rows), encoding="utf-8")
        print(f"Wrote {REPORT_PATH} with {len(rows)} scored runs.")
    else:
        print(f"Would retain {len(rows)} scored runs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
