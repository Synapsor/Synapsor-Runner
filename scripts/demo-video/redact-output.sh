#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

[[ $# -eq 2 ]] || demo_fail "Usage: redact-output.sh <input> <output>"
demo_redact_file "$1" "$2"
