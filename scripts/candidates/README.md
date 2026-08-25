# Candidate calibration launcher

Use the provider-specific generation commands below for every new model attempt. They create a
timestamped, ignored local artifact, wait for generation to end, and finalize its trusted telemetry.
The model receives only the copied `codebase/` plus the public task prompt; it cannot mount
`hidden_tests/`, `reference_solution/`, calibration records, or other candidates. The lower-level
launcher commands remain available only for troubleshooting a detached generation container.

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

## Generate with Codex login

This is the normal Codex/ChatGPT-login path. It waits for generation to finish, finalizes the
trusted telemetry, removes the generation environment, and prints the resulting run directory.

```bash
npm run candidates:generate:codex -- \
  --model gpt-5.6-sol \
  --thinking xhigh
```

## Generate through Portkey

The Portkey environment file is private and must contain `PORTKEY_API_KEY` plus exactly one of
`PORTKEY_CONFIG` or `PORTKEY_PROVIDER`.

```bash
npm run candidates:generate:portkey -- \
  --model kimi-k3 \
  --thinking high \
  --portkey-env-file /absolute/path/to/private-portkey.env
```

Both commands accept `--timeout-seconds` (default `14400`), `--run-id`, `--baseline-ref`, and
`--prompt-file`. Use the lower-level `candidates:run`, `candidates:status`, and
`candidates:finalize` commands only for launcher troubleshooting.

## Score a completed candidate

This is the only scoring command. It starts a fresh isolated stack, mounts hidden tests only into
the verifier, writes JUnit and score reports into the candidate artifact, and cleans the stack up.

```bash
npm run candidates:score -- candidates/gpt-5.6-sol-xhigh-<timestamp>
```

Render the comparable headline table from the recorded evidence:

```bash
npx --prefix codebase tsx scripts/candidates/summary.ts -- --run-dir candidates/gpt-5.6-sol-high-<timestamp>
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
