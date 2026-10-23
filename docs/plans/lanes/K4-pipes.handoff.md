# K4-pipes hand-off: sandboxed workloads may spawn children with piped stdio

**Status:** implemented and locally validated on Linux arm64 (Colima, kernel 6.8); independently
reviewed, findings fixed in a separate commit. Not merged, not pushed. **Date:** 2026-10-23.
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
on `k4-v2`.

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
guard.c source compiles for amd64 with `-Wall -Wextra -Werror` (not run there).

## The exact filter change

Both implementations, same policy (`guard.c` and `linuxBindingFilter()` in `sandbox-protocol.ts`):

- removed `socketpair` from the unconditional deny list;
- added: `socketpair` is allowed only if `args[0] == AF_UNIX (1)` and `(args[1] & 0xf) == SOCK_STREAM (1)`
  (the `SOCK_CLOEXEC`/`SOCK_NONBLOCK` flags are masked as the kernel does); every other `socketpair`
  is `EPERM`;
- unchanged: `socket()` allows only AF_INET/AF_INET6; bind, listen, ptrace, process_vm_writev,
  unshare, setns, mount denied; foreign audit architecture killed; x32/unknown numbers denied;
- `guard.c` also gained the x32/unknown-ABI deny (`nr >= 0x40000000`) that the TypeScript filter
  already had (incidental, strictly more restrictive);
- `linuxBindingFilter()` is now built from a small forward-only label assembler instead of
  hand-counted offsets; the guard's offsets are commented per index;
- the execution image and its label moved `k4-v1` to `k4-v2` (`CONTAINER_IMAGE`,
  `prepare-native-execution.sh`). A host that has not rebuilt fails closed with
  `container_runtime_unavailable` instead of running with `spawn EPERM`. `k4-v1` was left in place.
  **Every macOS node must run `DOCKER_CONTEXT=colima sh packages/server/scripts/prepare-native-execution.sh`.**

## Security argument

1. Intent kept: no escape to host services over Unix sockets, no network beyond the proxy, no
   binding or listening. `socket(AF_UNIX)` stays denied, so no unconnected Unix socket exists to
   `connect` to a pathname or abstract name; abstract names are scoped to the empty network namespace.
2. A stream pair is connected at birth: `connect`/`sendto` on it fail (`EISCONN` for stream
   listeners) and none of four listeners (pathname/abstract, stream/datagram) received anything.
   Measured without a filter, a **datagram** pair connects to and delivers to both the pathname and
   the abstract datagram listener. That is why the type check is part of the fix, and seqpacket
   (not needed) stays denied.
3. `SCM_RIGHTS` over a pair reaches only its other end, held by the workload's own processes; the
   trusted runner holds no end of a new pair. The workload's existing stdout/stderr sockets to the
   runner are an existing property and unchanged.
4. Linux upstream already allowed `socketpair`; Docker's default profile allows it too.
5. Residual: the kernel's AF_UNIX stream surface is now reachable (named below).

## Tests (new / regression envelope)

New, all failing when their property is violated (mutations tried: dropping the stream-type check,
allowing `socket(AF_UNIX)`, and a compiled guard mutant with `BLOCK(mount)` replaced and the x32 bound
raised, each fail tests):

- `seccomp.test.ts`: 11 tests (2 replaced). Instruction level, both arches: socketpair
  AF_UNIX/STREAM allowed with and without flags, dgram/seqpacket/raw and every non-AF_UNIX family
  denied, `socket` AF_UNIX denied and AF_INET/INET6 allowed, every deny-listed syscall, x32,
  foreign and i386 audit architectures, an exhaustive grid against an independent reference model
  (450 syscall numbers x 7 families x 64 type values), and structural checks (jumps in range,
  size, ends in a return). The evaluator fails on any `seccomp_data` offset it does not model.
