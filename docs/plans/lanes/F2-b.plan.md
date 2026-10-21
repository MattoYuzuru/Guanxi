# F2-b — renewable local inference dispatch

**Status:** accepted bounded implementation contract · **Updated:** 2026-10-22

Root accepted this slice before source edits. Work is local Mac only. No installed model,
paid provider, external host, user database or deployment is used.

## Behavior

A fresh home attempt is atomically bound to one executor before exposing its token. Local
executor methods reject that binding. A distinct signed grant consumes an exact live F2-a
reservation once; the reservation receipt always remains `dispatchAuthorized: false`.
Home renewal checks the immutable job, executor, run lease and deadline in a transaction.
The holder uses renewal-send time plus granted TTL, with a wall-clock suspension guard;
loss is one-way. Cancellation, expiry, revocation, process restart and a delayed response
cannot resurrect it. A timeout never allocates a replacement holder.

Only explicit text-only local inference is admitted. A host-owned installed-local-model
attestation and local-runtime connection mapping are required; cloud and unknown placement
are refused. Actual execution uses K3 after releasing the reservation and reacquiring its
governor. Authorization runs after queue admission and all adapter preflight, before final
scrubbing and `onPrepared`; no asynchronous work follows `onPrepared` before transport.
Source-start and terminal results have durable ordered receipts/outbox; terminal receipt and
R1 completion share a transaction. Raw reasoning is never exported.

## Shared seams and migration

Own `remote-attempts/` plus F1 signed routes/channel/contract. Minimal R1 additions provide
fresh remote binding, scoped trusted executor operations and atomic result receipt callbacks.
K3/Ollama adds trusted async authorization after preflight, preserving existing dispatch,
response, quota, cancellation and retry semantics. Independent additive ledger **37** owns
new dispatch tables. Ledger36 and global migrations are unchanged; rollback disables new
admission and reconciles outstanding holders as lost, never resumes them. No destructive
backfill or migration down is provided.

## Acceptance and verification

Local two-node fixtures assert signed grants/renewal, executor and immutable-job mismatch,
reservation consumption, local-method refusal, actual K3 fake-Ollama POST/result, durable
replay, zero dispatch on revoked/expired grant across awaits, cancel/abort, partition and
suspension, restart loss, and stale completion never waking a parent. Existing offer/F1,
R1, K3 and Ollama tests guard shared seams; server/contract typecheck and Markdown checks.
Independent GPT review is required on a pinned commit after author checks. Root owns heavy
integration gates and central status. Fixtures establish bounded protocol behavior only.

Toolful R2 remote sealing, detached execution, restore/handover, OS power assertions and
real multi-host/MS1 evidence remain unfinished. Existing code is reused; no third-party code
is copied and no dependencies change.
