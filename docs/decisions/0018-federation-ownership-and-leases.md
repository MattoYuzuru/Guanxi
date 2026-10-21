# ADR-0018: Multi-master federation with single-writer ownership and fenced leases

**Status:** accepted direction (owner decisions D-105, clarified by D-116); proposed design ·
**Date:** 2026-10-19 (revised after the S0 review the same day)
**Relates:** legacy ADR-0002 (Resource Governor), ADR-0004 (durable jobs), ADR-0013 (service).

## Context

The owner wants the same Guanxi on every machine, data synced between them, no mandatory
central server, phones as remote clients, and agents that use whichever machine is free.
Lanes 2 and 3 recommended a single canonical hub because naive multi-master (CRDT or
last-writer-wins on everything) is wrong for jobs, stops and resource permits: they do not
commute, and a lost "stop" is unacceptable. The owner chose multi-master anyway (D-105).
The S0 review found that the first version of this ADR leaked secrets to every peer, checked
fencing only at the granter, and left several ownership transitions undefined; this revision
fixes those.

## Decision

### 1. Who writes what (D-116)

| Data | Writer | Notes |
| --- | --- | --- |
| Session log | the session's **home node** | single writer, `(stream, home_epoch, seq)` + content hash |
| Run state (incl. `waiting_children`, terminal states) | the run's home node | single writer |
| Attempt stream (events of one execution) | the executing node, only under a valid fencing token | the home node validates and ingests it into the session log |
| Hardware and local resource leases | the machine that owns the resource | its governor admits Guanxi work only; load from outside Guanxi is telemetry with provenance, not admission |
| Shared configuration (accounts, grants, projects, connection metadata, glossaries, settings) | any node (identity and grants: admin-capable interactive nodes only) | multi-writer by design, merged by §4 |
| Artifacts | the producer; recovery-critical artifacts (sealed handoffs, git bundles) are uploaded to the run's home on seal | content-addressed, immutable |

A peer that cannot reach a run's home shows it as `home_unreachable` (a local display state);
it never writes a run transition for a run it does not own.

### 2. Replication scope

- Nodes have a trust class: `owner_device` (enrolled by the account owner or an admin for that
  account), `shared_device` (a multi-user installation), `cloud_ephemeral`.
- Session and run logs replicate only to the session owner's `owner_device` nodes. Other
  accounts with grants read through the API of a node that holds the log; they are not given
  replicas.
- The account vault exists only on `owner_device` nodes the owner opted in. Wrapping a secret
  with a node key (for unattended use) applies only to connections marked `unattended`
  (ADR-0017).
- `cloud_ephemeral` nodes receive no session replicas and no vault. A cloud attempt gets
  per-attempt, scoped, expiring secret grants if its run policy allows, and nothing else.
- Reasoning events are never replicated; they stay on the home node and are served only to
  agents on local runtimes of owner devices (ADR-0023).

### 3. Leases and fencing

- **Key**: one fence per run execution slot (`run:<id>/exec`); every attempt of that run takes
  a token on the same key, so two attempts can never both be active. Child resource leases
  (ports, containers, databases, worktrees, displays, VM slots) are separate keys on the machine
  that owns them.
- **Ownership transitions**, all as a transaction on the granting node: grant on a free key;
  holder release; expiry; fenced handover (moves the whole lease table to a new home epoch);
  audited admin break. Timeouts (start-to-close, heartbeat) and failure detectors only stop
  renewal; a new attempt is granted only after the old lease has expired or was released.
- **Tokens** are monotonic per key and paired with the granter's epoch. **Stale** means a lower
  `(epoch, token)` or an expired lease; any mutation carrying a stale token gets
  `409 stale_lease`.
- **Granter clock**: deadlines are stored durably on the granter and measured with its
  monotonic clock plus a persisted wall-clock reference; after a granter restart, a grace
  period of `max_ttl + ε` passes before any expired key is re-granted. The epoch increases
  only when a node's database is restored from backup or cloned, never on a plain restart.
- **Holder clock**: the holder self-fences at `local_monotonic(last renew sent) + ttl − ε`;
  it renews before its first side effect and synchronously before any irreversible external
  effect.
- **Side effects by target** (fencing must hold where the effect lands, not only at the granter):
  - *granter-checked*: attempt events, completion, handoff sealing;
  - *Guanxi-owned, token-aware*: each attempt pushes git only to
    `refs/guanxi/attempts/<attempt_id>`; only the home node advances a canonical branch, on an
    accepted completion. Databases and containers are namespaced per attempt and reaped;
  - *external APIs that cannot check tokens* (cloud launches, publishing, payments): require an
    idempotency key `(run_id, step_id)`; in `strict` mode they are forbidden unless the
    provider honours idempotency, or the run policy lists them in `requires_confirmation`.
- **Partition modes** per work class: `strict` (self-fence at the deadline) and `detached`
  (idempotent batch continues; its outputs are candidates that the home accepts in a
  transaction guarded by content hash and token).

