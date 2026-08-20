# Mutation gate

These private mutations model plausible incomplete candidate solutions. Each is applied to a clean
reference archive, compiled, deployed against the same infrastructure, and executed through
`hidden_tests/run.ts`. A mutation survives only if every verifier scenario passes; the benchmark is
not accepted while any listed mutation survives.
