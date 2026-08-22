# Candidate calibration launcher

Use the launcher for every new model attempt. It creates a timestamped, ignored local artifact,
exports only the candidate branch, invokes `codex exec --json`, keeps raw JSONL only in temporary
storage, and writes sanitized telemetry into `metadata.json` and `logs/events.sanitized.json`.

```bash
npm run candidates:run -- \
  --model gpt-5.6-sol \
  --thinking high \
  --prompt-file /absolute/path/to/public-candidate-prompt.txt \
  --timeout-seconds 900
```

After the candidate source is frozen, score it in a separate Docker project and attach the JUnit
report without copying the hidden suite into the artifact:

```bash
npm run candidates:record-score -- \
  --run-dir candidates/gpt-5.6-sol-high-<timestamp> \
  --junit /absolute/path/to/junit.xml \
  --verifier-ref solution/gdpr-customer-erasure
```

Render the comparable headline table from the recorded evidence:

```bash
npm run candidates:summary -- --run-dir candidates/gpt-5.6-sol-high-<timestamp>
```

The local CLI launcher can measure timestamps, exit state, Codex JSONL tokens/tool trajectory, and
candidate/source hashes. Container-only facts (cgroup CPU and memory, mount/network attestation,
generation/gateway image IDs, and tmpfs credential handling) are deliberately marked
`not_available` until a containerized generation launcher supplies them. This prevents fabricated
benchmark evidence.
