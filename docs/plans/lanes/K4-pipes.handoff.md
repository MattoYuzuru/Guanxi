# K4-pipes hand-off: sandboxed workloads may spawn children with piped stdio

**Status:** implemented and locally validated on Linux arm64 (Colima, kernel 6.8); two independent
reviews, all findings fixed in separate commits (second round below). Not merged, not pushed. **Date:** 2026-10-23.
Branch `claude/k4-child-process-pipes` from main `47e238c7`; plan
[K4-pipes.plan.md](K4-pipes.plan.md). Decision record: ADR-0027 Appendix A.

## Cause (confirmed)

The workload seccomp filter denied `socketpair` unconditionally. libuv creates every child stdio
pipe with `socketpair(AF_UNIX, SOCK_STREAM)`, so `spawn` with piped stdio failed with `EPERM`,
including the per-file subprocesses of `node --test`. The owner reported this from the first real
two-host MS1 run (every acceptance gate and the model's own `shell` runs; `--test-isolation=none`
passed 11/11); that run is not part of this repository's evidence.

Reproduced here before any change, in the image `guanxi-native-execution:k4-v1` under the guard
with production flags: `spawnSync('echo', {stdio: 'pipe'})` gives `EPERM`, `stdio: 'inherit'`
works, and `socketpair(AF_UNIX, ...)` fails with `EPERM` for stream, datagram and seqpacket.
After the change the same new end-to-end tests are red on `k4-v1` (`spawnSync echo EPERM`) and green
on the rebuilt image (then `k4-v2`, now `k4-v3`).

The brief named `execution-owner.ts` (`setpriv --seccomp-filter`). That is the Linux bubblewrap
path. The macOS container path, where the failure was seen, applies `container/guard.c`, compiled
into the image. Both implement the same rule, so both changed. On Linux, sandbox-runtime's own
filter (per its README) blocks only `socket(AF_UNIX)` and `io_uring_*`; only our extra rule denied
`socketpair`. No document or commit message gives a reason for the denial (K4 evidence M1 only made
the TypeScript filter match the guard).

Syscall numbers and audit constants were read by compiling a probe against each architecture's
kernel headers (arm64 natively, x64 in an amd64 container): arm64 socket 198, socketpair 199,
bind 200, listen 201, ptrace 117, process_vm_writev 271, unshare 97, setns 268, mount 40,
audit `0xc00000b7`; x64 41, 53, 49, 50, 101, 311, 272, 308, 165, audit `0xc000003e`. The
second-round numbers (verified the same way): sendto/recvfrom/sendmmsg/recvmmsg/sendmsg/recvmsg are
arm64 206/207/269/243/211/212 and x64 44/45/307/299/46/47; io_uring_setup/enter/register are 425/426/427
on both. The guard.c source compiles for amd64 with `-Wall -Wextra -Werror` (not run there).

## The exact filter change

Both implementations, same policy (`guard.c` and `linuxBindingFilter()` in `sandbox-protocol.ts`):

- `socketpair` is allowed only if `args[0] == AF_UNIX (1)` and `(args[1] & 0xf) == SOCK_STREAM (1)`
  (the `SOCK_CLOEXEC`/`SOCK_NONBLOCK` flags are masked as the kernel does); every other `socketpair`
  is `EPERM`;
- **MSG_OOB (second round, P2):** `sendto`, `recvfrom`, `sendmmsg`, `recvmmsg` (flags in `args[3]`)
  and `sendmsg`, `recvmsg` (flags in `args[2]`) fail with `EPERM` when the low 32 bits of the flags
  include `MSG_OOB` (`BPF_JSET`). Holding both ends of a socketpair is the precondition for the
  Unix-domain OOB and garbage-collector kernel bugs, so this surface is new, not existing;
- **io_uring (second round, P3):** `io_uring_setup`, `io_uring_enter`, `io_uring_register` (425 to 427)
  are denied by the filters themselves; production no longer depends on Docker's default profile;
- unchanged: `socket()` allows only AF_INET/AF_INET6; bind, listen, ptrace, process_vm_writev,
  unshare, setns, mount denied; foreign audit architecture killed; x32/unknown numbers denied;
- `guard.c` also gained the x32/unknown-ABI deny that the TypeScript filter already had;
- `linuxBindingFilter()` is built from a small forward-only label assembler; the guard's offsets
  are commented per index (48 instructions). `packages/server/scripts/guard-differential.mjs`
  compiles guard.c for arm64 or amd64 and compares it with the generated program over 28,988,928
  argument combinations: 0 differences on both (and a mutated offset is caught);
- **Image identity (second round, P3):** the image is `k4-v3`, labelled
  `org.guanxi.execution-guard-sha256` with sha256(`guard.c` ‖ `Dockerfile`) by
  `prepare-native-execution.sh`. `GUARD_DIGEST` in `execution-owner.ts` holds the expected value (a
  test hashes the two files, so forgetting to update it fails); `execute()` parses the label from
  the same `docker image inspect` that selects the image id, requires exactly `<id> <digest>`, and
  otherwise fails closed with `container_runtime_unavailable` before creating a container. The
  label detects stale or mismatched builds; it does not authenticate an image rebuilt by someone
  with Docker access.
  **Every macOS node must run `DOCKER_CONTEXT=colima sh packages/server/scripts/prepare-native-execution.sh`.**
  Old tags (`k4-v1`, `k4-v2`) were left in place and are never used.

## Security argument

See ADR-0027 Appendix A for the full text. In short:

1. Intent kept: no escape to host services over Unix sockets, no network beyond the proxy, no
   binding or listening. `socket(AF_UNIX)` stays denied; abstract names belong to the empty netns.
