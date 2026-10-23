#!/bin/sh
set -eu
# The caller selects a local Docker context (Colima or Docker Desktop).
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
context="$project_root/packages/server/src/native-agent/container"
# Image identity: sha256 of guard.c followed by the Dockerfile; the node refuses an image with another label.
if command -v sha256sum >/dev/null 2>&1; then
  guard_digest=$(cat "$context/guard.c" "$context/Dockerfile" | sha256sum | cut -d' ' -f1)
else
  guard_digest=$(cat "$context/guard.c" "$context/Dockerfile" | shasum -a 256 | cut -d' ' -f1)
fi
exec docker build --label org.guanxi.execution-profile=k4-v3 \
  --label "org.guanxi.execution-guard-sha256=$guard_digest" \
  --tag guanxi-native-execution:k4-v3 "$context"
