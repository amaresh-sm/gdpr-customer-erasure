#!/bin/sh
set -eu

if [ ! -d /input/candidate ]; then
  echo "missing /input/candidate" >&2
  exit 2
fi
if [ ! -d /input/verifier ]; then
  echo "missing /input/verifier" >&2
  exit 2
fi
if [ -z "${VERIFIER_COMMAND:-}" ]; then
  echo "VERIFIER_COMMAND is required" >&2
  exit 2
fi

rm -rf /work/candidate
mkdir -p /work/candidate
cp -a /input/candidate/. /work/candidate/

cd /work/candidate
set +e
sh -lc "$VERIFIER_COMMAND"
verifier_status=$?
set -e

if [ -d /work/candidate/reports ]; then
  rm -rf /output/reports
  cp -a /work/candidate/reports /output/reports
fi

exit "$verifier_status"
