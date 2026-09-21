# Task tooling

The ASTRA-compatible task package uses the scripts in this directory for validation, packaging,
Docker image setup, and evidence adaptation. PayFlow-specific candidate generation remains under
`scripts/candidates/` for candidate generation, telemetry collection, and scoring.

## Benchmarking report

Regenerate `benchmarking-data.md` from the canonical runs in
`benchmarking-runs/` with:

```bash
python3 scripts/update_benchmarking_data.py
```

Scores, telemetry, token usage, cache-read tokens, and estimated costs come from
`benchmarking-runs/`. Dependency counts and largest-file metrics are read from the
matching local candidate directory when available. “Largest file” means the eligible
core source/content file with the highest line count; generated artifacts, migrations
and database dumps, logs, reports, snapshots, caches, dependency manifests, lockfiles,
and `node_modules` are excluded. The report includes only completed runs with numeric
scores. Use `--dry-run` to preview candidate directories that would be archived.
