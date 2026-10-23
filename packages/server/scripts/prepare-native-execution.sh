#!/bin/sh
set -eu
# The caller selects a local Docker context (Colima or Docker Desktop).
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
exec docker build --label org.guanxi.execution-profile=k4-v3 \
  --tag guanxi-native-execution:k4-v3 "$project_root/packages/server/src/native-agent/container"
