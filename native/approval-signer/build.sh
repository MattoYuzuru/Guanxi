#!/bin/sh
# Build the Guanxi approval signing helper. Production output is
# .build/approval-signer; `--test` builds .build/approval-signer-test with the test key,
# fake authenticator and file-backed test keychain, and must never be installed.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BUILD="$DIR/.build"
MC="$BUILD/mc"
SWIFTC=${SWIFTC:-swiftc}
CODESIGN=${CODESIGN:-codesign}
IDENTIFIER=${SIGNER_IDENTIFIER:-local.approval-signer}

mkdir -p "$MC"

# Production builds must not carry the test hooks. The check is also exposed as
# `build.sh --check <binary>` so the tests can prove that it catches a leaked hook.
check_no_test_hooks() {
  binary=$1
  if strings "$binary" | grep -q 'SIGNER_TEST_'; then
    echo "error: $binary contains test hooks (SIGNER_TEST_)" >&2
    return 1
  fi
}

if [ "${1:-}" = "--check" ]; then
  if [ -z "${2:-}" ]; then
    echo "usage: build.sh --check <binary>" >&2
    exit 2
  fi
  check_no_test_hooks "$2"
  exit 0
fi

if [ "${1:-}" = "--test" ]; then
  OUT="$BUILD/approval-signer-test"
  FLAGS="-D GUANXI_SIGNER_TESTING"
  CHECK=0
elif [ -z "${1:-}" ]; then
  OUT="$BUILD/approval-signer"
  FLAGS=""
  CHECK=1
else
  echo "usage: build.sh [--test | --check <binary>]" >&2
  exit 2
fi

# Build and sign a private temporary path, then rename atomically: two test files may ask for
# the same test binary at the same time.
TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT HUP INT TERM
# shellcheck disable=SC2086 # FLAGS is empty or one exact -D flag.
"$SWIFTC" -O -module-cache-path "$MC" $FLAGS "$DIR/Sources/main.swift" -o "$TMP"
"$CODESIGN" -s - -f --identifier "$IDENTIFIER" "$TMP"

if [ "$CHECK" = "1" ]; then
  if ! check_no_test_hooks "$TMP"; then
    exit 1
  fi
fi

mv -f "$TMP" "$OUT"
trap - EXIT HUP INT TERM
