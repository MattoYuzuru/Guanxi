# B1 trial binding handoff

**Status:** implementation and author-focused checks complete; independent root/GPT review and
full integration gates pending. **Date:** 2026-10-22. **Branch:** `codex/b1-trial-binding`.
**Base:** `6da2058` (`docs: record reviewed B1 merge and next integration checks`).
**Implementation pin:** `28a1369` (acceptance-test hardening) and `5a211ca` (cleanup); the
docs/handoff commit follows them. The final clean branch HEAD is reported by the worker after
the last commit. The P2 review-fix continuation is appended at the end of this file; its
code commits are `65d96c1` (process ownership) and `ef51113` (K2 receipts).

This bounded slice implements the corrected private trial binding from
[B1-trial-binding.plan.md](B1-trial-binding.plan.md). Historical claims in
[B1-private-stream.handoff.md](B1-private-stream.handoff.md) and the B1 completion evidence
remain attached to their original pins; this file is the review-fix continuation, not a rewrite.

## Outcome

- Real fenced K2 retention through `RunStore.append`/`SessionLog`, with attempt/run/session
  checks, explicit bounds, idempotent per-event appends, the versioned reasoning signature
  envelope, and no task response until every append acknowledges.
- `retainAndProject` returns the public projection derived from the stored scrubbed assistant/
  tool events; the private channel writes exactly that projection. The old pure `retain` fixture
  host API remains supported, but the new production host requires the authoritative port.
- K3 gateway accepts an optional `k3RunId` (old fixtures default to `trial.runId`) and an
  optional `attemptFence`; the new `createBoundTrialHost` requires both the actual R1 run id and
  the separate experiment ledger id, and uses `runs.renew(attempt)` as the trusted synchronous
  fence.
- One owned supervised local process group, reached only through anonymous inherited fds 3/4.
  The supervisor/launcher are trusted source-run `.mjs` assets; a missing asset fails closed.
- The supervisor never unlinks its record. Parent/reaper remove it only after exact identity
  validation, signalling, and actual process-group ESRCH. Forced supervisor death leaves the
  record for the reaper; an identity mismatch preserves quarantine.
- No acknowledgement timeout. Abort/EOF starts group shutdown immediately, but the owning
  promise and active binding remain owned until the real gateway and retention settle. Late
  fulfil/reject are consumed with zero unhandled rejections.
- Public response keys are explicit; no reasoning/signature/usage/account/model/trial/provider
  reference is sent to the child. The nonce is host correlation, not authentication.

No server/contract/UI/migration/dependency change. Stock B1 paid execution remains OFF; actual
budget holds, single-attempt dispatch and T0 account binding are unchanged. D-194 still excludes
real benchmark execution on this Mac. No live model, paid call, Harbor, Podman, container, SSH,
remote service, GPU, public corpus or real task was used.

## Commits

| Commit | Scope |
| --- | --- |
| `78b5fa3` | plan review corrections recorded before code |
| `e294a9b` | K2 sink, gateway fence/run identity, binding, authoritative projection and tests |
| `b61c7f8` | owned process/supervisor/launcher, fd transport, record/reaper, ACK lifecycle and tests |
| `28a1369` | scrub-before-append, post-append bound and exact reaper identity tests |
| `5a211ca` | remove unused process module surface |
| docs/handoff | this handoff, plan status, `PRIVATE_PROCESS.md` and README/contract updates |

## Tests and exact commands

New tests added by the slice:

- `packages/bench/test/k2-retention.test.ts` — 11 cases: real fenced retention and exact event
  payloads; remote/export reasoning+signature omission; scrubbed projection equality and newly
  registered value; idempotent retry/conflict/partial trace; readiness/oversize/unsupported/
  invalid-ID refusal; stale/foreign/session mismatch; concurrent ordering; channel frame equals
  K2 projection; readiness withdrawal no success; scrub-before-append; post-append bound.
- `packages/bench/test/private-process.test.ts` — 10 cases: two sequential OS requests and full
  public keys; fd/argv/env/frame isolation; abort with blocked retention and late fulfil/reject;
  forced supervisor death and reaper ESRCH ordering; nested group cleanup; detached descendant
  outside the proof with explicit PID cleanup; bad client startup; malformed/selector input;
  same-binding busy; exact-identity reaper refusal; symlinked/permissive/env policy refusal.
- `packages/bench/test/trial-host.test.ts` — 1 production-host composition case.
- `packages/bench/test/trial-binding.test.ts` — 1 immutable binding/nonce/attempt case.
- `packages/bench/test/private-channel.test.ts` — 2 new cases (authoritative projection and
  failed projection), 10 existing cases retained.
