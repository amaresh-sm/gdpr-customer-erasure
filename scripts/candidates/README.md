# Candidate calibration launcher

Use the launcher for every new model attempt. It creates a timestamped, ignored local artifact and
starts a durable Docker model container. The model receives only the copied `codebase/` plus the
public task prompt; it cannot mount `hidden_tests/`, `reference_solution/`, calibration records, or
other candidates. The container continues after the calling terminal returns.

The model container owns a private rootless Docker daemon, so the public `docker compose` commands
work without mounting the host Docker socket. Candidate source is mounted read-only, copied to a
private named-volume workspace, and exported by the trusted finalizer after generation completes.
The completed container remains in an idle handoff state until that export succeeds. The
fixed PayFlow runtime images are streamed into the private daemon by the launcher. The egress
gateway permits public HTTPS destinations so candidates can download dependencies and
documentation, while rejecting loopback, private-network, link-local, and internal destinations.
Portkey model traffic still uses its dedicated provider gateway. The outer container uses Docker's privileged mode only to support rootless
Docker-in-Docker inside the Docker Desktop/Rancher Desktop VM; no host socket or evaluator file is
available inside it.

```bash
npm run candidates:run -- \
  --model gpt-5.6-sol \
  --thinking ultra \
  --provider codex-login \
  --prompt-file instruction/task.md \
  --timeout-seconds 5400
```

Check a run without accessing its source from the model container:

```bash
npm run candidates:status -- --run-dir candidates/gpt-5.6-sol-ultra-<timestamp>
```

After the model container exits, finalize trusted telemetry and remove all generation containers:

```bash
npm run candidates:finalize -- --run-dir candidates/gpt-5.6-sol-ultra-<timestamp>
```

`score.sh` performs that finalization automatically when appropriate. It then runs a separate
Docker project and attaches the JUnit report without copying the hidden suite into the artifact:

```bash
scripts/candidates/score.sh candidates/gpt-5.6-sol-high-<timestamp>
```

Render the comparable headline table from the recorded evidence:

```bash
npx --prefix codebase tsx scripts/candidates/summary.ts -- --run-dir candidates/gpt-5.6-sol-high-<timestamp>
```

For Portkey, use `--provider portkey` with a private environment file containing
`PORTKEY_API_KEY` and exactly one of `PORTKEY_CONFIG` or `PORTKEY_PROVIDER`:

```bash
npm run candidates:run -- \
  --model @provider/model \
  --thinking ultra \
  --provider portkey \
  --portkey-env-file /absolute/path/to/private-portkey.env
```

The Portkey key is streamed only into a trusted proxy container's tmpfs and is not a model-container
environment variable, bind mount, candidate file, or persisted report. The report records only a
SHA-256 route identity. Raw Codex JSONL is retained only temporarily, then sanitized into
`metadata.json` and `logs/events.sanitized.json`. Cgroup CPU/memory sampling and credential leak
scanning are currently explicitly marked `not_available`; the launcher does not fabricate them.

For compatibility with existing private benchmark configuration, a supplied private environment
file may use `OPENAI_API_KEY` and `OPENAI_BASE_URL` as the Portkey key and base URL. This fallback
is accepted only from `--portkey-env-file`, never copied into the candidate source, and never
recorded in metadata.
