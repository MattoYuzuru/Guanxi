# Federation base (F1)

**Status:** implemented; local simulation verification in the lane handoff · **Updated:** 2026-10-21

`guanxi.federation` provides `federation.base`, requiring K2's `session.log`,
`egress.scrubber` and R1's `runs.durable`. The node channel has its own Zod contract at
`@guanxi/contract/federation` (`packages/contract/src/federation/`). No proprietary dependency
or third-party source was added.

## Activation and transport

Federation is off by default: no plugin, tables or routes are installed. An embedding host
opts in through `start({ federation: { identity, privateKey, peers } })`, or
`bootServerKernel(undefined, { db, federation: ... })`. The host supplies an Ed25519 PKCS8 PEM
key from its own protected credential source. Only the DER/SPKI public key enters SQLite.
The local identity and existing peer credentials cannot silently change on reopen. The
private key is held in JavaScript private fields, outside serialized service state.

The server continues to bind loopback by default. **Do not expose the legacy application
listener by changing `HOST` to a private-network address.** Its agent APIs do not gain a remote
security profile from federation authentication. A host may expose only `/api/federation/**`
through a private-network proxy, forwarding to loopback with the configured local Host
header. Other paths must be denied. No proxy, VPN, SSH, firewall or listener configuration is
performed by this module.

[Private-network guidance](../../../../docs/architecture/FEDERATION_NETWORK.md) describes the
owner's Tailscale-first / Headscale alternative and fleet roles.

`federationRoutes()` can also be mounted on an isolated node-only transport. Every peer route
requires a signed `X-Guanxi-Node` proof over method, full path/query, canonical body hash,
node id, recipient audience, protocol version, nonce and issue time. Authentication checks pinned public keys,
the local audience, revocation, a 60-second time window and durable nonce uniqueness before dispatch. Private
network encryption or TLS protects responses; signatures do not encrypt payloads. The two
device code/token endpoints are the only public bootstrap routes; neither approves a device.
The request-body budget is 1 MiB (413); callers split large batches. It is a transport budget,
not a fleet-size or context cap. `FederationOptions.configOpsPerRequest` is a positive safe
integer (default **256**) limiting operations in one `POST /config`. Larger batches return
`413 config_batch_too_large` before operation validation; callers split them. The byte budget
still applies. This host setting bounds synchronous request work, not total log size. The local
regression envelope requires a 3,000-op request within the byte budget to yield to a timer
within **250 ms** on the test machine; this is a measured fixture bound, not a real-time SLA.

`FederationChannel` signs requests through an injected transport, so constructing it opens
no network. The host maps its logical `https://federation.invalid` origin to one pinned peer
over an authenticated private link, without redirects. `synchronize()` pulls config and
explicitly selected streams whose local binding names that peer as home; run it independently for each configured peer on reconnection
or the host's schedule. There is no hub, global queue, automatic network discovery or
background network poller. `flush()` drains durable commands through `channel.command`.
Transport failure leaves an item pending; expiration and stale-version responses finish it.

## Enrollment and authority

`POST /device/code` requires `Content-Type: application/json` (optional charset accepted),
so a simple cross-origin form POST cannot allocate a code. It takes a device's freshly generated public key and returns RFC 8628-style
`device_code`, `user_code`, `verification_uri`, `expires_in` and `interval` fields. Only hashes
of both codes persist. Code storage is bounded to 128 unexpired requests, including approved,
denied and consumed codes; expired rows are purged before each allocation. A full budget
returns `429 enrollment_busy`; this is a bootstrap budget, not a fleet-size cap. Polling `/device/token` returns `authorization_pending`, `slow_down`,
`access_denied` or `expired_token` as appropriate. Approval and consumption are one-shot.
The issued node credential is its approved public-key identity; it is not a bearer secret.
Possession of the corresponding private key is required for every subsequent peer request.

An interactive owner/admin invokes the host-local `enrollment.approve(userCode, policy)` API
with the account, trust class and scopes. There is deliberately no node-channel approval
endpoint. `verification_uri` identifies the embedding host's device approval flow; the base
package has no enrollment screen or CLI. Hosts must present the user code and actual device
key for review rather than automatically approving a requested trust class. A cloud or
shared device cannot be admin-capable. Peers must be pinned by each receiving host (or
approved locally); enrollment on one node is not authority to enroll itself on another.
`revokePeer()` is host-local and needs no admin capability: any host may remove its own trust.
It takes effect even for a held authenticated context. Each node must revoke separately until
admin-signed revocations replicate (ADR-0018 §4); that replication is not implemented in F1. Re-enrollment uses a new
node id and explicit approval. No vendor OAuth tokens are read, copied or transferred.

## Shared configuration

