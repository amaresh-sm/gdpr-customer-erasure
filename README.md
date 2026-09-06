# GDPR Customer Erasure Benchmark

This is an evaluator repository. The benchmark is deliberately laid out as physical assets so the
candidate baseline, complete reference implementation, private verifier, and locally retained model
attempts are distinct and auditable.

```text
instruction/                candidate-facing task instruction
codebase/                   incomplete PayFlow app copied to a candidate
reference_solution/source/  frozen complete reference app
hidden_tests/               evaluator-only scorer
candidates/                 ignored local model-run artifacts
calibration/                evaluator-only calibration record
```

Never give a candidate this repository. A candidate run receives only a fresh copy of
`instruction/task.md` and `codebase/`. The scorer freezes that copy, starts its Docker project from
`source/`, and mounts `hidden_tests/` read-only into the one-off verifier container only.

Use `npm run candidates:run` to create a rootless isolated candidate artifact and
`scripts/candidates/score.sh` to score it after generation. See
[`scripts/candidates/README.md`](scripts/candidates/README.md) for the exact commands.

## ASTRA-compatible task package

The repository also exposes the task through the ASTRA brownfield package boundary:

```text
tasks/                       candidate-facing task, contracts, and codebase
verifier/                    private reference, hidden checks, mutants, and evidence
readiness_checks/            package, scoring, determinism, and proof gates
```

Run `npm run astra:package` to validate and create a deterministic authoring archive. The original
PayFlow Docker scorer and candidate launcher remain available for runtime-specific evaluation.
