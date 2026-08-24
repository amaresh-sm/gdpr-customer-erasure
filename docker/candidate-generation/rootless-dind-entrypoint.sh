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

prompt=/workspace/source/.benchmark/generation_prompt.md
if [ ! -r "$prompt" ]; then
  echo "candidate generation prompt is unavailable" >&2
  exit 64
fi

set +e
case "${BENCHMARK_PROVIDER:-codex-login}" in
  codex-login)
    timeout --signal=TERM --kill-after=30s "${BENCHMARK_TIMEOUT_SECONDS}s" codex exec --json --color never --ephemeral --ignore-user-config --ignore-rules \
      --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      -m "$BENCHMARK_MODEL" -c "model_reasoning_effort=\"$BENCHMARK_REASONING_EFFORT\"" \
      -c 'approval_policy="never"' -C /workspace/source - < "$prompt"
    result=$?
    ;;
  portkey)
    timeout --signal=TERM --kill-after=30s "${BENCHMARK_TIMEOUT_SECONDS}s" codex exec --json --color never --ephemeral --ignore-user-config --ignore-rules \
      --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      -m "$BENCHMARK_MODEL" -c "model_reasoning_effort=\"$BENCHMARK_REASONING_EFFORT\"" \
      -c 'approval_policy="never"' -c 'model_provider="payflow_proxy"' \
      -c 'model_providers.payflow_proxy={ name="Trusted PayFlow provider", base_url="http://provider-proxy:8081/v1", wire_api="responses", requires_openai_auth=false, supports_websockets=false, supports_standalone_web_search=false }' \
      -C /workspace/source - < "$prompt"
    result=$?
    ;;
  *)
    echo "unsupported benchmark provider" >&2
    result=64
    ;;
esac
set -e
completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n%s\n' "$result" "$completed_at" > /workspace/generation-result
shutdown_runtime
touch /tmp/generation-finished

# Keep the private workspace mounted until the trusted finalizer exports it. The inner PayFlow
# stack and daemon are already stopped, so this idle handoff consumes very little memory.
while :; do sleep 3600; done
