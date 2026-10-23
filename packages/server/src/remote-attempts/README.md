# Owned-node offers and local inference dispatch (F2-a / bounded F2-b)

**Status:** implemented internal foundation; fixture validation in the lane handoff.

F1's optional `attempts: { maxReservationMs }` host configuration enables owned-node local
inference offers. The plugin injects the existing Resource Governor. Constructing the feature
starts no inference, network connection, runtime, workspace or timer; first use initializes
metadata only after R1 grants the local home generation. R1 restart grace therefore leaves
the feature temporarily unavailable instead of preventing the rest of the node from booting.
Without this configuration there are no offer tables, capability or governor reservations.

Protocol 1.2 adds the explicit `attempts` credential scope and
`attempt-reservations-v1` handshake capability. Both minor 2 and that capability are required
by `FederationChannel.offer()`. U1-only minor 1 does not imply support. Older strict handshake
readers receive the original field set. Requests retain F1's signed audience/body/nonce and
private authenticated transport/TLS requirement; responses rely on that transport.

`Federation.createAttemptOffer()` records home intent through R1's existing fenced attempt
transaction, deriving session/run/home/fence from the admitted attempt. Its expiry cannot
exceed the current execution lease. Targets require a same-account owner-device credential
with the attempts scope, an explicit pinned run/home/epoch binding, their exact executor id,
and fresh offer expiry. No credential or reasoning payload travels in an offer.

The target persists queued intent, awaits its actual governor permit, rechecks authorization,
expiry and its own R1 home generation, then persists a reservation. Duplicate concurrent
offers share one admission; changed payloads conflict. Newer home fences invalidate older
reservations after their metadata transaction commits. Target TTL is the smaller of offer
expiry and the host's explicit `maxReservationMs`; monotonic and wall deadlines both apply.
Cancel, expiry and shutdown release permits, including a permit promoted while shutdown is
already removing its queue entry. Restart invalidates previous queued/reserved receipts;
it never recreates admission or resumes work from them.

Every receipt has **`dispatchAuthorized: false`**. A reserved receipt describes only a
process-local Resource Governor permit, with source/time/confidence. It proves neither host
capacity nor installed-model/window fit. The offer facade has no execute method. The distinct optional dispatch protocol below
adds renewable authorization and text-only inference; a receipt alone still cannot run work. Strict mode is the
only supported offer mode; detached execution, side-effect classes, restore/handover epochs,
power assertions and the whole F2 exit gate remain unfinished.

Independent additive migration **36** owns `remote_attempt_migrations`, `remote_home_offers`,
`remote_target_offers` and `remote_target_fences`; it changes no global, F1, R2 or U1 migration.
Failed DDL rolls back/retries. Back up stopped SQLite with WAL before enabling it on retained
data. Rollback disables the optional feature and retains its evidence; use a forward fix or
restore the stopped pre-upgrade backup, never a destructive down migration.

Tests use isolated local stores, signed in-memory channels and the real process-local
governor. They run no model, provider, host connection, git push or cloud launch. They are not
remote execution, calibrated placement or the six-hour MS1 evidence. Current owner scope is
local Mac/Colima only; no SSH or remote-host operation is part of this slice.

## Renewable text-only inference (bounded F2-b)

Protocol **1.3** and the separate `local-inference-dispatch-v1` capability opt into dispatch.
A peer implementing reservations only cannot accidentally advertise execution support.
Host configuration requires `attempts` plus `dispatch: { ttlMs, safetyMs, maxModelAgeMs,
channel }`. A target additionally supplies `localModel(model)` returning an exact installed-local
model/connection attestation with source and observation time. Unknown, cloud, future or stale
attestations refuse admission; `:cloud` models are refused. The plugin obtains K3's Connections
service when a local model resolver is configured. This is a trusted host inventory assertion,
not a model-fit probe or verification of external runtime configuration.

The host calls `prepareDispatch(runId, executor, job, reservationMs)` on a submitted or explicitly
interrupted run. It creates a **fresh** R1 attempt and atomically binds that token to the executor,
job and offer intent. Existing local attempts cannot be promoted. Local R1 executor methods
reject bound attempts; only a trusted synchronous executor scope derived from the authenticated
peer can renew or ingest them. Run cancellation and expiry remain home-owned. Explicit retry
is possible after R1 releases/expires and reconciles the prior attempt; a timeout never creates
one automatically.

After `channel.offer()` returns a live exact reservation, `grantDispatch(id, receipt)` produces
a separate signed grant binding the offer, reservation id and immutable job hash. The job allows
text messages, an exact model, context, output limit and wall deadline. It carries no tools,
images, connection credentials or reasoning. `channel.dispatch(grant)` consumes the reservation
and persists target intent in one transaction before any asynchronous validation. The old receipt
becomes `fenced` with its authorization field still false. Its permit is released; K3 must acquire
its own permit. Remote calls require explicit unattended consent on the local connection and node.

Signed `/attempts/renew` requests recheck peer trust, exact executor binding, R1 lease and job
deadline at the home. Granted TTL comes from the granting clock. Responses are protected by F1's
required authenticated transport. The holder starts its TTL at renewal **send** time and subtracts
`safetyMs`; both monotonic elapsed and wall deadlines apply. Periodic renewal and authorization
after governor admission and Ollama version preflight maintain this bound. Final scrubbing and
`onPrepared` run synchronously immediately before the model POST. Loss, revocation, suspension,
cancel and restart never renew a lost holder back into execution. Under a partition, home Stop
can take up to the outstanding holder TTL to reach the inference; a successful direct signed
`/attempts/dispatch-cancel` aborts the target request on receipt. It also accepts a different
trusted same-account `owner_device` with the `attempts` scope while the home is unreachable.
The signed request names the exact grant/home/executor and expiry; it cannot cancel a newer
attempt and carries no caller-controlled actor identity. Shared, foreign and unscoped peers
are refused. Target cancellation is reported through the durable event outbox. A complete
browser/CLI owner-command workflow remains unfinished. This path has no external tools/effects;
actual runtime/backend cancellation has not been measured with an installed model.

