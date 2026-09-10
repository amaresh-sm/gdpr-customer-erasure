#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <candidate-run-directory>" >&2
  exit 64
fi

run_dir=$(cd "$1" && pwd)
root_dir=$(cd "$(dirname "$0")/../.." && pwd)
report_dir="$run_dir/reports"
attempt_count=3
run_stamp=$(date -u +%Y%m%dT%H%M%SZ)
stable_dir="$report_dir/stability/$run_stamp"
summary_lines="$stable_dir/attempts.jsonl"

if [[ ! -f "$run_dir/metadata.json" ]]; then
  echo "candidate generation has not completed and cannot be scored" >&2
  exit 64
fi

mkdir -p "$stable_dir"

for attempt in $(seq 1 "$attempt_count"); do
  attempt_dir="$stable_dir/attempt-$attempt"
  mkdir -p "$attempt_dir"
  set +e
  bash "$(dirname "$0")/score.sh" "$run_dir"
  exit_code=$?
  set -e

  cp "$report_dir/hidden.score.json" "$attempt_dir/hidden.score.json"
  cp "$report_dir/hidden.junit.xml" "$attempt_dir/hidden.junit.xml"
  cp "$report_dir/hidden-scorer.log" "$attempt_dir/hidden-scorer.log"
  jq --argjson attempt "$attempt" --argjson exit_code "$exit_code" \
    '{ attempt: $attempt, exit_code: $exit_code, state, earned, maximum, evaluated_maximum, unverified_maximum }' \
    "$attempt_dir/hidden.score.json" >>"$summary_lines"
done

selected_attempt=$(jq -s 'to_entries | min_by(.value.earned // 0) | (.key + 1)' "$summary_lines")
selected_dir="$stable_dir/attempt-$selected_attempt"

cp "$selected_dir/hidden.score.json" "$report_dir/hidden.score.json"
cp "$selected_dir/hidden.junit.xml" "$report_dir/hidden.junit.xml"
cp "$selected_dir/hidden-scorer.log" "$report_dir/hidden-scorer.log"

jq -s --argjson selected_attempt "$selected_attempt" '{
  schema_version: 1,
  policy: "three fresh isolated runs; final score is the lowest earned score, with blocked scored as zero",
  selected_attempt: $selected_attempt,
  attempts: .
}' "$summary_lines" >"$stable_dir/summary.json"

npx --prefix "$root_dir/codebase" tsx "$root_dir/scripts/candidates/record-score.ts" \
  --run-dir "$run_dir" \
  --junit "$report_dir/hidden.junit.xml" \
  --score "$report_dir/hidden.score.json" \
  --verifier-ref "$(git -C "$root_dir" rev-parse HEAD)"

selected_score=$(jq -r '.earned // 0' "$report_dir/hidden.score.json")
printf 'selected stable score: %s / 1.0000 (attempt %s of %s)\n' "$selected_score" "$selected_attempt" "$attempt_count"
