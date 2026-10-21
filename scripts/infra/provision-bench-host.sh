#!/usr/bin/env bash
# Provision the Guanxi benchmark host on the Fedora PC (owner decision D-194).
# Idempotent; run as root (for example through sudo from the operator account).
# Creates a dedicated, password-locked user for rootless Podman with a CPU/memory-capped
# user slice. Touches no workstation service, no GPU device group and no network config.
set -euo pipefail

BENCH_USER=guanxi-bench
OPERATOR="${GUANXI_BENCH_OPERATOR:-${SUDO_USER:?run through sudo or set GUANXI_BENCH_OPERATOR}}"

if ! id -u "$BENCH_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --comment "Guanxi benchmark runner (rootless Podman, D-194)" "$BENCH_USER"
fi
passwd --lock "$BENCH_USER" >/dev/null
uid=$(id -u "$BENCH_USER")

# Rootless Podman needs subordinate id ranges; Fedora's useradd normally allocates them.
grep -q "^$BENCH_USER:" /etc/subuid || usermod --add-subuids 2100000-2165535 "$BENCH_USER"
grep -q "^$BENCH_USER:" /etc/subgid || usermod --add-subgids 2100000-2165535 "$BENCH_USER"

# Never in GPU/device groups: benchmark containers get no accelerator.
for group in video render wheel docker; do
  if id -nG "$BENCH_USER" | tr ' ' '\n' | grep -qx "$group"; then gpasswd --delete "$BENCH_USER" "$group" >/dev/null; fi
done

# Keep the user manager running without a login so containers live under its slice.
loginctl enable-linger "$BENCH_USER"

# Hard caps for everything the benchmark user runs: 8 of 12 threads, 14 GiB RAM, low weight
# so the owner's workstation services and the resident model win under contention.
install -d -m 0755 "/etc/systemd/system/user-$uid.slice.d"
cat > "/etc/systemd/system/user-$uid.slice.d/50-guanxi-bench-limits.conf" <<EOF
[Slice]
CPUQuota=800%
CPUWeight=20
IOWeight=20
MemoryHigh=12G
MemoryMax=14G
MemorySwapMax=2G
TasksMax=4096
EOF
systemctl daemon-reload

# The operator may act as the (less privileged) benchmark user without a password; nothing
# grants the benchmark user any privilege.
cat > /etc/sudoers.d/50-guanxi-bench <<EOF
$OPERATOR ALL=($BENCH_USER) NOPASSWD: ALL
EOF
chmod 0440 /etc/sudoers.d/50-guanxi-bench
visudo -cf /etc/sudoers.d/50-guanxi-bench >/dev/null

echo "uid=$uid"
grep "^$BENCH_USER:" /etc/subuid /etc/subgid
id -nG "$BENCH_USER"
loginctl show-user "$BENCH_USER" --property=Linger
systemctl show "user-$uid.slice" --property=CPUQuotaPerSecUSec,MemoryMax,MemoryHigh,TasksMax
