#!/usr/bin/env bash
set -euo pipefail

ERASURE_SCORING_VERSION=v2 exec "$(dirname "$0")/score.sh" "$@"
