#!/bin/sh
set -eu

mkdir -p "$XDG_RUNTIME_DIR" /workspace/source
if [ -d /input ]; then
  cp -R /input/. /workspace/source/
fi
dockerd-entrypoint.sh --log-level error > /tmp/rootless-dockerd.log 2>&1 &
daemon_pid=$!
shutdown_runtime() {
  if [ -f /workspace/source/docker-compose.yml ]; then
    (cd /workspace/source && docker compose down --volumes --remove-orphans) >/dev/null 2>&1 || true
  fi
  kill "$daemon_pid" >/dev/null 2>&1 || true
}
trap shutdown_runtime EXIT INT TERM

for attempt in $(seq 1 120); do
  docker info >/dev/null 2>&1 && break
  sleep 1
done
docker info >/dev/null
touch /tmp/rootless-docker-ready
while [ ! -f /tmp/generation.start ]; do sleep 1; done

prompt=/workspace/source/.payflow-task.md
if [ ! -r "$prompt" ]; then
  echo "candidate generation prompt is unavailable" >&2
  exit 64
fi
prompt_copy=/tmp/payflow-task.md
cp "$prompt" "$prompt_copy"
rm -f "$prompt"

if [ ! -r /tmp/openhands.env ]; then
  echo "OpenHands environment file is unavailable" >&2
  exit 64
fi

set +e
openhands_output=/tmp/hackerrank-openhands-run
openhands_stdout=/tmp/hackerrank-openhands.stdout.log
openhands_stderr=/tmp/hackerrank-openhands.stderr.log
rm -rf "$openhands_output"
rm -f "$openhands_stdout" "$openhands_stderr"
mkdir -p "$openhands_output"
timeout --signal=TERM --kill-after=30s "${PAYFLOW_GENERATION_TIMEOUT_SECONDS}s" \
  hackerrank-openhands run \
  --workspace /workspace/source --instruction-file "$prompt_copy" \
  --model "$PAYFLOW_GENERATION_MODEL" --reasoning "$PAYFLOW_GENERATION_REASONING_EFFORT" \
  --output "$openhands_output" \
  --env-file /tmp/openhands.env \
  --redact >"$openhands_stdout" 2>"$openhands_stderr"
result=$?
# Keep the original command output visible in the Docker log while also
# preserving stdout/stderr as separate failure-debugging artifacts.
cat "$openhands_stdout"
cat "$openhands_stderr" >&2
if [ -d "$openhands_output" ]; then
  mkdir -p /workspace/source/.hackerrank-openhands-run
  for artifact in events.jsonl telemetry.json trajectory.json gateway_responses.jsonl; do
    if [ -f "$openhands_output/$artifact" ]; then
      cp "$openhands_output/$artifact" "/workspace/source/.hackerrank-openhands-run/$artifact"
    fi
  done
  # gateway_responses_failures/ holds the exact, uncapped message array for every
  # failed gateway call (written by harness.py's _dump_failed_request). It lives
  # in the container's ephemeral /tmp, so without this it is lost the moment the
  # container is torn down, leaving a failure with no way to inspect what was sent.
  if [ -d "$openhands_output/gateway_responses_failures" ]; then
    cp -R "$openhands_output/gateway_responses_failures" /workspace/source/.hackerrank-openhands-run/gateway_responses_failures
  fi
  cp "$openhands_stdout" /workspace/source/.hackerrank-openhands-run/openhands.stdout.log
  cp "$openhands_stderr" /workspace/source/.hackerrank-openhands-run/openhands.stderr.log
fi
set -e
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n%s\n' "$result" "$completed_at" > /workspace/generation-result
shutdown_runtime
touch /tmp/generation-finished

# Keep the private workspace mounted until the trusted finalizer exports it. The inner PayFlow
# stack and daemon are already stopped, so this idle handoff consumes very little memory.
while :; do sleep 3600; done
