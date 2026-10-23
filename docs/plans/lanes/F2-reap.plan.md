# F2-reap — reaping stale executor relay pins

**Status:** implemented by this lane · **Lane branch:** `claude/stale-pin-reaping` · **Base:** `main` 0ab58729

## Problem

A home that crashes after the executor acknowledged `pin` leaves one `relay:<run>` stream on the executor for a run that
died with the home (8 of 15 rehearsal kill points; F2-d residual 3; MS1 rehearsal finding 2). In two of those kill points
(`create_started:before_commit`, `net:pin:acked`) the home has no relay run row at all, so a reconciliation that only
reads run state cannot even find the pin. `maxPinsPerPeer` is 16: the 17th crashed run makes the executor refuse every new
relay from that home.

## Non-goals

No change of the wire contract, of dispatch grants, of the relay run lifecycle (a relay run still never resumes inference,
R2/ADR-0020) or of production boot wiring (`index.ts` belongs to `claude/ms1-live-host`).

## Design (both halves, composed)

ADR-0018 rules kept: ownership changes only by a transaction on the granting node; a timeout never creates a second holder;
messages are signed (F1 channel) and fenced (run id + epoch).

1. **Home pin journal (new, durable).** Table `federation_relay_pin_journal(run_id, executor, model, session, epoch)` is
   written by the home in its own transaction *before* the signed `pin` leaves (so a crash between the executor's ack and
   the run row still leaves a record) and deleted when the executor acknowledges the `unpin`. This is why a journal and not
   "relay runs whose start row is running": the kill points above have no start row.
2. **Home reconciliation.** `Federation.reconcileRelayPins()` sends a signed, fenced `unpin` for every journal row that is
   not *live*. Live = registered in this process's in-memory set, which `journalRelayPin` fills in the same synchronous step
   as the insert and `retire/settle` empties. After a crash nothing is live, so every old row is reaped; a pin of a running
   relay session is never touched, and a fresh start cannot be mistaken for an old row because its run id is a fresh UUID
   journaled and registered atomically. Idempotent: the executor acknowledges an unpin of an unknown pin. Retried on a
   bounded timer (default 60 s, `dispatch.relayPinMaintenanceMs`, `0` disables) and once shortly after construction, so it
   needs no change in `index.ts`. A session whose `close()` could not reach the executor now leaves a journal row too (it
   closes F2-d's "not reaped" case for the live-process path).
3. **Fencing of unpin.** `Replicas.unbind(stream, home, epoch)`: an unpin whose epoch differs from the bound epoch is a
   no-op acknowledgement, so a late unpin of an old attempt can never remove a newer pin (a different home still gets
   `home_conflict`).
4. **Executor backstop (bounded lease).** Table `federation_relay_pin_leases(stream_id, expires_at)`, written with the pin in
   one transaction. Default TTL 10 min (`relayLimits.pinTtlMs`). Renewed by (a) every valid observe/count of the pinned run
   and (b) a heartbeat re-`pin` from the live home session (`pinRenewMs`, default 60 s, same idempotent signed message).
   Expired or lease-less `relay:` pins are deleted on the executor's own transaction: lazily before every relay request
   and pin, and by the same maintenance timer. An expired pin only removes a permission (counts refuse with
   `unknown_stream`); it grants nothing to anyone, so no second holder can appear. A live home partitioned longer than the
   TTL regains its pin with the next heartbeat (if under the cap).
5. **Migration 42**, append-only, in its own ledger `federation_relay_pin_migrations` (the existing tests pin `federation_migrations` to
   exactly `[34]`): the two tables. Existing relay pins have no lease and are
   treated as expired (they can only be leaked ones: a relay run does not survive its node).

## Rejected

Executor asking the home which runs are live: needs a new signed request type and the home to be reachable, and cannot help
when the home never returns; the lease covers exactly that case with no new message.

## Test matrix

- federation/remote-runtime unit tests: journal written before the pin; settle on release; a close that cannot reach the
  executor keeps the row and the next reconcile releases it; live pin untouched by reconcile (including while a fresh start
  is pinning); late unpin with an older epoch is a no-op; 20 crashed runs never exhaust `maxPinsPerPeer`; lease expiry
  frees the cap and refuses counts; renewal by use and by heartbeat keeps a live pin past the TTL; lease-less legacy pin
  swept; reaper retry after the executor was unreachable; unreachable executor does not block reconciliation of another.
- MS1 rehearsal: the `stalePin` tripwire flips to zero stale pins after restart plus reconciliation, while the live run's
  pin is present until it is released. The simulated clock jumps 75 min per gap, which a real-time heartbeat cannot cover,
  so the rehearsal's executor uses a long `pinTtlMs`; the lease itself is proven by the unit tests.

## Gates

`npm run typecheck`, `lint:md`, `check:licenses`; `npm run test` and `npm run build` through the shared heavy lock.
