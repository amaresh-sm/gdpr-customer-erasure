# PayFlow private behavioral checks

The TypeScript verifier provisions isolated PayFlow fixtures, runs the public API and cross-store
checks, and writes JUnit plus normalized score reports. It is invoked by the repository's Docker
scoring workflow.

The scorer evaluates every check that has a trustworthy observation. A check that depends on an
unavailable fixture is recorded as `blocked` and excluded from the evaluated maximum; the report
is marked `partial` and `comparable: false`. No blocked check is silently counted as a pass.