2. A stream pair is connected at birth: `connect`/`sendto` fail (`EISCONN` for stream listeners) and
   none of four listeners received anything. Measured without a filter, a datagram pair does reach
   pathname and abstract datagram listeners, which is why the type check exists.
3. Out-of-band data: an `MSG_OOB` send on a stream pair succeeds on the test kernel without the
   filter and is `EPERM` with it; ordinary send/recv and child pipes keep working.
4. `SCM_RIGHTS` cannot be filtered by seccomp; it reaches only the pair's other end, held by the
   workload's own processes. Named residual.
5. Linux upstream already allowed `socketpair`.

## Tests (new / regression envelope)

New, all failing when their property is violated. Each second-round fix has a test commit that was
red before the fix commit (OOB: kernel `oob_send` returned ok and the unit tests accepted the flag;
io_uring: unfiltered EFAULT instead of EPERM and unit denial missing; identity: older-build image
accepted, export missing; strict parsing: extra token accepted).

- `seccomp.test.ts`: 15 tests. Instruction level, both arches: socketpair matrix; `socket` matrix;
  every deny-listed syscall including io_uring; MSG_OOB on all six calls with high-bit, other-flag
  and wrong-slot cases (sendto's length may be odd); exhaustive grids against independent reference
  models; x32, foreign and i386 architectures; structural checks. The evaluator fails on any
  `seccomp_data` offset it does not model.
- `seccomp-kernel.test.ts`: 15 tests on the real kernel in the image with production flags;
  **skipped with "container runtime or image unavailable" when Docker or the image is missing**, so a
  green run without Docker proves nothing about the kernel. Runs the compiled guard and the
  generated program (Perl `prctl` loader, since the image's util-linux `setpriv` predates
  `--seccomp-filter`): policy matrix, stream pair reaches no listener (errno `EISCONN`, counters 0),
  controls (a datagram pair and a plain stream socket do reach without the filter), per-syscall
  unconfined probes with unfiltered controls including MSG_OOB on six calls and io_uring (skipped
  per name when `kernel.io_uring_disabled` is set), real `send(MSG_OOB)`/`recv(MSG_OOB)` on a pair
  `EPERM` while plain `send`/`recv` works, `node -e` pipes, `node --test` without
  `--test-isolation=none`, and the image label equals `GUARD_DIGEST`.
- `image-identity.test.ts`: 8 tests. Digest equals the file hash; the script labels with the same
  label; with a fake docker, an unlabeled (older) image, a different digest, extra tokens, a missing
  image all fail closed after exactly one `image inspect` and no `create`; the current digest passes
  the gate; the label is read by the same inspect that selects the id.
- `sandbox.test.ts`: 2 end-to-end tests (piped children plus `node --test`; listen/connect still
  denied afterwards); the two daemon-loss fakes now answer the new inspect format.
- Regression envelope: the full `npm run test` run (receipt below).

Not verified here: the Linux `setpriv`/bubblewrap path and sandbox-runtime's outer filter on a real
Linux host (the integrator runs them on Fedora); the new `sandbox.test.ts` cases and kernel tests on
x64; `guard.c` was only compiled, not run, on amd64.

## Independent verification

Round 1, `sde-agent:implementation-reviewer` on `47e238c7..b09fd84d`: no exploitable hole; guard
offsets and a differential checked; findings fixed in `3af72923` (per-syscall guard probes, errno
and stream-listener controls, listener drain, absolute paths, ADR wording).

Round 2, the coordinator's Opus security review: no P1, BPF verified on the real kernel including
high-bit arguments. P2 (MSG_OOB surface is new, not "already reachable") and P3 (io_uring,
image identity, hand-off notes) fixed in separate test and fix commit pairs; ADR text corrected.
Then a separate `sde-agent:implementation-reviewer` pass on `b09fd84d..` found no high or medium
issues and five low ones, all handled: stale hand-off text (this file), lax label parser (exact
match plus a test), docs overclaiming what the label proves (stated), differential harness not in
the repo (committed), `kernel.io_uring_disabled` hosts (probe skips those names).

## Gates

Filled in below after the final frozen run.

## Residual risks

- `SCM_RIGHTS` descriptor passing and garbage collection of in-flight descriptors remain reachable
  between the workload's own processes. Only the `MSG_OOB` part of the Unix-domain surface is closed.
- A workload can learn whether a pathname or abstract name exists from the `connect` errno (names
  only; abstract names belong to the empty network namespace).
- The image label is not an authentication: it catches stale or mismatched builds, not a deliberate
  rebuild with a forged label (Docker access is root-equivalent). The image build uses unpinned apt
  packages; the guard binary is not re-checked at run time. The error for a stale image is the same
  `container_runtime_unavailable` as for a missing runtime; a distinct operator hint (and a doctor
  check) would help but is a follow-up.
- TCP urgent data (`MSG_OOB` on AF_INET) is now refused as well, by design.
- The Linux setpriv/bubblewrap path, sandbox-runtime's outer filter, x64 execution and Fedora are
  unverified here (the compiled amd64 guard was compared at instruction level only). Kernel tests
  skip without Docker.
- Status files `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` are not edited by this lane (lanes
  README, rule 7); the integrator folds this file in.

## Shared edits

`packages/server/src/relay/README.md`, `docs/operations/ms1-live-run.md`,
`docs/plans/evidence/K4.md` (one pointer sentence), the native-agent README and ADR-0027.

## Next slice

Integrator: merge, rebuild `k4-v3` on every macOS node, run the native-agent tests on Fedora/x64
(bubblewrap, setpriv, sandbox-runtime filter), and rerun an MS1 gate with plain `node --test`.
