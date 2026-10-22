# B1 trial binding handoff

**Status:** implementation and author-focused checks complete; independent root/GPT review and
full integration gates pending. **Date:** 2026-10-22. **Branch:** `codex/b1-trial-binding`.
**Base:** `6da2058` (`docs: record reviewed B1 merge and next integration checks`).
**Implementation pin:** `28a1369` (acceptance-test hardening) and `5a211ca` (cleanup); the
docs/handoff commit follows them. The final clean branch HEAD is reported by the worker after
the last commit.

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
