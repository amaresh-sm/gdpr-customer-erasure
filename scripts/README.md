# Task tooling

The ASTRA-compatible task package uses the scripts in this directory for validation, packaging,
Docker image setup, and evidence adaptation. PayFlow-specific candidate generation remains under
`scripts/candidates/` for candidate generation, telemetry collection, and scoring.

## Benchmarking report

Regenerate `benchmarking-data.md` and archive incomplete, failed, timed-out, or
unscored candidate directories with:

```bash
python3 scripts/update_benchmarking_data.py
```

The report includes only completed runs with numeric scores. Use `--dry-run` to preview which
directories would be archived.
