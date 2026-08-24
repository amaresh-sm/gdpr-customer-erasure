#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <candidate-run-directory>" >&2
  exit 64
fi

run_dir=$(cd "$1" && pwd)
root_dir=$(cd "$(dirname "$0")/../.." && pwd)
source_dir="$run_dir/source"
report_dir="$run_dir/reports"
run_id=$(basename "$run_dir")
project="candidate-${run_id//[^a-z0-9]/-}"
override_file="$root_dir/scripts/candidates/scoring.compose.yml"
export PAYFLOW_EVALUATOR_DIR="$root_dir/evaluator/provider-simulator"

if [[ ! -f "$source_dir/docker-compose.yml" ]]; then
  echo "candidate artifact is incomplete: expected source/docker-compose.yml" >&2
  exit 64
fi
if [[ ! -f "$run_dir/metadata.json" && -f "$run_dir/trusted/launch.json" ]]; then
  npx --prefix "$root_dir/codebase" tsx "$root_dir/scripts/candidates/finalize-container.ts" -- --run-dir "$run_dir"
fi
if [[ ! -f "$run_dir/metadata.json" ]]; then
  echo "candidate generation has not completed and cannot be scored" >&2
  exit 64
fi
if [[ ! -d "$root_dir/hidden_tests" ]]; then
  echo "private hidden_tests directory is unavailable to the scorer" >&2
  exit 65
fi

mkdir -p "$report_dir"
cleanup() {
  docker compose -p "$project" -f "$source_dir/docker-compose.yml" -f "$override_file" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Candidate services are built from source/ only. Hidden tests are mounted only into the one-off
# verifier container after the candidate source has already been frozen by candidates:run.
docker compose -p "$project" -f "$source_dir/docker-compose.yml" -f "$override_file" up --build -d

# Compose's "started" state is not application readiness. Probe over the private Compose network:
# the evaluator deliberately publishes no host ports, so concurrent scores cannot collide.
wait_for_health() {
  local service=$1
  local port=$2
  local label=$3
  local attempt
  for attempt in $(seq 1 60); do
    # Readiness must establish that the HTTP server is accepting connections; it must not turn a
    # candidate's missing /health route into a harness-wide failure that prevents independent
    # privacy checks from running. Any non-5xx HTTP response proves the process is reachable.
    if docker compose -p "$project" -f "$source_dir/docker-compose.yml" -f "$override_file" run --rm --no-deps \
      verifier node -e "fetch('http://${service}:${port}/health').then((response) => process.exit(response.status < 500 ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "candidate stack did not become ready: $label" >&2
  return 1
}
wait_for_health 'customer-service' '3001' 'customer-service'
wait_for_health 'api-gateway' '3000' 'api-gateway'
set +e
docker compose -p "$project" -f "$source_dir/docker-compose.yml" -f "$override_file" run --rm --no-deps \
  -v "$root_dir/hidden_tests:/srv/payflow/hidden_tests:ro" \
  -v "$report_dir:/reports" \
  -e JUNIT_PATH=/reports/hidden.junit.xml \
  -e ERASURE_SCORE_PATH=/reports/hidden.score.json \
  -e ERASURE_TEST_SLOT="$run_id" \
  verifier node --import tsx hidden_tests/run.ts 2>&1 | tee "$report_dir/hidden-scorer.log"
score_status=${PIPESTATUS[0]}
set -e

npx --prefix "$root_dir/codebase" tsx "$root_dir/scripts/candidates/record-score.ts" \
  --run-dir "$run_dir" \
  --junit "$report_dir/hidden.junit.xml" \
  --score "$report_dir/hidden.score.json" \
  --verifier-ref "$(git -C "$root_dir" rev-parse HEAD)"

exit "$score_status"
