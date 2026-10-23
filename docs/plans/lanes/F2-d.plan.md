# F2-d — relay inference on another node: implementation plan

**Status:** accepted slice plan (lane author) · **Date:** 2026-10-23 · Base `0d5dc746`, branch
`codex/f2d-remote-relay-inference`, ports 5217/4417, checkout-local `.lane-data`, Node 26.
No SSH, live model, paid call, owner data, `~/.guanxi` or secret. Transport is injected; tests
use in-process loopback nodes and the R2-op fake llama-server fixture.

## Outcome and non-goals

The relay (R2) runs on the **home** node with its lead, workspace, tools and acceptance gates.
Every model call is executed by the **executor node's** llama-server through signed F2
messages, and is counted exactly by that same server. Non-goals: a real two-host run (Fedora),
TLS between hosts, toolful remote steps, a model residency lease, automatic propagation of the
pin propagation beyond the signed pin message, UI/CLI surface, B3 quality or six-hour claims.

## Design decisions

1. **Protocol (federation 1.4, capability `remote-relay-runtime-v1`).** Only the executor
   advertises it, and only when the host gave it a runtime port. Two new signed POSTs,
   `/attempts/runtime/observe` and `/attempts/runtime/count`; the model call itself is the
   existing F2-b dispatch (offer, reservation, signed grant, renewals, fenced events, cancel).
   Every request carries a `binding` (home, executor, model, optional relay run + R1 fence) and a
   fresh `challenge`. Every response is signed by the executor key and echoes both; the home
   verifies signature, executor id, binding and challenge, so evidence cannot be replayed or
   attributed to another node. Observation time is the **home send time** (skew-free), not the
   executor's clock.
2. **Counter: asynchronous pre-count plus a synchronous exact-count cache, not a worker bridge.**
   R2-op's `Atomics.wait` bridge cannot be reused over F2: the signing key, nonce store and
   transport live on the main thread, a loopback-local F2 client would need its own thread or
   process, and blocking the home event loop for a network round trip would also stop the
   lease renewals and federation traffic that keep the fence alive. Instead the meter gets an
   optional `countAsync`; `budget.request` becomes one generator driven synchronously (local meters,
   behaviour byte-identical) or asynchronously (remote). The synchronous `count` that K3
   `onPrepared` needs is a lookup of **exact answers already obtained** for the identical string;
   a miss refuses (`runtime_count_invalid`). Nothing estimates, falls back to bytes or to a
   local runtime.
3. **Byte identity.** The executor renders and tokenizes the message; the count response carries
   `contentSha256`, `renderedSha256` and `tokens`. The dispatch job (immutable, covered by the
   grant hash) carries the same triple as `counted`. The executor re-renders and re-counts before
   `/completion` and refuses on any difference; the terminal event echoes `renderedSha256`
   and `tokens_evaluated`; the home refuses a mismatch. The raw rendered prompt never has to
   cross the wire, so the executor keeps template authority.
4. **Dispatch reuse.** Each model call is a fresh child run (`runs.create`) with one F2-b
   dispatch. The child's pin on the executor is **derived** from the pinned relay run through
   `offer.parent {runId, epoch}` (same session, owner, home; the epoch is a consistency check, since R1 leases are always
   epoch 1, so the protection is the home's database fence plus the F2-b renewal chain); a counted job without a parent is
   refused. The relay run is pinned on the executor by an awaited, signed pin message sent before the run is created. Remote tokens land on the child's R1 cost ledger atomically with its terminal receipt
   (F2-c). The relay run still records its own call usage as R2 always did (its cap accounting);
   the lead's totals are untouched. Children and the relay run are different ledgers; sums across
   them would double count and no aggregation view exists yet.
5. **Fence and the synchronous stretch.** `FederationChannel.dispatch(grant, {beforeSend})`
   negotiates first, then signs, runs `beforeSend` (K3 `prepare` again + R1-fenced `onStarted`)
   and issues the request in one synchronous stretch (microtask probe in tests). While a call is
   pending the transport heartbeats `onStarted` (fenced) so a lost relay fence aborts the call.
6. **Cancel.** Abort or fence loss cancels the child run at home first, then sends the direct
   signed cancel and does not return until the executor ACKs (`canceled`, `lost`, `completed`,
   `failed`) or the holder TTL has elapsed, after which the executor has self-fenced. Only then
   does the call settle, so a next offer never overlaps a running inference.
7. **Governor.** K3 `localChat` gains `LocalChatTransport.remote`: no loopback requirement and
   no home permit (the executor's own governor admits the call through the reservation).
8. **Executor loss.** Child lease expiry (`runs.tick`) makes the child `interrupted`; the call
   fails closed and the relay stops with the ledger retained, never `completed`.

## Components

Contract: minor 4, capability, binding/evidence/count schemas, `counted` job field,
`parent` offer field, pin message, terminal `renderedSha256`/`reason` and the llama source label.
Executor: `LlamaServerRuntime.measure/expectedTransport`, `remote-attempts/relay-runtime.ts`
(port + signed evidence), `Federation.receiveRelayObserve/Count`, routes, `dispatch.work` counted
path. Home: `FederationChannel.relayObserve/relayCount`, `AttemptDispatch.awaitTerminal`,
`relay/remote-runtime.ts` (`RemoteRelayRuntime` session: observer, counter, transport),
`RelayRuntimeSource` session hook, `RuntimeMeter.countAsync`, executor async pack, K3 seam,
`RelayStarts.bind/release`. No migration: the job, offer and event JSON are inside existing
ledger-37 rows. No dependency or third-party code.

## Fail-closed matrix (each has a failing-when-violated test)

Unreachable executor, old minor, missing capability: `runtime_meter_unavailable`. Bad signature,
other node's key, wrong binding or replayed challenge: `runtime_identity_unknown`. Observation
older than `maximumAgeMs`: `runtime_observation_stale`. Changed digest/version/window:
`runtime_identity_changed`. Cache miss or count mismatch: `runtime_count_invalid` /
`runtime_counter_mismatch`. Executor-side hash or token mismatch: terminal `failed` with a fixed
reason and zero `/completion`. Grant expiry or lost fence: no POST, holder `lost`. Executor
vanishing: child `interrupted`, relay not completed.

## Tests (no network beyond in-process loopback)

Two `SimNode`s, signed channels routed in memory, the fake llama-server behind the executor.
Cases: full relay cycle through `RelayStarts` with exact counts and zero home inference;
mismatch; stale observation; grant expiry and fence loss mid-call; executor disappearing; cancel
ACK ordering; child versus relay versus lead cost ledgers; hard ceiling over every `/completion`;
forged and replayed evidence; sync/async packing equivalence; one-stretch probe.

## Checks and rollback

Targeted `node --test`, `typecheck`, `lint:md`, `check:licenses`, then through `agent-dev`
(heavy, one per call) `npm run test` and `npm run build`. A separate read-only reviewer inspects
the exact diff; fixes land in separate commits. Rollback: remove the `relayRuntime` host option;
the capability disappears and all home paths refuse. Ledgers 36/37 are untouched.
