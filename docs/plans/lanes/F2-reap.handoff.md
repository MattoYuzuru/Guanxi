# F2-reap hand-off — reaping stale executor relay pins

**Lane:** F2-reap · **Branch:** `claude/stale-pin-reaping` (from `main` 0ab58729) · **Status:** implemented, locally validated · not pushed.
Plan: [F2-reap.plan.md](F2-reap.plan.md). Closes F2-d residual 3 and MS1-rehearsal finding 2 (a stale pin per home crash).

## Built

- **Home journal** `federation_relay_pin_journal` (migration 42, own ledger `federation_relay_pin_migrations`; `federation_migrations`
  stays `[34]`). `RemoteRelaySession.prepareBind` writes the row before the signed pin leaves; an acknowledged unpin deletes it; a close
  that cannot reach the executor retires the live registration but leaves the row.
- **Reconciliation** `Federation.reconcileRelayPins()`: signed, fenced `unpin` for every row not live in this process; single-flight,
  5 s per request, an unreachable executor is tried once per pass. Runs shortly after Federation construction and every
  `dispatch.relayPinMaintenanceMs` (60 s, `0` off), so `index.ts` needs no change.
- **Fenced unpin:** `Replicas.unbind(stream, home, epoch)`: a pin bound at another epoch is acknowledged and kept.
- **Executor lease** `federation_relay_pin_leases`: `relayLimits.pinTtlMs` (10 min). Renewed by valid observe/count and by the session's
  heartbeat (`pinRenewMs`, 60 s). Lapsed or lease-less `relay:` pins are deleted on the executor's own transaction (lazily before
  every relay request and by the maintenance timer); the heartbeat unpin ordering is enforced (an in-flight beat lands before the unpin).
- Shared edits: `test/ms1/world.ts` (executor `pinTtlMs` 7 days, because the simulated clock jumps 75 min per gap), `test/ms1/home-process.ts`
  (`relayPinMaintenanceMs: 500`, `pinRenewMs` 1 h), `test/relay/remote-fixture.ts` (options), the pin lines of `rehearsal.test.ts`.

## What each test proves (`test/relay/pin-reaping.test.ts`, 11 new; plus the flipped rehearsal tripwire)

1. Control: 16 unreaped crashes make the 17th pin refused. With reconciliation, 20 consecutive crash/restart cycles each end with zero pins,
   an empty journal and one `unpin` per `pin`.
2. A restarted home reaps by itself (maintenance timer), no host wiring.
3. Live and overlapping fresh runs are kept (`{released:1, kept:2}`), the live pin still answers observe; after retire it is released.
4. Epoch-fenced unpin (late unpin removes nothing; other home refused; right epoch removes; unknown pin still acknowledged).
5. Unreachable executor keeps the row; the next pass releases it.
6. Lease: cap holds while leased, renewed by use, expired pin serves nothing (`unknown_stream`), cap is freed, heartbeat re-pin renews.
7. Lease-less relay pin swept; ordinary pins untouched.
8. Journal row exists at the instant the first pin message is issued; settled on release; a failed release leaves the row, reconciliation
   releases it (session level).
9. Heartbeat keeps an idle run past the TTL (4 x 900 ms against a 1000 ms TTL); no heartbeat does not.
10. Migration: a pre-F2-reap database upgrades, reopening is idempotent, `federation_migrations` is `[34]`.
11. An in-flight heartbeat cannot re-create the pin after the unpin (fails without the ordering fix).

Rehearsal (`test/ms1/rehearsal.test.ts`): 15 kill points, 8 of them leave exactly one pin at the kill (asserted), and after restart every one
ends with zero executor pins, empty journal, no orphan lease; the re-started live run completes, which it could not if its pin had been
confused with the stale one. Mutation checks done by hand: removing the live check, the epoch fence, the journal write or the lease renewal
each turns a named test red.

New / envelope: 11 new unit tests + 1 flipped rehearsal assertion block / `npm run test` full server+cli+web suite.

## Gates (head `a231b36c`, clean tree)

| Gate | Result | Receipt |
| --- | --- | --- |
| `npm run typecheck` | pass | direct run (not locked) |
| `npm run lint:md`, `npm run check:licenses` | pass (0 problems; 675 packages) | direct run |
| `npm run test` (heavy lock) | pass, 0 fail, 0 skipped | `check-bdg7t57t` |
| `npm run build` (heavy lock) | pass | `check-oj_x_20q` |
| rehearsal alone (20 tests, Colima present) | pass | `check-c19qzatu` (earlier head, dirty tree) |

An earlier full run (`check-ax2w20iy`) failed one test, `remote-dispatch.test.ts` "fresh remote binding": it JSON-stringifies the Federation
object and my timer handles were an enumerable field; fixed by a `#private` field, then the full run above is green.

## Independent review

A read-only reviewer (implementation-reviewer) found no blockers; its four findings: missing migration test (added), heartbeat/unpin
reorder (fixed + test), weak overlap assertion (now exact), no give-up for permanently refusing executors (residual below).

## Residual risk

- The home cannot see the executor's TTL; `pinRenewMs` must stay well under `pinTtlMs`. An executor clock jump or suspend longer than the
  TTL lapses a live run's pin (next call `runtime_identity_unknown`; the next heartbeat re-pins if the cap allows).
- A journal row for an executor that refuses permanently (other model, no relay runtime, untrusted) is retried every pass forever;
  its pin is still freed by the executor's lease. No age cap or operator surface yet.
- Lease expiry is proven with a driven clock, not in the rehearsal (simulated hours vs real-time heartbeat); real two-host behavior is untested.
- Migration number 42 is claimed in a private ledger; if another lane takes 42 for the main DB the ledgers do not collide, but note it.
- `index.ts` is untouched: the home reaping starts from the Federation constructor whenever `dispatch` is configured. A host that builds
  Federation without `dispatch` has no relay pins anyway.