- `packages/bench/test/private-stream.test.ts` — 1 new `onTerminal` case, 10 existing retained.
- `packages/bench/test/k3-gateway.test.ts` — 2 new fence/run-id cases, 7 existing retained.

**28 new / 49 bench regression-envelope cases + 38 server K2/R1 envelope cases**, run in full.
The numbers are separate scopes, not a single headline.

Exact worker commands (all from this clone, `nice -n 10`):

```bash
export GUANXI_WEB_PORT=5212 GUANXI_API_PORT=4412 GUANXI_DATA_DIR="$PWD/.lane-data"
node -e "console.log(require.resolve('@guanxi/contract'))"
# /Users/yuzuru/Projects/Guanxi-lanes/b1-trial-binding/packages/contract/src/index.ts

node --test packages/bench/test/k2-retention.test.ts \
  packages/bench/test/private-process.test.ts \
  packages/bench/test/trial-host.test.ts \
  packages/bench/test/trial-binding.test.ts \
  packages/bench/test/private-channel.test.ts \
  packages/bench/test/private-stream.test.ts \
  packages/bench/test/k3-gateway.test.ts \
  packages/bench/test/request-admission.test.ts \
  packages/bench/test/budget.test.ts \
  packages/bench/test/plugin.test.ts \
  packages/bench/test/k3-admission.test.ts
# 77/77 pass, 0 fail, 0 skipped

node --test packages/server/test/session-log.test.ts \
  packages/server/test/durable-run-followup.test.ts \
  packages/server/test/session-log-readiness.test.ts
# 38/38 pass, 0 fail, 0 skipped

npx tsc --noEmit -p packages/bench/tsconfig.json
# exit 0
npx tsc --noEmit -p packages/server/tsconfig.json
# exit 0
```

No `npm test`, browser, build, Storybook, mutation tool, `agent-dev`, nested sandbox/container,
SSH, Fedora, live model or paid request was run by this worker. The shared heavy lock was not
taken. Root owns full integration gates.

## Guard-mutation evidence

A pre-code red run against the base tree would fail only on missing modules/imports, which root
correction 4 explicitly rejects as behavioural proof; no such red-only result is claimed.
Acceptance rests on the observable assertions below and the temporary no-guard mutations.

Temporary no-guard edits were applied to committed source, the named test was run, and the file
was restored with `git checkout --`; no mutation was committed. Each run failed with an
assertion:

- removed first pre-dispatch attempt fence → `gateway-first-fence` failed;
- removed sink scrub → `sink-scrub` failed (scrub-before-append spy);
- bypassed sink `verify()` → `sink-attempt-session-binding` failed;
- constant idempotency key → `sink-idempotency-key` failed;
- removed pre/post assistant-text bound → both `sink-text-bound-pre` and
  `sink-text-bound-post` failed;
- forced the old `retain` path / forwarded the host object as public frames →
  `channel-authoritative-projection` and `channel-public-keys` failed;
- removed the `onTerminal` call → `stream-terminal-hook` failed;
- stopped closing inherited fds in the launcher → `client-fd-close` failed;
- replaced exact supervisor token equality with a substring check → `reaper-exact-token` failed;
- made `groupGone` always false → `reaper-esrch-before-record-removal` failed.

The active-binding map is asserted directly by the `binding_busy` case; budget in-flight/refusal
and request-admission guards remain covered by the existing mutation cases and regression
envelope. No mutation tool was run.

## Residuals and non-claims

- Same-UID process records and signals are best-effort fixture foundation, not isolation. The
  child can signal/read same-UID processes and can tamper with a same-UID record. Rootless
  Podman/Linux cgroups are the separate untrusted-compute boundary and are not implemented.
- A descendant that calls `setsid` leaves the process group. The detached-descendant test
  deliberately leaves it alive after group cleanup, then kills its explicitly owned PID; no
  test/doc claims full-descendant cleanup.
- The worker sandbox blocked `/bin/ps` execution (`spawn EPERM`). The production reaper defaults
  to `/bin/ps`; its exact-token logic is exercised through the explicit `observe` test seam. A
  real `/bin/ps` end-to-end reaper run is a residual for root's unsandboxed review.
- The supervisor and launcher are source-run `.mjs` assets. A future bundle/distribution must
  include both; a missing asset fails closed with no direct-spawn fallback.
- The acknowledgement is intentionally unbounded. If K2 never answers, the owning run promise
  stays pending and the active binding remains owned. No timer releases the map, R1 permit,
  budget hold or trial ownership. There is no automatic redispatch/retry.
- K2 appends are per-event, not one atomic batch. An idempotent partial private trace can remain
  after a mid-completion failure, but no task response is emitted until all appends acknowledge.
- `retentionConfirmed` requires at least one acknowledged retention and no recorded failure. A
  run with no completion returns false; it is not a claim about a model.
