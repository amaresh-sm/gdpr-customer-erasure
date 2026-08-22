#!/bin/sh
set -eu

mkdir -p /workspace/source/node_modules
cp -R /opt/payflow-node_modules/. /workspace/source/node_modules/
touch /tmp/generation-ready

while [ ! -f /tmp/generation.start ]; do
  sleep 1
done

prompt=/workspace/source/.benchmark/generation_prompt.md
if [ ! -r "$prompt" ]; then
  echo "candidate generation prompt is unavailable" >&2
  exit 64
fi

case "${BENCHMARK_PROVIDER:-codex-login}" in
  codex-login)
    exec timeout --signal=TERM --kill-after=30s "${BENCHMARK_TIMEOUT_SECONDS}s" codex exec --json --color never --ephemeral --ignore-user-config --ignore-rules \
      --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      -m "$BENCHMARK_MODEL" -c "model_reasoning_effort=\"$BENCHMARK_REASONING_EFFORT\"" \
      -c 'approval_policy="never"' - < "$prompt"
    ;;
  portkey)
    exec timeout --signal=TERM --kill-after=30s "${BENCHMARK_TIMEOUT_SECONDS}s" codex exec --json --color never --ephemeral --ignore-user-config --ignore-rules \
      --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      -m "$BENCHMARK_MODEL" -c "model_reasoning_effort=\"$BENCHMARK_REASONING_EFFORT\"" \
      -c 'approval_policy="never"' -c 'model_provider="payflow_proxy"' \
      -c 'model_providers.payflow_proxy={ name="Trusted PayFlow provider", base_url="http://provider-proxy:8081/v1", wire_api="responses", requires_openai_auth=false, supports_websockets=false, supports_standalone_web_search=false }' \
      - < "$prompt"
    ;;
  *)
    echo "unsupported benchmark provider" >&2
    exit 64
    ;;
esac
