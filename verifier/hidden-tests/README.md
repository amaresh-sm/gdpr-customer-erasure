# PayFlow private behavioral checks

The TypeScript verifier provisions isolated PayFlow fixtures, runs the public API and cross-store
checks, and writes JUnit plus normalized score reports. It is invoked by the repository's Docker
scoring workflow.

The scorer always emits one normalized score from 0 to 1. Passing checks earn their configured
weight; failed or blocked checks earn zero. A blocked check remains explicitly recorded in the
diagnostics so fixture problems are auditable, but it does not create a second score or an alternate
`partial`/`non-comparable` result.
