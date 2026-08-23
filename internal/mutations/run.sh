#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "$0")/../.." && pwd)
mutation_dir="$root_dir/internal/mutations"
manifest="$mutation_dir/mutations.tsv"
selection=${1:-all}
run_stamp=$(date -u +%Y%m%dT%H%M%SZ)
run_stamp_lower=${run_stamp/T/t}
run_stamp_lower=${run_stamp_lower/Z/z}
run_root="$root_dir/internal/mutation-runs/$run_stamp"
override_file="$root_dir/internal/compose-no-host-ports.yml"
reference_source="$root_dir/reference_solution/source"

if [[ ! -d "$reference_source" || ! -d "$root_dir/hidden_tests" ]]; then
  echo 'reference source or hidden tests are unavailable' >&2
  exit 64
fi

mkdir -p "$run_root"

lookup_mutation() {
  local id=$1
  awk -F '\t' -v wanted="$id" '$1 == wanted { print; found=1 } END { if (!found) exit 1 }' "$manifest"
}

run_one() (
  set -euo pipefail
  local id=$1
  local row patch_rel expected_check repeat_required contract
  local work_dir report_dir source_dir project health_attempt verifier_status
  local -a compose

  if [[ "$id" == 'reference' ]]; then
    patch_rel=''
    expected_check='-'
    repeat_required='false'
    contract='clean reference control'
  else
    row=$(lookup_mutation "$id") || { echo "unknown mutation: $id" >&2; return 64; }
    IFS=$'\t' read -r _id patch_rel expected_check repeat_required contract <<< "$row"
  fi

  work_dir=$(mktemp -d "${TMPDIR:-/tmp}/payflow-mutation.${id}.XXXXXX")
  source_dir="$work_dir/source"
  report_dir="$run_root/$id"
  project="mutation-${id//[^a-z0-9]/-}-${run_stamp_lower}"
  compose=(docker compose -p "$project" -f "$source_dir/docker-compose.yml" -f "$override_file")
  mkdir -p "$report_dir"

  cleanup() {
    "${compose[@]}" down -v --remove-orphans >>"$report_dir/cleanup.log" 2>&1 || true
    rm -rf "$work_dir"
  }
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  cp -R "$reference_source" "$source_dir"
  if [[ -n "$patch_rel" ]]; then
    cp "$mutation_dir/$patch_rel" "$report_dir/patch.diff"
    git -C "$source_dir" apply "$mutation_dir/$patch_rel" || {
      echo 'mutation patch did not apply to the frozen reference source' >"$report_dir/assertion.txt"
      exit 1
    }
  fi
  {
    printf 'id=%s\ncontract=%s\nexpected_check=%s\nrepeat_required=%s\n' "$id" "$contract" "$expected_check" "$repeat_required"
    shasum -a 256 "$reference_source/docker-compose.yml"
    if [[ -n "$patch_rel" ]]; then shasum -a 256 "$mutation_dir/$patch_rel"; fi
    git -C "$root_dir" rev-parse HEAD
  } >"$report_dir/provenance.txt"

  "${compose[@]}" up --build -d </dev/null >"$report_dir/compose-up.log" 2>&1
  for health_attempt in $(seq 1 90); do
    if "${compose[@]}" run --rm --no-deps verifier node -e "fetch('http://api-gateway:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
      </dev/null >>"$report_dir/health.log" 2>&1; then
      break
    fi
    sleep 1
  done
  if (( health_attempt == 90 )); then
    echo 'stack did not become healthy' >"$report_dir/assertion.txt"
    return 1
  fi

  set +e
  "${compose[@]}" run --rm --no-deps \
    -v "$root_dir/hidden_tests:/srv/payflow/hidden_tests:ro" \
    -v "$report_dir:/reports" \
    -e JUNIT_PATH=/reports/hidden.junit.xml \
    -e ERASURE_SCORE_PATH=/reports/hidden.score.json \
    -e ERASURE_TEST_SLOT="mutation-${id}-${run_stamp}" \
    verifier node --import tsx hidden_tests/run.ts </dev/null >"$report_dir/hidden-scorer.log" 2>&1
  verifier_status=$?
  set -e
  printf '%s\n' "$verifier_status" >"$report_dir/verifier.exit-code"

  if [[ ! -f "$report_dir/hidden.score.json" || ! -f "$report_dir/hidden.junit.xml" ]]; then
    echo 'verifier did not produce both reports' >"$report_dir/assertion.txt"
    return 1
  fi
  node "$mutation_dir/assert-result.mjs" \
    "$([[ "$id" == 'reference' ]] && echo reference || echo mutation)" \
    "$report_dir/hidden.score.json" "$expected_check" "$report_dir/assertion.json" \
    | tee "$report_dir/assertion.txt"
)

record_run() {
  local status
  set +e
  run_one "$1"
  status=$?
  set -e
  if (( status != 0 )); then matrix_status=1; fi
}

matrix_status=0
if [[ "$selection" == 'all' ]]; then
  record_run reference
  mutation_ids=()
  while IFS=$'\t' read -r id _; do
    [[ -z "$id" || "$id" == \#* ]] && continue
    mutation_ids+=("$id")
  done < "$manifest"
  for id in "${mutation_ids[@]}"; do
    record_run "$id"
  done
else
  record_run "$selection"
fi

echo "Mutation reports: $run_root"
exit "$matrix_status"
