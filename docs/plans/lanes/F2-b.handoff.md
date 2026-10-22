# F2-b — renewable local inference dispatch handoff

**Status:** implemented bounded internal path; independently reviewed and locally fixture-validated
**Updated:** 2026-10-22

## Pins and ownership

- Branch/worktree: `codex/ms1-f2b`, `/Users/yuzuru/Projects/Guanxi-lanes/ms1-f2b`.
- Reviewed production: `46892a9`; separate review fixes `32fc470`, `6f4b2f9`; owner-device
  cancellation follow-up `53e5d66`. Final reviewed/tested source pin: **`6f4b2f9`**.
- Base: `5c66e27` (F2-a), merged main `5e9bbfe` as `c8d1094`. Before handoff, current main
  `afb240d` merged as `83f4fab`; its six-file delta is documentation only, no executable change.
  Assertion-only `cc38f07` then adds explicit stale/future model-attestation refusals in an
  existing case; all30 direct tests pass again, with production unchanged.
- Reserved lane ports: 5201/4401; `.lane-data`; tests use isolated temporary/in-memory stores
  and injected transports. No live listener/model, paid inference, owner data or remote host.
- Root owns integration, full main gates, central status, push and the exact MS1 envelope.

## Observable behavior

A fresh home attempt, executor binding, immutable text job and offer intent commit together.
Local R1 executor methods reject its token. A separate signed grant references the exact live
reservation; consumption and target intent commit together. Every F2-a receipt still has
`dispatchAuthorized: false`; consuming it changes its status to `fenced`. K3 then reacquires
its own governor permit rather than bypassing admission.

Signed renewals validate current owner-device trust, account/scope, executor, immutable job,
R1 fence and deadline. Holder TTL starts at renewal send time, less the explicit safety
margin, with both monotonic and wall deadlines. No delayed renewal or timeout resurrects a
lost holder or allocates another attempt. Expiry alone never creates a new holder.

K3 authorization follows governor admission and adapter version preflight, before final
scrubbing/`onPrepared`. There is no await after preparation before model transport. Remote
local inference requires a fresh host-owned installed-local-model attestation and explicit
node/connection unattended consent. Cloud/unknown/stale placement is refused.

Signed ordered source-start/result events enter a durable target outbox. Home receipts
validate signature/hash/sequence and exact replay; terminal receipt and R1 terminal state,
promise resolution and wake commit atomically. Stale results wake nobody. Thinking is
excluded; nullable usage has runtime provenance. Target completion does not mean the home
accepted its result; home state/receipts remain authoritative.

An exact, expiring signed cancel can come from the home or a different trusted same-account
`owner_device` with `attempts` scope. Shared/foreign/unscoped/forged/expired requests fail
closed. An old grant's cancel cannot affect a newer attempt of the same run. A target cancel
aborts its request and retains the report for home reconnection. Under partition, home Stop
can wait up to the outstanding holder TTL. Actual backend cancellation has no live-model
observation in this slice.

## Verification — new / regression envelope

**New:** 30 cases in `packages/server/test/remote-dispatch.test.ts`, all passing, zero skips.
They cover real K3/Ollama production code using fake version/chat transport, exact grants,
renewal, consent/placement, forgery, late response, partition, suspension, process restart,
rollback, duplicate results, stale wake refusal, canceled pending renewal cleanup, complete
admission-to-work settlement and old-cancel/new-attempt separation.

**Regression envelope:** 151 existing cases across offers17, R1 durable runs, K3 model access,
Ollama client and nine F1 files. Full selected command at clean `6f4b2f9` passed **181/181**,
zero skips, through shared `heavy`: receipt `check-2cs8j_oz` (25 seconds).

```bash
node --test packages/server/test/remote-dispatch.test.ts \
  packages/server/test/remote-attempts.test.ts packages/server/test/durable-runs.test.ts \
  packages/server/test/connections/model-access.test.ts packages/server/test/ollama-client.test.ts \
  packages/server/test/federation/*.test.ts
npx tsc --noEmit -p packages/server/tsconfig.json
npx tsc --noEmit -p packages/contract/tsconfig.json
npm run lint:md
npm run check:licenses
```

Both typechecks pass at `6f4b2f9`; Markdown passes (170 files/624 links before this handoff),
licenses pass (661 packages, zero disallowed). Final handoff Markdown check passes
(171 files/624 links). Prior clean `46892a9` envelope173/173 is
`check-hhewd39n`; it is superseded for fixes by the final181 result. Node26.9.0, own `npm ci`
and worktree-local `@guanxi/contract` resolution verified. The inherited external skill symlink
makes agent-dev whole-source attestation unverifiable; these are observed checks with unchanged
source before/after, not reusable certificates. No new third-party code or dependency.

## Independent verification and fixes

GPT6.1 Sol/high reviewer `/root/session_bench_audit` reviewed the exact production diff and
separate fixes. Report outside checkout:
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-f2b-dispatch-20261022.md`.

- Confirmed P2: blocked renewal could keep K3's permit after cancellation while a fresh
  `settled()` returned. Fixed `32fc470` with abort-raced waits and independent task tracking;
  `6f4b2f9` follows admission into work for observers captured before admission succeeds.
- New R1 callback seams reject thenables transactionally, observe late callback rejection and
  use the `Synchronous` type; external work scheduled by an invalid callback cannot be undone.
- Known home-only cancel gap resolved separately in `53e5d66`, with exact owner-device rules.
- Final independent 30/30 pass: `check-tv93c06m`. Original external reproduction now proves
  canceled, both settlement observers complete, zero POSTs and governor released **before**
  renewal gate release: `check-xq_owriu`. No remaining bounded blocker.

## Shared edits, migration and rollback

Own module: `remote-attempts/dispatch.ts`; minimal shared seams in contract/F1 routes/channel,
R1 fresh binding/scoped actor/transactional callbacks, K3 local authorization and Ollama
post-preflight preparation. Existing response hooks/quota/retry behavior is preserved. When
merging B1, retain its `singleAttempt`/wire guard and existing K4 response/cancel hooks.

Independent additive ledger **37** creates dispatch home/holder/event/receipt/binding tables;
ledger36 and global migration32 remain unchanged. Global33 is separately reserved for K4 input.
DDL failure, intent/consumption/terminal rollback and restart loss have explicit assertions.
Construction starts nothing. First use requires the current R1 home generation; inherited
attempts are never resumed. Rollback disables admission, aborts holders and retains metadata;
never drop applied migrations. Back up stopped SQLite/WAL before enabling on retained data.

## Next unfinished scope

This is text-only inference, not the full F2 stage or MS1. Toolful R2 remote step/seal connector,
R1 cost-ledger aggregation, complete browser/CLI owner commands, model residency/capacity,
detached execution, OS power assertions, restored-home epochs/fenced handover, real adapters
and remote-host evidence remain unfinished. No six-hour run or ETA/precision/recall gate is
claimed. Current owner authorization remains local Mac/Colima only; no SSH or other hosts.
