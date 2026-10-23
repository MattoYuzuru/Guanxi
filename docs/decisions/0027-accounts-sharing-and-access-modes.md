# ADR-0027: Accounts, sharing and the two access modes

**Status:** accepted for the two modes (owner decisions D-111, D-118); proposed design · **Date:** 2026-10-19

## Context

Family members or friends may share one installation, each with private sessions and their own
connections (REQ-A6, REQ-E1, REQ-E2), and share sessions read-only or with write access (REQ-D5). Only two
user-facing access modes are wanted: Full access and Read-only (REQ-D3). Remote access means
leaving loopback, which the legacy rules allow only with a security profile (authentication,
TLS, allowed roots).

## Decision

1. **Authentication**: Better Auth embedded in the Hono server on `node:sqlite`, pinned, with
   only these plugins: email/password, passkey, admin (invite, ban, revoke sessions),
   optional two-factor, device authorization (RFC 8628) for phones, CLIs and new nodes, and
   API keys (hashed, scoped, expiring). SSO, SCIM, OAuth-proxy, OAuth-provider and MCP plugins
   stay off (most advisories are there).
2. **Authorization**: global roles `admin` and `member`; a `grant` table in Zanzibar tuple form
   `(resource_type, resource_id, relation ∈ {owner, editor, viewer}, subject_type ∈ {user,
   group, link}, subject_id, created_by, created_at, expires_at)`; one server-side
   `can(principal, action, resource)` function; clients receive a permission snapshot.
3. **Privacy**: every project, session and connection has an `owner_user_id` and is private by
   default. Admins cannot open other users' sessions in the UI; this is policy, not
   cryptography, and is documented as such.
4. **Sharing**: `viewer` sees the live session including sub-agents; `editor` may prompt and
   stop. Editor turns run on the session owner's connections only if the owner allowed it,
   otherwise on the editor's own connections; the origin of every prompt is logged. No public
   link without login by default.
5. **Access modes** (per session, default per project):
   - *Read-only*: file reads within the project roots and attachments; no writes except the
     session scratch directory; shell limited to an allowlist of read-only commands; network
     only through Guanxi's egress proxy, which allows `GET`, `HEAD` and `OPTIONS` and blocks
     every other method and raw sockets (a `network: none` option exists). This prevents side
     effects on other systems; it is not a confidentiality control, since a `GET` can still
     carry data;
   - *Full access*: the agent acts with the user's OS rights inside the project roots and the
     network allowlist, with no approval prompts. A project with **zero roots** gets write
     access only to the session scratch directory (`~/.guanxi/scratch/<session>`) and read
     access to its attachments.
   Both are enforced by the OS sandbox (`sandbox-runtime`: Seatbelt on macOS, bubblewrap on
   Linux, a restricted user plus Windows Filtering Platform on Windows), not by the prompt.
   A **deny-write profile** for protected paths (tests, specs, CI config listed in a run's
   plan) is layered on top of either mode (ADR-0020). Remote clients have the same rights as
   the desktop (REQ-B3).
   *Implementation (K4, 2026-10-21, implemented and locally validated):* a sandbox alone
   does not own the processes a command leaves behind, so arbitrary shell runs behind an
   `ExecutionOwner` that kills every descendant (setsid, nohup, double fork) when the command
   ends, is cancelled or times out. On **Linux** it is sandbox-runtime's bubblewrap profile
   plus `--unshare-pid --die-with-parent` and a seccomp filter. On **macOS** Seatbelt cannot
   own descendants, so each arbitrary command runs in its own `--rm --init --network none`
   Linux container (Colima), reaching the network only through the sandbox-runtime proxy.
   **Windows** refuses arbitrary shell until a restricted-user backend exists. Uncertain
   cleanup ends in `cleanup_unconfirmed` and a persistent root quarantine, never a second
   writer. Evidence: [K4](../plans/evidence/K4.md).
6. **Confirmations (D-118)**: neither mode prompts. A run stops for a person only through an
   `input_required` escalation or because an action is on the project's
   `requires_confirmation` list (default empty; for example cloud launches or publishing).
7. **Remote security profile**: loopback stays the default; remote binding requires accounts,
   TLS on one canonical hostname (own domain or `*.ts.net`), node credentials, allowed roots
   per node, and audit of remote execution.

## Consequences

Passkeys require a real HTTPS hostname (IP addresses are forbidden by WebAuthn); renaming the
tailnet invalidates them. Better Auth needs advisory monitoring.

## Validation

Authorization matrix tests (owner/editor/viewer/admin/anonymous × every action); sandbox tests
that Read-only cannot write outside scratch, and that a `POST`/`PUT`/`DELETE` or a raw socket
from Read-only is blocked; Full access with zero roots cannot write outside scratch; a
protected path cannot be written in either mode; remote bind refuses to start without TLS,
accounts and allowed roots.

## Evidence