`SharedConfig.create()` persists signed operations with an origin counter, version-vector
context and HLC. Receive order, retries and forwarding cannot change the signed author.
Vectors cover only the unbroken run of actually stored operations per origin; signed contexts
never fill gaps. Ingest defers an operation if any claimed context (including the local origin)
is absent for an origin eligible to author that operation kind for the account. Revoked,
unpinned, unscoped, wrong-account and (for identity/grant/membership writes) non-admin origins
are excluded from this dependency check; ignoring their context never advances a stored prefix. Ingest reads account-specific stored counters once and updates contiguous prefixes incrementally.
A ready queue registers each missing dot once; each operation is prepared once and reaches
signature verification at most once after its cheap context check succeeds. Work is linear in
stored counters plus input bytes/context entries (apart from indexed SQLite lookups). It never
re-parses or re-scrubs the stored log per incoming operation. The isolated 1,000-op reverse-order
regression must finish ingest within **2 seconds**. Deferred operations are not persisted
and must be retried by anti-entropy with their dependencies. Local counters derive only from
actual locally signed operations. Operations more than 60 seconds
in the future are rejected before persistence; local writes also refuse after a clock rollback
beyond the bound. Wall/logical state and origin counters survive restart.

The projected state uses LWW per `(account, kind, key)` with a deterministic HLC/origin tie
break, except grants and memberships. Their maximal causal frontier is a remove-wins set:
any concurrent remove defeats an add; an admin can regrant after observing the remove.
Identity/grant/membership operations require an admin-capable origin, including on forwarded
operations. Other metadata is multi-writer within the account. The strict metadata schemas
exclude vault records, authentication sessions and vendor credentials. Registered secret
values cause a content-free refusal rather than changing signed data.

This is shared metadata, not a replacement of K3's local secret/dispatch policies or a new
multi-account authentication UI. Connection metadata retains its owner; subscription
connections cannot be assigned to another account (D-190). Exact already-accepted duplicates remain valid after author revocation, so historical
entries cannot wedge subsequent synchronization. Each operation commits independently. Unknown/revoked authors, missing config/admin scope,
invalid author signatures, withheld content and future clock drift are skipped and counted; independent admissible
operations still commit. Context gaps are counted as deferred and retried within the batch;
`operation_conflict` stays fatal and stops the batch (already committed operations remain).
New revoked-author operations are never admitted. Missing history from an admissible origin
still defers the operation, preserving the unseen-revoke boundary (P5). Deferral can spread to
all later writes from every node that stored that history, not only the original author. This
includes content-withheld or bad-signature gaps from otherwise eligible authors; retries need
the missing admissible history, current-admin reauthoring from a receiver without the gap, or
an operator-reviewed rebaseline. No implicit prefix or historical admission certificate is created.
`synchronize()` returns `accepted`, `duplicates`, `deferred`, `skipped` and content-free `reasons`
alongside `readOnly`; callers can observe unresolved stalls and skips on every pull.
**F1-H-EQUIVOCATION (P4e, retained):** two honest receivers can hold different, validly signed
payloads for the same origin/counter. Their subsequent full-log pulls fail with
`operation_conflict` at that dot even after the author is revoked; later entries in that batch
are blocked, while earlier independent commits survive. Revocation prevents new writes but
cannot reconcile already accepted divergent signed history. Automatic conflict selection is
outside F1 because it would change immutable history and privilege causality. Quarantine the
author on all affected nodes, compare the signed variants, and perform an operator-reviewed
rebaseline from a verified canonical history on affected replicas. Independently authored clean
packets or current-admin reauthoring can restore unrelated urgent changes while that review
is pending; they do not repair the conflicting dot. Keep conflicting evidence in protected
local storage, subject to existing secret/log policy.

The local peer credential registry
is host-approved authority, separate from shared user display metadata and grant projections.

## Logs, single writers and commands

Hosts explicitly pin each `StreamBinding` to an owner, home and home epoch before export or
import. Remote data cannot assign/change homes. Session and run streams have separate ids;
a run stream projects K2 `run.lifecycle` events for that run, not a writable copy of R1's
execution tables. Imported events live only in `federation_replicas`. A pinned non-home session
cannot be created by K2/R1 on the receiving database. Continuing it requires a new fork id or
a future fenced handover.

Exports use K2's ready/withheld/catch-up-aware, re-scrubbed `remote_agent` reads. Only standard
events enter a dense replica sequence; source event sequence/writer epoch remain unchanged.
No reasoning event, reasoning placeholder or reasoning payload is transferred. Each entry
carries the stream home epoch, preceding hash, content hash and home signature. Receivers
check the explicit pin, owner-device scope, signature and contiguous chain in one transaction.
Out-of-order gaps are refused and retried after catch-up; exact duplicates insert zero rows;
conflicts and changed epochs fail closed. A new local secret registration can withhold an old
immutable replica rather than rewrite its signed history. Late source-side redaction that
changes already replicated content also produces a conflict; an operator must rebootstrap a
fresh replica after verifying the source. Automatic redaction repair is not implemented.

