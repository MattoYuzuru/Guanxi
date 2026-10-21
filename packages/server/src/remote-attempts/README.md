# Owned-node offer reservations (F2-a)

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
capacity nor installed-model/window fit. There is no execute method. The next F2 slice must
validate/renew the home grant at the holder, transfer admission into execution, enforce the
holder deadline, ingest fenced events/results and handle cancellation. Strict mode is the
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
