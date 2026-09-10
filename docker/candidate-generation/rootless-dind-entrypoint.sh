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

if [ "${PAYFLOW_GENERATION_PROVIDER:-codex-login}" = "openhands" ]; then
  if [ ! -r /tmp/openhands.env ]; then
    echo "OpenHands environment file is unavailable" >&2
    exit 64
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      LLM_API_KEY|LLM_BASE_URL|ASTRA_GATEWAY_API_KEY|ASTRA_GATEWAY_BASE_URL)
        export "$key=$value"
        ;;
    esac
  done < /tmp/openhands.env
fi

set +e
case "${PAYFLOW_GENERATION_PROVIDER:-codex-login}" in
  codex-login)
    timeout --signal=TERM --kill-after=30s "${PAYFLOW_GENERATION_TIMEOUT_SECONDS}s" codex exec --json --color never --ephemeral --ignore-user-config --ignore-rules \
      --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      -m "$PAYFLOW_GENERATION_MODEL" -c "model_reasoning_effort=\"$PAYFLOW_GENERATION_REASONING_EFFORT\"" \
      -c 'approval_policy="never"' -C /workspace/source - < "$prompt_copy"
    result=$?
    ;;
  portkey)
    timeout --signal=TERM --kill-after=30s "${PAYFLOW_GENERATION_TIMEOUT_SECONDS}s" codex exec --json --color never --ephemeral --ignore-user-config --ignore-rules \
      --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      -m "$PAYFLOW_GENERATION_MODEL" -c "model_reasoning_effort=\"$PAYFLOW_GENERATION_REASONING_EFFORT\"" \
      -c 'approval_policy="never"' -c 'model_provider="payflow_proxy"' \
      -c 'model_providers.payflow_proxy={ name="Trusted PayFlow provider", base_url="http://provider-proxy:8081/v1", wire_api="responses", requires_openai_auth=false, supports_websockets=false, supports_standalone_web_search=false }' \
      -C /workspace/source - < "$prompt_copy"
    result=$?
    ;;
  portkey-opencode)
    mkdir -p /tmp/opencode/config/opencode /tmp/opencode/cache /tmp/opencode/data /tmp/npm-cache
    cat > /tmp/opencode/config/opencode/opencode.json <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "portkey": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Portkey",
      "options": {
        "baseURL": "http://provider-proxy:8081/v1",
        "headers": { "Authorization": "Bearer payflow-trusted-relay" }
      },
      "models": {
        "${PAYFLOW_GENERATION_MODEL}": {
          "name": "${PAYFLOW_GENERATION_MODEL} via Portkey",
          "options": { "reasoningEffort": "${PAYFLOW_GENERATION_REASONING_EFFORT}" }
        }
      }
    }
  },
  "model": "portkey/${PAYFLOW_GENERATION_MODEL}",
  "agent": {
    "build": { "model": "portkey/${PAYFLOW_GENERATION_MODEL}", "reasoningEffort": "${PAYFLOW_GENERATION_REASONING_EFFORT}" }
  },
  "permission": {
    "bash": "allow", "edit": "allow", "write": "allow", "read": "allow",
    "external_directory": "allow", "webfetch": "allow"
  }
}
EOF
    timeout --signal=TERM --kill-after=30s "${PAYFLOW_GENERATION_TIMEOUT_SECONDS}s" env \
      XDG_CONFIG_HOME=/tmp/opencode/config XDG_CACHE_HOME=/tmp/opencode/cache XDG_DATA_HOME=/tmp/opencode/data XDG_STATE_HOME=/tmp/opencode/state npm_config_cache=/tmp/npm-cache \
      opencode run --auto --dir /workspace/source "$(cat "$prompt_copy")"
    result=$?
    ;;
  openhands)
    timeout --signal=TERM --kill-after=30s "${PAYFLOW_GENERATION_TIMEOUT_SECONDS}s" \
      hackerrank-openhands run \
      --workspace /workspace/source --instruction-file "$prompt_copy" \
      --model "$PAYFLOW_GENERATION_MODEL" --reasoning "$PAYFLOW_GENERATION_REASONING_EFFORT" \
      --output /tmp/hackerrank-openhands-run
    result=$?
    if [ -f /tmp/hackerrank-openhands-run/events.jsonl ]; then
      cat /tmp/hackerrank-openhands-run/events.jsonl
    fi
    if [ -d /tmp/hackerrank-openhands-run ]; then
      mkdir -p /workspace/source/.hackerrank-openhands-run
      for artifact in telemetry.json trajectory.json events.sanitized.json; do
        if [ -f "/tmp/hackerrank-openhands-run/$artifact" ]; then
          cp "/tmp/hackerrank-openhands-run/$artifact" "/workspace/source/.hackerrank-openhands-run/$artifact"
        fi
      done
    fi
    ;;
  *)
    echo "unsupported generation provider" >&2
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