### 4. Shared configuration merge

- Operations carry hybrid logical clock timestamps; a node rejects operations more than
  60 seconds ahead of its own clock.
- Fields merge last-writer-wins, except grants and memberships, which use a remove-wins set
  with version vectors so that a revoke concurrent with a grant wins.
- Identity tables (users, credentials, grants, node enrollment) are written only by
  admin-capable interactive nodes; authentication sessions are node-local and never replicate.
- One enrollment path: device authorization (RFC 8628) issues a node credential with scopes
  (which work kinds the node may claim) and a trust class.

### 5. Homes, delegation and power

- A run that delegates (its home grants the child's fencing token and owns its timers) must
  have an `always_on` home. `delegate()` from a laptop first performs a fenced handover of the
  lead's run to an `always_on` node; if none exists, it fails with `no_always_on_home` and the
  UI explains why.
- A node holds a power assertion while it holds or **grants** active leases or has pending
  timers (D-148); Wake-on-LAN is opt-in per node.

### 6. Commands

"Stop", "prompt" and "decide" (for `input_required`) are bound to `(run_id, state_version)`
and carry an expiry. They go to the home node; if the home is unreachable they wait in the
client's outbox and are dropped when they expire or when the version has moved on. Stopping is
always safe, so the executing node also accepts a cancel directly from an authenticated client
of the session owner, applies it, and reports it to the home when it can.

### 7. Placement

The node that wants work done scores candidates from gossiped telemetry and sends an offer;
the target's governor accepts or rejects. No global queue and no consensus.

### 8. Federation contract

Node↔node messages (replication, offers, leases, attempt streams, commands) have their own
versioned Zod contract in `packages/contract/federation`. Peers negotiate a version on
connect; a peer on an older major version is read-only until upgraded.

### 9. Transport

A private network (hosted Tailscale first, self-hosted Headscale documented, D-146) plus Guanxi's node credentials
(signed requests or mTLS).

## Invariants

- At most one active lease per key; tokens strictly increase per key and epoch.
- No accepted mutation, and no Guanxi-owned side effect, carries a stale token.
- Exactly one terminal transition per run; exactly one resolution per promise.
- A session never has two writers; continuing a non-home session requires a fork or a fenced
  handover.
- A `cloud_ephemeral` node never holds a vault record, a session replica or a reasoning event.

## Consequences

- Offline laptops keep working with their own sessions and local models and merge on
  reconnect without manual conflict resolution.
- Long delegations need an always-on machine; for the owner this is the Fedora PC (D-186,
  ADR-0038).
- If a home node is lost permanently, its runs stay `home_unreachable` on peers and can be
  forked; there is no automatic failover.

## Alternatives considered

- **Single canonical hub** (lanes 2 and 3): simpler global queue and fairness, but a required
  always-on server and a single point of failure; rejected by D-105.
- **CRDT/LWW on everything**: loses stops and double-grants permits.
- **Raft**: needs at least three voting nodes that stay up; disproportionate for a personal
  fleet.

## Validation (assertions that fail when the property breaks)

1. Deterministic simulation with random interleavings: ≤1 active lease per key, strictly
   increasing tokens, no accepted stale mutation, exactly one terminal per run.
2. A holder paused with `SIGSTOP` longer than the TTL resumes and attempts a git push, a dev
   database write and a cloud launch: **0 effects land** and the attempt is fenced.
3. The run's home sleeps mid-run: the run either completes or wakes the lead exactly once
   after the home returns; the child never runs without a valid lease.
4. Replicas of shared configuration converge to an identical state hash after random op
   interleavings; a revoke concurrent with a grant wins.
5. A `cloud_ephemeral` node receives 0 vault records, 0 session replicas and 0 reasoning
   events over a full delegated run.
6. A home restored from an older backup bumps its epoch, catches up from peers before
   appending, and peers never drop new events as duplicates.
7. A stop issued while the home is unreachable never cancels work started after the stop's
   `state_version`.

## Evidence

Lane 2 §5, lane 3 §§4, 7 ([research](../research/README.md)); Gray & Cheriton (leases),
Chubby sequencers and grace period, Kleppmann (fencing tokens), Kulkarni et al. (hybrid
logical clocks), Shapiro et al. (CRDT remove-wins sets), Kleppmann et al. (local-first
software); S0 review findings CR-1, CR-3, H-1, H-2, H-3, H-7, H-11, M-5, M-16, M-17.

## F1 implementation boundary (2026-10-21)

The [F1 module guide](../../packages/server/src/federation/README.md) records the implemented
base: signed device credentials, HLC/remove-wins configuration, scoped read-only log replicas,
provenance telemetry and version-bound home commands. [Network guidance](../architecture/FEDERATION_NETWORK.md)
is documentation only. Remote attempts, direct executor cancel, fenced home handover, power
assertions and restored-home epoch recovery remain F2; this ADR as a whole is not implemented.
