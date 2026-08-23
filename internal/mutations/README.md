# Private mutation certification

This directory is evaluator-only and is ignored by Git. It contains deliberately
incorrect, minimal patches against `reference_solution/source`. These patches
are never copied into a candidate workspace, image, package, or calibration
artifact.

`mutations.tsv` is the contract matrix. Each row names one source-level defect
and the exact structured hidden-score check it is expected to fail.

Run one mutation:

```bash
bash internal/mutations/run.sh financial-invoice-lines-unsanitized
```

Run the clean reference control and the full matrix:

```bash
bash internal/mutations/run.sh reference
bash internal/mutations/run.sh all
```

The runner copies the frozen reference source to a temporary directory, applies
exactly one patch, starts an isolated Docker Compose project with no host ports,
and mounts `hidden_tests/` read-only only for the final verifier container. It
writes logs, reports, source and patch digests, and the assertion result under
`internal/mutation-runs/`, which is also ignored by Git. Containers and volumes
are removed on exit.

An execution is accepted only when the stack becomes healthy, the fixture is
comparable, and the expected structured check fails. A startup failure, missing
fixture, or a different failing check is reported as an invalid mutation rather
than counted as evidence.

The `canonical-workflow-duplicate` variant is intentionally marked
`repeat-required`: it must fail consistently in repeated runs before it can be
used as evidence for the concurrent/idempotent contract.
