# R2 trusted public start — bounded implementation plan

**Status:** approved partial slice · **Date:** 2026-10-22.
Base `6da2058`, branch `codex/r2-trusted-start`, local Mac Node26.
Ports5209/4409 and checkout-local `.lane-data`; no SSH, real model, paid call or owner workspace.
Root approved the outside-checkout `reviews/r2-trusted-start-contract-20261022.md`.

## Partial definition of done

A server-owned runtime observation/counter and owned-workspace preparer can admit one immutable
relay run through contract/server/CLI. Missing ports fail explicitly before writer/model/tool
side effects: `runtime_meter_unavailable` or `relay_workspace_unavailable`. Public JSON cannot
assert W, placement, source/confidence or a tokenizer. This slice does not implement a stock
Ollama exact rendered tokenizer or a production workspace allocator and cannot close full R2/MS1.

Implement strict additive public schemas and a T0 runtime/model factory. Bind exact loaded
model/window observations to installed digest/runtime identity, source/time/confidence and
explicit freshness. Exact rendered request counts include framing once. K3 admission/final
scrub checks remain the actual dispatch boundary. Preserve B1 singleAttempt and K4 quota/
response/pending-abort behavior; keep the post-preflight authorization seam extensible for F2.

Resolve project/workspace policy on the server, capture explicit owner choices, and use the
existing GitRelayWorkspace/nativeTools/ExecutionOwner path with an injected owned checkout.
Persist start key/policy and R1/relay initialization atomically under the home fence, additively.
Identical retries return one run; changed retries conflict. No inference resumes after restart.
Stop aborts all host awaits but ownership remains until settlement/cleanup acknowledgement.
Status/result and existing K2 SSE show durable state; subscriber disconnect never stops a run.
Add `guanxi relay exec --json` with observable refusal/cancel/exit semantics; no UI change.

## Checks and delivery

New pure/runtime/route/CLI fixtures use fake local transports and temp SQLite. Assert refusals
have zero writer/dispatch/tool effects, exact counts after scrubbing, source freshness and identity,
policy isolation, duplicate start and rollback, stale fence, cancellation across held observations,
cleanup acknowledgement, restart no dispatch, SSE observer behavior and fixed CLI records.
Actual temp-git/K4 fixture uses shared heavy lock. Existing relay/context/seal, K3/Ollama and R1
suites are regression envelopes. Run contract/server/CLI typecheck, Markdown and license checks.
Root owns full integration gates. All heavy commands use shared agent-dev state/resourceheavy.

Conventional commits separate implementation and independent-review fixes. Another GPT reviews
a pinned quiet diff before integration; root arranges that reviewer. Lane handoff records exact
new/envelope evidence and residuals; no PHASE_STATUS/NEXT_AGENT_PROMPT or main edits. No external
code/dependency copy is planned. Rollback disables new admission, retains additive records and
interrupts outstanding attempts without replaying inference or deleting historical evidence.
