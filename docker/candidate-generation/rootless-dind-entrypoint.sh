#!/bin/sh
set -eu

mkdir -p "$XDG_RUNTIME_DIR" /workspace/source
mkdir -p "$HOME/.docker"
cat > "$HOME/.docker/config.json" <<EOF
{
  "proxies": {
    "default": {
      "httpProxy": "${HTTP_PROXY:-}",
      "httpsProxy": "${HTTPS_PROXY:-}",
      "noProxy": "${NO_PROXY:-localhost,127.0.0.1}"
    }
  }
}
EOF
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
rm -rf "$openhands_output"
mkdir -p "$openhands_output"
timeout --signal=TERM --kill-after=30s "${PAYFLOW_GENERATION_TIMEOUT_SECONDS}s" \
  hackerrank-openhands run \
  --workspace /workspace/source --instruction-file "$prompt_copy" \
  --model "$PAYFLOW_GENERATION_MODEL" --reasoning "$PAYFLOW_GENERATION_REASONING_EFFORT" \
  --output "$openhands_output" \
  --env-file /tmp/openhands.env \
  --redact
result=$?
if [ -f "$openhands_output/events.jsonl" ]; then
  cat "$openhands_output/events.jsonl"
fi
if [ -d "$openhands_output" ]; then
  mkdir -p /workspace/source/.hackerrank-openhands-run
  for artifact in telemetry.json trajectory.json gateway_responses.jsonl; do
    if [ -f "$openhands_output/$artifact" ]; then
      cp "$openhands_output/$artifact" "/workspace/source/.hackerrank-openhands-run/$artifact"
    fi
  done
fi
set -e
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n%s\n' "$result" "$completed_at" > /workspace/generation-result
shutdown_runtime
touch /tmp/generation-finished

# Keep the private workspace mounted until the trusted finalizer exports it. The inner PayFlow
# stack and daemon are already stopped, so this idle handoff consumes very little memory.
while :; do sleep 3600; done