- No real provider meter/price adapter, task image, corpus, Harbor/mini-swe execution, container
  isolation, live model, paid dispatch, five-seed experiment or B1 quality result is included.
- The private channel/stream independent review for the earlier slice is still recorded as
  pending in its historical handoff; this handoff does not overwrite that status.

## Review-fix section (append-only)

Root reviewed the 607-line plan at `3bfb54c` and authorized the corrected slice after five
binding corrections: (1) remove the ACK-timeout early return and keep the owning promise pending
until real gateway+K2 ACK; (2) supervisor never removes the record, parent/reaper remove only
after exact identity and ESRCH, with quarantine on uncertainty; (3) correct fd 3/4 direction and
public-only frames; (4) red-first missing-module failure is not behavioral proof, so add
meaningful assertions and guard mutations; (5) derive the task frame from the same final scrubbed
public projection K2 acknowledges. These corrections and the resolved design choices are in
[B1-trial-binding.plan.md §12](B1-trial-binding.plan.md). The corrections commit is `78b5fa3`;
implementation is `e294a9b`, `b61c7f8`, `28a1369` and the docs/handoff commit. Historical claims
were not changed.

## Next step

Root/GPT independent review of this bounded diff, then the full integrator gates
(`typecheck`, `npm test`, browser, build, `lint:md`, `check:licenses`) through the shared heavy
lock. Root folds this handoff into `PHASE_STATUS`/`NEXT_AGENT_PROMPT`; this worker did not edit
those files and did not push, merge, rebase, tag or publish.

## P2 review-fix section (2026-10-22, append-only)

Root reviewed the plan at `1bbd034` and authorized code after the separate correction commit
`40fab84` (plan §14.10). The three reproduced P2s from
`reviews/codex-b1-trial-binding-20261022.md` are fixed in two coherent code commits:

| Commit | Scope |
| --- | --- |
| `40fab84` | plan-correction commit recording the binding root corrections before code |
| `65d96c1` | reaper: fresh v2 cleanup generation, live-mismatch/quarantine, zombie/unknown handling, v1 compatibility |
| `ef51113` | K2: two-phase fenced receipts, correlation span, ordered manifest/public digest, stored stop reason, empty/fenced/legacy reconciliation |

### Process ownership result

- The supervisor generates a fresh 256-bit `clientToken`, writes only `clientTokenHash` in a
  version-2 `0600` record before `ready`, and passes the token as the launcher/client's fourth
  argv element. The record contains no binding/account/model/provider/trial/nonce value beyond
  the existing binding/nonce hashes, and never the token.
- A live mismatched supervisor returns `cleanup_unconfirmed` immediately and never inspects or
  signals the client. Unknown process state quarantines. A zombie or absent supervisor may fall
  through only to an exact four-token client argv plus recorded `pgid` and matching token hash.
- A v1 record uses only the exact-supervisor path or an already-`ESRCH` group unlink; it has no
  client fallback. `pgid === supervisorPid` is validated. Group-gone unlink still follows
  validated record identity and an actual `ESRCH`; a merely issued signal never unlinks.
- The fd 3/4 layout, launcher close of 5/6, private frames and public key set are unchanged.
  The token grants no capability and is not used for host correlation.

### K2 receipt result

- Every valid completion, including `content: []`, appends a bounded `reasoning`-class begin
  receipt under the live R1 fence, the ordered content, and a done receipt. The done ACK settles
  before the channel frame. A canceled/deposed attempt rejects `retention_fenced` on the begin
  append with no receipt/content row.
- New receipts/content use
  `span = sha256("guanxi.bench.completion-span/v1\n" + binding.nonce + "\n" + requestId)`.
  Receipts store bounded binding/request hashes; reconciliation filters on the span, not the raw
  request id. Deterministic content keys and public message ids are preserved.
- The ordered manifest, `manifestSha256`, `publicSha256`, and scrubbed `stopReason` are stored in
  the begin receipt. The done receipt binds `beginSeq`, ordered `contentSeqs`, `specCount`,
  manifest and public digest. The returned projection and stop reason come from acknowledged
  stored rows, not fresh incoming fields.
- A partial begin/content prefix is reconciled by a recreated sink; a done receipt makes retries
  idempotent. Changed stop reason/text/tool argument, removed/added/reordered tools or private
  reasoning/signature, extra/gapped/reordered content, damaged done evidence and purged receipts
  fail closed. A pre-fix no-receipt trace fails closed and preserves rows.
- Legacy raw-span refusal uses the existing fenced `runs.append` idempotency lookup with
  `expectedSeq` at the current head: a probe that finds this binding's own key refuses without
  writing; a genuinely new binding is not rejected by another binding's raw-span rows.
