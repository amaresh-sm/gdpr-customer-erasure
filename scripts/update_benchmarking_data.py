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
    "cache",
    "coverage",
    "dist",
    "build",
    "node_modules",
}
EXCLUDED_NAMES = {
    ".dockerignore",
    ".env",
    ".env.docker",
    ".env.example",
    ".gitattributes",
    ".gitignore",
    "Dockerfile",
    "docker-compose.yml",
    "eslint.config.js",
    "metadata.json",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
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


def gateway_usages(run_dir: Path) -> list[dict[str, Any]]:
    path = run_dir / "logs" / "openhands-gateway_responses.jsonl"
    if not path.is_file():
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
    score = read_json(run_dir / "reports" / "hidden.score.json")
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
    telemetry = read_json(run_dir / "logs" / "openhands-telemetry.json") or {}
    usage = telemetry.get("usage") if isinstance(telemetry.get("usage"), dict) else {}
    raw_usages = gateway_usages(run_dir)
    gateway_aggregate = aggregate_gateway_usage(raw_usages)
    input_tokens = first_number(usage.get("input_tokens"), nested_value(metadata, "tokens", "input", "value"), gateway_aggregate and gateway_aggregate["input_tokens"])
    output_tokens = first_number(usage.get("output_tokens"), nested_value(metadata, "tokens", "output", "value"), gateway_aggregate and gateway_aggregate["output_tokens"])
    reasoning_tokens = first_number(usage.get("reasoning_tokens"), nested_value(metadata, "tokens", "reasoning", "value"), gateway_aggregate and gateway_aggregate["reasoning_tokens"])
    cached_tokens = first_number(usage.get("cached_input_tokens"), usage.get("cache_read_tokens"), nested_value(metadata, "tokens", "cached_input", "value"), gateway_aggregate and gateway_aggregate["cached_input_tokens"])
    openhands_usage = {"input_tokens": input_tokens or 0, "output_tokens": output_tokens or 0, "reasoning_tokens": reasoning_tokens or 0, "cached_input_tokens": cached_tokens or 0}
    estimated = estimate_custom_cost(model_slug, gateway_usages=raw_usages, openhands_usage=openhands_usage)
    gateway_reported = first_number(nested_value(telemetry, "cost", "gateway", "amount_usd"), nested_value(metadata, "tokens", "gateway_cost_usd", "value"))
    openhands_reported = first_number(nested_value(telemetry, "cost", "openhands", "amount_usd"), nested_value(metadata, "tokens", "cost_usd", "value"))
    reported = gateway_reported if gateway_reported and gateway_reported > 0 else openhands_reported if openhands_reported and openhands_reported > 0 else None
    files_total = first_number(nested_value(telemetry, "workspace", "files", "total_changed"))
    loc_total = first_number(nested_value(telemetry, "workspace", "lines", "changed"))
    tools_total = first_number(nested_value(telemetry, "tools", "total"), nested_value(metadata, "tool_usage", "total", "value"))
    tools_failed = first_number(nested_value(telemetry, "tools", "failed"), nested_value(metadata, "tool_usage", "failed", "value"))
    events = first_number(nested_value(telemetry, "trace", "event_count"))
    return {
        "run": run_dir.name,
        "model": model,
        "reasoning": reasoning,
        "score": f"{score:.4f}",
        "tokens": f"{format_count(input_tokens)}/{format_count(output_tokens)}/{format_count(reasoning_tokens)}/{format_count(cached_tokens)}",
        "estimated": estimated.get("amount_usd"),
        "reported": reported,
        "duration": format_duration(first_number(nested_value(metadata, "timing", "generation_elapsed_ms"), nested_value(telemetry, "timing", "duration_ms"))),
        "files": int(files_total) if files_total is not None else None,
        "loc": int(loc_total) if loc_total is not None else None,
        "tests": test_summary(run_dir),
        "deps": dependency_count(run_dir / "source"),
        "tools": int(tools_total) if tools_total is not None else None,
        "tools_failed": int(tools_failed) if tools_failed is not None else None,
        "events": int(events) if events is not None else None,
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
        "| Run name | Model | Reasoning | Score | Tokens (in/out/r/cache) | Est cost (USD) | Reported cost (USD) | Duration | Files total | LOC total | Tests | Deps | Tool calls | Tool calls failed | Events | Status |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in rows:
        values = [
            row["run"], row["model"], row["reasoning"], row["score"], row["tokens"],
            format_cost(row["estimated"]), format_cost(row["reported"]), row["duration"],
            row["files"], row["loc"], row["tests"], row["deps"], row["tools"],
            row["tools_failed"], row["events"], row["status"],
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
    rows = [row for path in sorted(CANDIDATE_ROOT.iterdir()) if path.is_dir() and path.name != FAILED_ROOT.name for row in [run_row(path)] if row]
    rows.sort(key=lambda row: row["run"])
    if not args.dry_run:
        REPORT_PATH.write_text(render(rows), encoding="utf-8")
        print(f"Wrote {REPORT_PATH} with {len(rows)} scored runs.")
    else:
        print(f"Would retain {len(rows)} scored runs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
