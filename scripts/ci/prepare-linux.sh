#!/usr/bin/env bash
set -euo pipefail
# Ephemeral hosted runner only. Never source this on the owner's workstation.
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -s)" = Linux
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends bubblewrap socat ripgrep
# Ubuntu's AppArmor userns restriction otherwise refuses the sandbox before the test starts.
if test -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
sudo ln -sf "$(command -v node)" /usr/local/bin/node
setpriv --help | grep -q -- --seccomp-filter
bwrap --ro-bind / / --unshare-user --unshare-pid --proc /proc -- /usr/local/bin/node --version
