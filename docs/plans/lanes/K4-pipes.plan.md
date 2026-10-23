# K4-pipes: sandboxed workloads may spawn children with piped stdio

**Status:** plan · **Date:** 2026-10-23 · Branch `claude/k4-child-process-pipes`, base main `47e238c7`.
Security-boundary change: conservative, every claim has an assertion that fails when it is violated.
**Addendum (2026-10-23, review round 2):** the plan below is the first round. MSG_OOB denial, io_uring
denial, image identity by guard digest and the tag `k4-v3` were added afterwards; see the hand-off.

## Observed defect

In the real two-host MS1 run every acceptance gate `node --test test/01-money.test.mjs` (and the
model's own `shell` runs of it) failed inside the K4 sandbox with `spawn EPERM`; with
`--test-isolation=none` (no child process) the same gate passes 11/11. Reproduced here before any
change: in `guanxi-native-execution:k4-v1` under the guard, `spawnSync('echo', {stdio:'pipe'})`
returns `EPERM` while `stdio:'inherit'` works, and Perl `socketpair(AF_UNIX, ...)` fails with `EPERM`
for stream, dgram and seqpacket.

## Root cause

libuv creates child stdio pipes with `socketpair(AF_UNIX, SOCK_STREAM, 0)`. Two workload filters
deny it unconditionally, by the same rule written twice:

- the container guard `packages/server/src/native-agent/container/guard.c` (macOS arbitrary shell,
  image `guanxi-native-execution:k4-v1`): `BLOCK(socketpair)`;
- `linuxBindingFilter()` in `sandbox-protocol.ts` (Linux bubblewrap path, via `setpriv`): syscall
  199 on arm64, 53 on x64. The upstream sandbox-runtime filter on that path already allows
  `socketpair` and blocks only `socket(AF_UNIX)` plus io_uring.

The task text names only `execution-owner.ts`; it applies the Linux filter. The Mac container path
uses `guard.c`, so both must change. No document records a reason for denying `socketpair`; K4
evidence M1 only says the TS filter was made to match the guard. The README intent is "arbitrary
Unix-socket connections and local binding are denied".

## Decision

Allow `socketpair` only when `args[0] == AF_UNIX (1)` **and** `(args[1] & 0xf) == SOCK_STREAM (1)`.
Everything else about the filter is unchanged (`socket` AF_UNIX denied, bind, listen, ptrace,
process_vm_writev, unshare, setns, mount denied, foreign ABI killed, x32/unknown numbers denied).

Why the type check is part of the fix: measured in the image, an unfiltered `SOCK_DGRAM` pair can
`connect()` and `sendto()` a filesystem **and** abstract datagram socket, because datagram
sockets may be re-connected; a `SOCK_STREAM` pair cannot (`EISCONN`), and a stream pair cannot
reach a listener of either kind. `SOCK_SEQPACKET` is connection oriented but unneeded, so it is
not allowed (narrowest default). The full argument is in the ADR-0027 appendix.

## Changes

1. `guard.c`: add the socketpair rule (and the x32 deny that `linuxBindingFilter` already has);
   the Dockerfile build stays `-Wall -Wextra -Werror`.
2. `sandbox-protocol.ts`: regenerate the program from a small label assembler so offsets are not
   hand-counted; document the policy table in the function comment; add the `BPF_AND` op.
3. Image profile `k4-v1` -> `k4-v2` (constant, prepare script, label). A stale `k4-v1` image
   would fail closed with `spawn EPERM`; the new tag turns that into the existing explicit
   `container_runtime_unavailable` until `prepare-native-execution.sh` is run. `k4-v1` is left alone.
4. Docs: native-agent README, relay README / operations runbook (gates may use plain
   `node --test` again), ADR-0027 appendix decision record, K4 evidence note.

## Test matrix

- Unit (`seccomp.test.ts`, instruction-level, x64 and arm64, with numbers cross-checked against
  kernel headers): socketpair AF_UNIX/STREAM allowed (also with `SOCK_CLOEXEC|SOCK_NONBLOCK`);
  AF_UNIX with DGRAM, SEQPACKET, RAW; AF_INET/INET6/NETLINK/PACKET pairs denied; `socket` AF_UNIX
  denied, AF_INET/INET6 allowed; bind, listen, ptrace, process_vm_writev, unshare, setns, mount
  denied; x32 and foreign arch; structural checks (jumps in range, terminates, size).
- Real kernel, in the container (skipped with a reason when the runtime or image is missing):
  guard binary and `setpriv --seccomp-filter` with the generated program, both run in the image:
  `node -e` spawning a piped child, `node --test` on a two-file fixture without
  `--test-isolation=none`, Perl `syscall` probes for dgram/seqpacket/INET pairs, and a listener
  the workload must not reach (filesystem stream and dgram, abstract stream and dgram) through
  `socket`, a stream pair `connect`/`sendto`, and an inherited descriptor.
- End to end through `sandboxCommand` (existing harness): piped child and `node --test`; the
  existing "Unix sockets and local binding are denied" and "cannot connect to a Unix socket in a
  selected root" tests stay unchanged and green.

## Non-goals and risks

No change to network policy, proxy, mounts, capabilities, or the runner's own stdio. Residual:
the AF_UNIX stream kernel surface (SCM_RIGHTS garbage collection, OOB data) becomes reachable
inside the container, as it is in any default Docker container; fd passing is possible only
between the workload's own processes. Rollback: revert the implementation commit; no data or
wire migration. Image rebuild is required on every host that runs arbitrary shell.

## Gates

typecheck, `lint:md`, `check:licenses`, ESLint on changed files; `npm run test` and
`npm run build` through `agent-dev --resource heavy`. Independent read-only review of the diff
by `sre-agent:test-actor` or `sde-agent:implementation-reviewer`; fixes in a separate commit.