Lane 2 §4, lane 5 §1.5 (sandbox runtime) ([research](../research/README.md)); WebAuthn
Level 3; NIST RBAC/ABAC; Zanzibar (USENIX ATC '19).

## Appendix A: workload syscall filter and child-process pipes (K4-pipes, 2026-10-23)

**Status:** implemented · locally validated on Linux arm64 (kernel 6.8, Colima). On x64 the generated
program is validated at instruction level and its numbers were read from amd64 kernel headers;
`guard.c` was compiled for amd64 with `-Werror`, and its compiled program was compared with the
generated one over 29 million argument combinations, but it was not run there.

*Problem.* The workload seccomp filter denied `socketpair` outright, so every Node child with
piped stdio failed with `EPERM` (libuv builds those pipes from `socketpair(AF_UNIX, SOCK_STREAM)`),
including the per-file subprocesses of `node --test`. The first real two-host MS1 run (2026-10-23, as
reported by the owner; see the hand-off) failed every acceptance gate this way, and only
`--test-isolation=none` passed. No earlier document gives a reason for
the denial beyond "no arbitrary Unix sockets"; the Linux filter was only made to match the
container guard.

*Decision.* The filter (container guard `guard.c` and `linuxBindingFilter()`, kept equal) allows
`socketpair` only when the domain is `AF_UNIX` **and** `type & 0xf` is `SOCK_STREAM`; the
`SOCK_CLOEXEC` and `SOCK_NONBLOCK` flags are masked off exactly as the kernel does. Because that
gives the workload both ends of an `AF_UNIX` socket, the same filters also deny, with `EPERM`:

- any `sendto`, `recvfrom`, `sendmmsg`, `recvmmsg` (flags in `args[3]`) or `sendmsg`, `recvmsg`
  (flags in `args[2]`) whose low 32 flag bits include `MSG_OOB`;
- `io_uring_setup`, `io_uring_enter` and `io_uring_register` (425 to 427 on x64 and arm64), so
  `IORING_OP_SOCKET` cannot create sockets past the `socket()` rule and production no longer relies
  on the container runtime's default seccomp profile.

`socket()` stays limited to `AF_INET` and `AF_INET6`; `bind`, `listen`, `ptrace`,
`process_vm_writev`, `unshare`, `setns` and `mount` stay denied; a foreign audit architecture kills
the process and x32 or unknown syscall numbers are denied (the guard gained this x32 check).

*Image identity.* The execution image is now `k4-v3`. The provisioning script labels it
`org.guanxi.execution-guard-sha256` with the sha256 of `guard.c` followed by the `Dockerfile`; the
node holds the expected value (`GUARD_DIGEST`, kept honest by a test that hashes the two files) and
`execute()` reads the label in the same `docker image inspect` that selects the image id. A missing
image, a missing label (any older build) or a different label fails closed with
`container_runtime_unavailable` before any container is created, so a stale tag cannot run another
policy.

*Security argument.*

1. The intent is unchanged: no path to host services over Unix sockets, no network beyond the
   proxy, no binding or listening. `socket(AF_UNIX)` remains denied, so a workload cannot create an
   unconnected Unix socket and `connect` to a pathname or an abstract name. Abstract names are also
   scoped to the network namespace, which is empty (`--network none`, or `--unshare-net`).
2. A stream pair is born connected to its own other end. Measured in the image without any filter:
   `connect` and `sendto` on it fail with `EISCONN` or `ECONNREFUSED`, and none of four listeners
   (pathname and abstract, stream and datagram) received anything. The same experiment with a
   **datagram** pair connects to both the pathname and the abstract datagram listener and delivers
   data, so datagram pairs, seqpacket (not needed) and every other type stay denied. This type check
   is load-bearing, with an assertion that fails without it.
3. Out-of-band data is a new surface, not an existing one. Before this change the workload held at
   most one end of any `AF_UNIX` socket (its stdout and stderr, whose other ends the runner holds).
   A socketpair hands it both ends, the precondition for the Unix-domain `MSG_OOB` and
   garbage-collector kernel bugs (the independent security review named CVE-2025-38236, CVE-2021-0920
   and CVE-2024-26923; not re-verified here). `MSG_OOB` is therefore refused on every send and
   receive path, as that review notes Chrome's sandbox does; on the test kernel an `MSG_OOB` send on a stream pair succeeds without the filter and is
   `EPERM` with it, while ordinary `send`/`recv` and child pipes work.
4. `SCM_RIGHTS` cannot be filtered by seccomp. Descriptor passing over a pair reaches only its other
   end, which the workload's own process tree holds; the trusted runner holds no end of a new pair.
   This is a named residual (below), bounded by that argument.
5. On Linux, sandbox-runtime's own filter documents that it blocks only `socket(AF_UNIX)` and
   `io_uring_*` (read from its README, not re-measured), so the extra `socketpair` rule only
   removed what that layer allowed. Docker's default profile allows `socketpair` for ordinary
   containers; our filters no longer depend on it for `io_uring`.
6. Residual risks, named and not eliminated:
   - `SCM_RIGHTS` descriptor passing and garbage collection of in-flight descriptors remain
     reachable between the workload's own processes. Only the `MSG_OOB` half of the Unix-domain
     garbage-collector surface is closed; the rest of the AF_UNIX stream implementation is reachable.
   - `connect` on a stream-pair end looks up the target before it reports `EISCONN`, so the
     workload can tell whether a pathname or abstract name exists (`ENOENT`, `EACCES`,
     `ECONNREFUSED`, `EPROTOTYPE`). That discloses names only and opens no data channel; abstract
     names belong to the empty network namespace.
   - The Linux bubblewrap and `setpriv` path and sandbox-runtime's outer filter are not verified
     on a real Linux host; the integrator runs them on Fedora.

*Evidence.* [K4-pipes hand-off](../plans/lanes/K4-pipes.handoff.md); real-kernel tests in
`packages/server/test/native-agent/seccomp-kernel.test.ts`, instruction-level tests in
`seccomp.test.ts`, end-to-end tests in `sandbox.test.ts`.
