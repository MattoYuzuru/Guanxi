# R2 trusted public start — partial hand-off

**Status:** implemented partial candidate; initial independent findings fixed, re-review and
integration pending. **Date:** 2026-10-22. **Initial source:** `b3a1d9d`, base `6da2058`, branch
`codex/r2-trusted-start`, worktree `/Users/yuzuru/Projects/Guanxi-lanes/r2-trusted-start`.
No main/status edits, pushes, remote hosts, live models, paid calls or owner workspaces were used.

## Delivered boundary

Contract/server/CLI expose a loopback-only relay start/status/result/stop flow. Strict public
input carries explicit owner choices, never loaded W, placement, renderer or source facts.
The server resolves the actual native project/workspace roots and freezes them with the plan,
caps, Full-access consent, domains, reserves and node ports. An optional trusted runtime port
matches live loaded model/context to installed digest and runtime version, with source,
observation time, high confidence and explicit freshness. An optional exact rendered-request
counter includes framing once; its identity/source and the final request shape are checked.
The local zero-cost quote is explicitly a trusted host-compute policy, not an observed bill.

Default production wiring has no proved stock-Ollama exact counter or safe owned-checkout
allocator. It refuses `runtime_meter_unavailable` or `relay_workspace_unavailable` before a
new run, attempt, session, allocator or public-start migration is created. Loading the existing
relay plugin still performs its historical independent migration35; this is not a zero-DDL
server-start claim. No byte-count, catalog-context, paid/cloud or unsandboxed fallback exists.

The trusted allocator supplies an isolated checkout, scratch/runtime namespace and cleanup
acknowledgement. Execution reuses `GitRelayWorkspace`, K4 native tools/ExecutionOwner and
the protected clean acceptance gate. Project source/parent roots are refused as executable
allocation namespaces. Known K4 quarantine retains the workspace and reports cleanup uncertainty.
Uncooperative resource owners can delay stop; no timeout manufactures their acknowledgement.

R1 `createStarted` commits session, run, attempt, relay initialization and independent ledger39
mapping in one fenced synchronous transaction. Throwing or accidentally asynchronous extensions
roll back. The captured home generation is rechecked before admission and settlement. Identical
keys return the same run, changed requests conflict, and restart never resumes inference.
Public completion is published only after cleanup settles; a terminal R1 row alone cannot
prove missing-owner cleanup. Existing K2 SSE is an observer; disconnect never cancels a run.

K3 authorization now runs after governor acquisition and Ollama version preflight. Final
scrubbing/onPrepared and exact shape/count validation execute synchronously immediately before
POST. Existing B1 single-attempt and K4 quota/response/pending-abort code is retained. This is
compatible with the future F2 trusted authorization callback; F2 is not merged into this base.
The optional R3 cascade remains a separate trusted integration seam and is never public JSON.

## Initial validation and assertions

All checks used local Node26. Actual K4 fixtures used the existing local Colima endpoint and
cached execution image, checkout-local `.lane-data` synthetic git trees, and the shared
`/Users/yuzuru/.local/state/agent-dev` resource `heavy`. No container build/pull or real model ran.

New tests: **26** = 7 runtime-meter, 3 refusal/atomic-extension, 12 public-start/K3/K4,
4 CLI. Regression envelope: **151** existing relay/context/seal/workspace/model, Connections,
Ollama client and durable-R1 cases. Combined **177/177**, zero failed/canceled/skipped, receipt
`check-h7ex42wf` (source unchanged during execution, before the source commit).

- Runtime: actual loaded W/digest, source/age, stale/future/ambiguous/mismatched facts,
  local/unattended consent, changed host/window/version/digest, complete framing, final request
  shape, counter-source changes, post-scrub ceiling, and exact observed-usage mismatch.
- Start: zero writer/allocation/dispatch on default refusal, strict wire and route guards,
  real K3 plus K4 read/clean acceptance path, immutable persisted policy, one-run retries,
  transaction rollback, sync-only extensions, stale home, restart no dispatch, SSE independence,
  cancellation through held read-only observations, allocation/cleanup acknowledgement,
  terminal status delayed until cleanup, and retained quarantine.
- CLI: explicit JSON request/status, refusal and safe error records, preparation cancellation
  by start key, unconfirmed cancellation, URL/input validation and exit-code mapping.

Contract/server/CLI typecheck passed after final source changes. Markdown lint/link checks
passed (167 files, 631 links); license check passed (658 packages, zero disallowed), and
`git diff --check` passed. No dependencies or third-party source were added. No web code changed.
The agent-dev receipt cannot be reused as certified source evidence because the existing
`.claude/skills/guanxi-ui` symlink is unsupported by its fingerprint verifier; the check is a
direct local observation with an unchanged source fingerprint during execution. Commit and
later integration checks require their own evidence. No full global/browser/Linux gate is claimed.

## Independent findings and separate repair

Independent review of `93ded9e` by GPT `ms1_dependencies` confirmed three P2 classes through
four external reproductions, recorded outside checkout in
`reviews/codex-r2-trusted-start-20261022.md`: R1 home/cancel revocation during version preflight
could admit one POST, preparing stop swallowed a cleanup failure, and late secret registration
could reach the original persisted policy. These are distinct from the separate client
transport-settlement prerequisite below.

Separate repair **`07dbc2e`** adds captured home/attempt guards before and after asynchronous
runtime authorization and synchronously at final prepared validation after exact counting,
before fetch. It preserves `failed/cleanup_unconfirmed` for a preparing cancellation whose
owned allocation cannot acknowledge cleanup. Inside `createStarted`, fresh scrub equivalence
of the entire immutable policy and runtime/meter evidence refuses withheld content before
extension DDL, relay initialization or the mapping insert; the surrounding R1 transaction
rolls back its earlier session/run/attempt writes.

The four exact repository regressions first failed **0/4** at pre-fix source
(`check-ndjipzna`), then passed **4/4** with the minimal repair (`check-imhojhoj`). Three more
assertions cover both home/cancel revocation during the post-preflight authorization await and
late withholding in runtime/meter evidence. The final scoped check passes **184/184**, zero
fail/canceled/skipped, **33 new / 151 inherited**, `check-nvr1q08r`; source unchanged during
that pre-commit check. Contract/server/CLI typechecks and diff-whitespace checks pass after
the repair. Source-certificate limitations above still apply. The repair awaits separate
independent re-review; neither initial review nor these author checks is recorded as closure.

## Integration prerequisites and remaining gates

The independent R3 author confirmed an existing Ollama POST ownership gap: the observer's
abort/deadline race can reject before an injected POST fetch/body settles and release the
governor early. Root assigned a separate client-only settlement repair. **Do not integrate or
claim model-cancellation ownership from this candidate alone.** Reconcile that separate pin
with this candidate's optional fourth `chat` dispatch argument, preserve read-only version
preflight cancellation, and verify actual POST/body acknowledgement before governor release.
This means transport cleanup acknowledgement only; it does not prove backend model computation
stopped. Root coordinates the fix and independent review.

Next: independent GPT re-review of the separate repaired pin;
merge/review the separate client settlement repair and current main/R3/F2 seams; repeat targeted
integration evidence under the shared lock; root owns full candidate gates and central status.
Stock exact rendered tokenization, trusted production workspace allocation, operational quality/
hardware benchmarks, and the remaining ADR0020/0025/full-R2/MS1 gates remain open. A T0 counter
attestation is a host trust boundary, not proof that an arbitrary loopback proxy is free/local.

Rollback disables public admission and retains additive ledger39/history. Restarts reconcile
durable state without dispatch; do not delete historical evidence or replay an interrupted call.