Only an owner's `owner_device` may receive session or run replicas. Shared devices, cloud
nodes and another account's devices get empty exports and cannot accept imported replicas.
There is **no vault replication API**, including for owner devices: opting in to encrypted
vault synchronization needs a later dedicated key exchange. Vault records and vendor logins
never enter this channel.

Commands carry id, session/run/home, `stateVersion` and expiry. The account comes from the
credential, not the command. R1 compares the current run/version and expiration in the same
home-fenced transaction as the effect, trace, durable prompt input and receipt. A changed
retry id/payload conflicts; an exact retry returns its receipt. Stop cannot cancel a later
version. Decide only admits an `input_required` run. Prompt appends a K2 prompt, advances the
version and queues durable input without starting inference. The executor consumes
`pendingPrompts()` in accepted run-version order and acknowledges with `acknowledgePrompt()`; wiring that input into the
native agent belongs to K4 integration. This API does not claim exactly-once model execution.
Optional owned-node offer reservations are implemented in
[remote-attempts](../remote-attempts/README.md). Their receipts explicitly authorize no
execution. Actual remote dispatch, holder fencing, direct executor cancellation, lease
transfer and failover remain F2.

## Telemetry and compatibility

Telemetry requires node id, source, observation time and confidence. The authenticated node
may report only itself. Older samples cannot replace newer ones; future skew is bounded.
Reads retain provenance and add age; unknown pressure/utilization stay unknown. These are
caller observations, not resource admission, measured capacity or placement scores. F3 adds
host sensors and placement; no host-pressure probe runs here.

Peers negotiate protocol major/minor. Older-major clients can authenticate and read but every
authenticated peer mutation endpoint rejects them with `contract_read_only`. A newer major is refused with
`contract_incompatible`. The outbound synchronizer also refuses to import writes from an
older-major peer, and the channel negotiates before every outgoing command to prevent a write
after an older-major read-only handshake. Version and audience are signed on every request,
so an intermediary cannot edit the sender's request version. Handshake responses are unsigned:
an intermediary able to alter responses can force a read-only downgrade or denial of service.
Response authenticity relies on the host-provided authenticated private transport or TLS;
request signatures alone do not provide downgrade protection.

### Portable workspace layouts (U1-a continuation)

Protocol 1.1 adds the strict `layout` configuration value (`guanxi.layout/1`, activation and
an optional base clock). Its key hashes the document scope and id, and the document's account
must match the signed operation. F1 verifies the author and signature before applying layout,
recovery and active-layout projection inside the same transaction as the operation and HLC.
Local layout REST writes use that same path when F1 is configured. The layout ledger remains
component-owned; no global migration or additional network transport is introduced.

One document merges by `(rev, updatedAt, device)`, with a deduplicated `Recovered layout`
loser. Named-layout activation uses the signed configuration order, so arrival order cannot
change it. Float/popout geometry never enters the signed operation. A minor-0 peer requesting
a history containing layout operations receives `426 contract_feature_unavailable`; filtering
out those operations would strand later causal dependencies, so no partial history is returned.
Hosts upgrade such peers before synchronizing layout-bearing configuration.

## Storage, upgrade and recovery

Migration **34** is additive and independently tracked by `federation_migrations` on the
node database. Main's `PRAGMA user_version` and migrations 1–31 remain unchanged; slots 32–33
are left for K4. The migration runs transactionally only on opt-in, including its ledger.
Failed DDL leaves no partial tables or ledger entry and can be retried. Reopening preserves
the op-log, HLC, pins, nonce replay protection, command outbox and receipts.

Back up the stopped node's SQLite database together with WAL before upgrade. Disabling
federation leaves its tables intact and restores the previous local-only runtime. Prefer a
forward fix; restoring the pre-upgrade backup is the rollback for schema trouble. Never drop
tables in a running node. A restored/cloned home must be quarantined until its epoch is
explicitly reconciled; automated restoration/handover and power assertions remain F2. A
partition never elects another home or admits an execution lease from a replica.

## Verification

`packages/server/test/federation/` contains the in-process deterministic scheduler and
contract/route/store/kernel tests. The lane handoff maps exit gates to direct assertions and
records the full regression envelope. The handoff records macOS and Fedora Linux fixture runs with pinned code and runtimes,
using temporary SQLite databases. They do not validate a VPN, live fleet delivery, real
provider execution or a deployed service.

### Optional local inference dispatch

The [owned-node attempt protocol](../remote-attempts/README.md) documents optional F2-a
reservations (minor2) and bounded text-only inference dispatch (minor3). Both features are off
by default and need their distinct advertised capability. Dispatch adds a fresh executor-bound
R1 attempt, signed grants/renewals, strict holder self-fencing and durable result ingestion; it
uses K3's local-runtime governor/consent path. It does not implement toolful relay execution,
detached mode, home handover or OS power assertions, and local fake-adapter tests are not MS1.