- Receipts are bounded by the existing reasoning/retained limits before their first append, and
  stored receipt text is re-bounded before parsing. No new wire/schema/migration/dependency,
  `turn.done`, or in-memory-only identity was added.

### Tests and exact commands

New tests in this P2 slice: **18** (`private-process`: 6; `k2-retention`: 12). Bench regression
envelope: **95** cases across the eleven scoped files, of which 77 are inherited/earlier-slice
cases. Server K2/R1 envelope: **38** cases. Total: **133** executed cases (18 new / 115
regression-envelope), not one inflated headline.

```bash
export GUANXI_WEB_PORT=5212 GUANXI_API_PORT=4412 GUANXI_DATA_DIR="$PWD/.lane-data"
node -e "console.log(require.resolve('@guanxi/contract'))"
# /Users/yuzuru/Projects/Guanxi-lanes/b1-trial-binding/packages/contract/src/index.ts

nice -n 10 node --test packages/bench/test/k2-retention.test.ts \
  packages/bench/test/private-process.test.ts packages/bench/test/trial-host.test.ts \
  packages/bench/test/trial-binding.test.ts packages/bench/test/private-channel.test.ts \
  packages/bench/test/private-stream.test.ts packages/bench/test/k3-gateway.test.ts \
  packages/bench/test/request-admission.test.ts packages/bench/test/budget.test.ts \
  packages/bench/test/plugin.test.ts packages/bench/test/k3-admission.test.ts
# 95/95 pass, 0 fail, 0 skipped

nice -n 10 node --test packages/server/test/session-log.test.ts \
  packages/server/test/durable-run-followup.test.ts packages/server/test/session-log-readiness.test.ts
# 38/38 pass, 0 fail, 0 skipped

nice -n 10 npx tsc --noEmit -p packages/bench/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
# both exit 0
```

### Red-first and guard-mutation evidence

Before the production fixes, the new assertions failed on the reviewed tree, not because of a
missing module:

- different-binding reused-PID model / live mismatched supervisor: `removed` instead of
  `cleanup_unconfirmed` (the reaper fell through to the shared client argv);
- empty valid completion: 0 receipts instead of begin+done;
- canceled empty completion: resolved successfully instead of rejecting `retention_fenced`;
- changed `stopReason`: resolved instead of `retention_idempotency_conflict`.

Temporary no-guard mutations were applied to the committed source, the named test was run, and
the file was restored byte-for-byte (`cmp`); no mutation was committed:

- removed the live-mismatch early return -> the v2 live-mismatch test failed with `removed` vs
  `cleanup_unconfirmed`;
- removed the client token-hash equality -> the wrong-token test failed with `removed` vs
  `cleanup_unconfirmed`;
- disabled the legacy raw-span probe -> the legacy refusal test observed extra rows (9 vs 6);
- skipped the done receipt and its final check -> the empty-valid test saw 1 receipt instead of 2;
- disabled the stored-public/stored-content digest checks -> the late-scrub test unexpectedly
  resolved (missing expected rejection).

A begin-receipt-skip mutation produced a runtime `TypeError` rather than an assertion; it is not
claimed as mutation evidence. The pre-code empty-valid red run is the begin-ACK behavioural
evidence.

### Residuals and non-claims

- This DSH sandbox still cannot execute `/bin/ps`; the process tests use the explicit observation
  seam with injected real owned PIDs/groups and explicit `ESRCH` waits. Seam results are **not**
  real process-table proof. Independent GPT/root must run the unsandboxed external process probe
  against the actual `ps` state/argv path.
- The external parent-death probe was not rerun by this worker. The supervisor still never
  unlinks its record, and parent/reaper removal ordering is unchanged; the independent probe
  remains the acceptance evidence.
- A late secret registered after a legacy tool event could redact the stored `toolCallId`, so the
  old tool key may not be derivable by the legacy probe in that narrow edge. Normal legacy
  assistant/reasoning/signature/tool rows and all cross-binding cases are covered. No shared
  server reader extension was added.
- Same-UID cleanup is not isolation; a `setsid` descendant escapes the group proof and is cleaned
  by its explicit fixture PID. The cleanup token is visible in client argv/`ps`; it is a cleanup
  generation, not authentication.
- `readAll` reconciliation is O(session) per completion; the two receipts add private reasoning
  rows and increase the reasoning export count. After the reasoning TTL, a very late retry fails
  closed.
- Rolling back to old code with live v2 process records or receipt rows is not safe without root
  reconciliation; forward-fix is preferred.
- No full `npm test`, browser, build, Storybook, mutation tool, `agent-dev`, nested
  sandbox/container, SSH, live model, paid/provider call, Harbor, public corpus or real B1
  execution was run. Stock paid execution remains OFF; D-194 still excludes real bench execution
  on this Mac.
