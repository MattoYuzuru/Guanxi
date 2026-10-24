#!/usr/bin/env bash
set -euo pipefail
# Ephemeral hosted runner only. Never source this on the owner's workstation.
test "${GITHUB_ACTIONS:-}" = true
test "$(uname -s)" = Linux
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends bubblewrap socat ripgrep libcap-ng-dev libseccomp-dev
# Noble's setpriv lacks --seccomp-filter; the real runtime preflight still validates its kernel.
# Build that one pinned standalone tool rather than weaken the sandbox or edit dependencies.
tool_cache="$PWD/.ci-tools"
mkdir -p "$tool_cache"
if ! test -x "$tool_cache/setpriv"; then
  tool_dir=$(mktemp -d)
  trap 'rm -rf "$tool_dir"' EXIT
  curl --fail --silent --show-error --location https://www.kernel.org/pub/linux/utils/util-linux/v2.41/util-linux-2.41.3.tar.xz -o "$tool_dir/source.tar.xz"
  printf '%s  %s\n' 3330d873f0fceb5560b89a7dc14e4f3288bbd880e96903ed9b50ec2b5799e58b "$tool_dir/source.tar.xz" | sha256sum --check
  tar -xf "$tool_dir/source.tar.xz" -C "$tool_dir"
  (
    cd "$tool_dir/util-linux-2.41.3"
    ./configure --disable-all-programs --enable-setpriv --disable-shared --disable-nls --without-python --without-systemd
    make -j2 setpriv
    install -m 755 setpriv "$tool_cache/setpriv"
  )
fi
sudo install -m 755 "$tool_cache/setpriv" /usr/bin/setpriv
# Ubuntu's AppArmor userns restriction otherwise refuses the sandbox before the test starts.
if test -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns; then
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
fi
sudo ln -sf "$(command -v node)" /usr/local/bin/node
setpriv --help | grep -q -- --seccomp-filter
uname -r
bwrap --ro-bind / / --unshare-user --unshare-pid --proc /proc -- /usr/local/bin/node --version