- `seccomp-kernel.test.ts`: 13 tests on the real kernel in the image with production flags;
  skipped with "container runtime or image unavailable" when Docker or the image is missing. Runs the
  compiled guard **and** the generated `linuxBindingFilter()` program (installed by a Perl `prctl`
  loader, since the image's util-linux `setpriv` predates `--seccomp-filter`). Policy matrix; stream
  pair cannot reach pathname/abstract stream/datagram listeners and listener counters stay 0 (with
  errno `EISCONN` for stream listeners); control run proves a datagram pair does reach, and a plain
  stream socket does connect, without the filter; every other denied syscall plus x32/unknown ABI
  numbers return `EPERM` unconfined while the unfiltered control does not; `io_uring_setup` is
  `EPERM` under the runtime default profile (precondition); `node -e` with sync/async/stdin pipes;
  `node --test` on a two-file fixture without `--test-isolation=none`, asserting two distinct
  child pids with one parent.
- `sandbox.test.ts`: 2 end-to-end tests through `sandboxCommand` (piped children plus `node --test`
  per-file subprocesses; after spawning children the workload still gets `listen EPERM`,
  `connect EPERM` to a host Unix socket and the host listener counts 0). The existing "Unix sockets
  and local binding are denied" and "cannot connect to a Unix socket in a selected root" tests are
  unchanged and green. Line 428 now uses `CONTAINER_IMAGE`.
- Regression envelope: the full `npm run test` run (receipt below).

Not verified: the new `sandbox.test.ts` cases and the kernel tests have not run on a Linux host
(bubblewrap path, `setpriv`) or on x64; `guard.c` was not run on x64. Fedora runs belong to the
integrator.

## Independent verification

`sde-agent:implementation-reviewer` (read-only, separate action) reviewed `47e238c7..HEAD`: no
exploitable hole; every guard.c jump offset checked by hand; a differential of 1,129,600 argument
combinations between the compiled guard and the TypeScript program had zero differences; stream pair
`connect`/`sendto`/raw `sendmsg` with `msg_name` all `EISCONN`, also after peer close and
`shutdown`; high-bit family and type values behave identically in kernel and filter. Findings and
fixes (commit `3af72923` and this hand-off): broken hand-off link (written); guard.c policy only
partly asserted (per-syscall unconfined probes added, guard mutation now caught); io_uring claim
unasserted (precondition test added); probe could not say why it was refused and lacked a stream
control (errno and plain-socket control added); listener could miss a datagram queued at stop
(drained); e2e test used cwd-relative paths (absolute); ADR wording on evidence and residuals.

## Gates

All on source `d0defc8c` (clean tree, source unchanged during each run), Node 26.9.0:

| Gate | Result |
| --- | --- |
| `npm run typecheck --workspace @guanxi/server` | clean (no TypeScript errors) |
| `npx eslint` on the five changed `.ts` files | exit 0, no findings |
| `npm run lint:md` | 0 markdownlint errors, 292 files / 777 links, 0 link problems |
| `npm run check:licenses` | 675 packages, 0 not allowed (no dependency or copied code added) |
| `agent-dev ... --resource heavy -- npm run test` | `ok: true`, exit 0; receipt `~/.local/state/agent-dev/check-exxo30g8/result.json`; the server suite reports 2968 tests, 2966 pass, 0 fail, 2 skipped (two Linux-only tests: sandbox worker nice level, long-TMPDIR proxy startup) |
| `agent-dev ... --resource heavy -- npm run build` | `ok: true`, exit 0; receipt `~/.local/state/agent-dev/check-uh_4zq54/result.json` |

A first full run on `b40b5ee7` also exited 0 but the tree changed under it (receipt
`check-7hzvrj8i`, `source_changed: true`), so it is not credited. The G12 base variable was not
needed. Direct runs of the new files on the lane machine: `seccomp.test.ts` 11/11,
`seccomp-kernel.test.ts` 13/13 (0 skipped), the two new `sandbox.test.ts` cases 2/2.

## Residual risks

- AF_UNIX stream kernel surface (SCM_RIGHTS garbage collection, out-of-band data) is now reachable
  from the workload, as in any default Docker container.
- A workload can learn whether a pathname or abstract name exists from the `connect` errno (names
  only; abstract names belong to the empty network namespace).
- The container path relies on the runtime's default seccomp profile to deny `io_uring_setup`
  (asserted by a precondition test). Adding 425-427 to `guard.c` and the Linux filter would remove
  the dependency; left out as a policy change beyond this slice.
- Image tags are mutable names; the tests run whatever `k4-v2` is present. Hosts must rebuild.
- Nothing here was run on Fedora/x64 (see above). Status files `PHASE_STATUS.md` and
  `NEXT_AGENT_PROMPT.md` are not edited by this lane (lanes README, rule 7); the integrator folds
  this file in.

## Shared edits

`packages/server/src/relay/README.md`, `docs/operations/ms1-live-run.md`,
`docs/plans/evidence/K4.md` (one pointer sentence), the native-agent README and ADR-0027.

## Next slice

Integrator: merge, rebuild `k4-v2` on every macOS node, re-run the Fedora/x64 envelope for the
native-agent tests, and rerun an MS1 gate with plain `node --test`.