Actual transport start emits a signed ordered source event. Terminal events retain only public
assistant content and nullable usage counts (`ollama:/api/chat`); raw thinking is discarded.
Target events form a durable outbox. The host retries `attemptDispatch.flush(id)` after transport
failure/reconnection. Home receipts enforce sequence/hash/signature and exact duplicate replay;
a terminal receipt and R1 completion commit atomically. Stale results cannot resolve a promise
or wake its parent. Result receipts preserve usage provenance; terminal usage is recorded on
the child run's fenced attempt through R1's `complete(..., cost)`, and no monetary price is
invented for local inference. See [Costs](#costs).

`/attempts/state` reports target state, not proof that the home accepted a terminal result.
The home run and its durable receipts are authoritative for completion. A restarted target marks
accepted/running rows lost and replays no inference. Completed outbox evidence can still be flushed
while the original home fence remains valid. A host must retain the pre-upgrade backup and drain
or cancel outstanding work before disabling the feature; disabling never removes the binding
checks from R1.

Independent additive ledger **37** owns `remote_dispatch_migrations`, `run_remote_bindings`,
`remote_dispatch_home`, `remote_dispatch_holders`, `remote_dispatch_events` and
`remote_dispatch_receipts`. It leaves ledger36 and all applied/global migrations unchanged.
Construction performs no network/model work; first use initializes under the R1 home fence.
Rollback disables admission, aborts holders and retains evidence; it never drops or rewrites
migration36/37 or resumes a prior holder.

The fixture path runs the production K3/Ollama adapter against injected fake transport and signed
in-memory node channels. It proves bounded local protocol behavior only. Toolful R2 remote
sealing, detached execution, OS power assertions, restored-home epochs, fenced handover and real
multi-host/six-hour MS1 evidence remain unfinished. Current owner scope is local Mac/Colima only.

## Costs

When a terminal event reports both integer token counts, the home passes an idempotent
`remote-dispatch:<offer id>` observation to `runs.complete(..., cost)`. The terminal receipt,
cost row and child completion commit in one transaction; a replay adds no second row. Null
usage records nothing and still completes. The observation belongs to the child run's fenced
attempt, so the lead's totals are unchanged. Local inference keeps an unknown monetary cost;
no price is invented.

## Relay inference on another node (F2-d)

Protocol **1.4** and the capability `remote-relay-runtime-v1` let a **home** node run the R2 relay
(lead, workspace, tools and acceptance gates stay there) while every model call is executed and
counted by the **executor** node's operational llama-server (R2-op `LlamaServerRuntime`). Only an
executor whose host passed `dispatch.relayRuntime` advertises it. Nothing else of that runtime is
reachable; the model call itself is the existing F2-b dispatch.

- **`POST /attempts/runtime/observe` and `/count`** (home to executor, signed like every F2
  request). The body carries a `binding` (home, executor, model and, once the relay run exists,
  the run plus its R1 fence) and a fresh `challenge`. The executor answers with **signed evidence**
  (its key, over the whole entry) that echoes both. The home accepts it only if the pinned executor
  key verifies, the entry names that executor, the binding and challenge are exactly the asked ones
  and, for a count, the content hash is the asked string. A replayed, forged, re-attributed or
  re-bound answer is not evidence. Observation time is the home's send time, so clock skew never
  makes a fact look fresh or stale.
- **Pins.** The executor needs the relay run pinned (explicit F1 binding, same session, owner, home
  and epoch) before any bound request. Before the run exists only the fixed admission probe
  (`RELAY_RUNTIME_PROBE`) may be counted. The host supplies `onBind` to provision the pin; a refusal
  there rolls the whole start back. Automatic pin propagation is not built.
- **Counted jobs.** The count response carries `contentSha256`, `renderedSha256` and `tokens` and
  the runtime identity. The dispatch job (immutable, covered by the grant hash) repeats them as
  `counted`, with the served `digest` and loaded `contextTokens`. The executor re-observes,
  re-renders and re-counts, and refuses before `/completion` unless every one is identical, then
  refuses a reply whose `tokens_evaluated` differs. The terminal event echoes `renderedSha256`,
  carries `doneReason` and, for a refusal, a fixed `reason` code. A counted job needs
  `offer.parentRunId`; the executor derives the child's pin from the pinned relay run.
- **Per-call child runs.** Each model call is a fresh child run with one dispatch, so the F2-b
  fence, renewal, event receipt and cancel machinery applies unchanged. F2-c records the remote
  tokens on the child's ledger with its terminal receipt. The relay run keeps its own call
  accounting (cap enforcement), so child and relay ledgers must never be summed together.
- **Cancel.** Abort or loss of the relay fence cancels the child at the home first, then sends the
  direct signed cancel and does not settle the call until the executor acknowledges it, or the
  configured wait (at least the holder TTL) has elapsed, after which the holder has fenced itself.
- **Executor loss.** An executor that stops renewing leaves the child `interrupted` (R1 expiry); the
  call fails closed and the relay stops with its ledger retained.

No migration: the job, offer and events are JSON inside ledger-37 rows. The executor role and the
home role are independent host options. Limits and residuals are in the
[F2-d hand-off](../../../../docs/plans/lanes/F2-d.handoff.md).
