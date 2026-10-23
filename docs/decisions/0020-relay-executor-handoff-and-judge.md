# ADR-0020: Relay executor, ledger-first handoff and judge cascade

**Status:** proposed · **Date:** 2026-10-19 (revised after the S0 review the same day)

## Context

A local model with a 32–64k window must work for hours on one plan without sub-agents.
Compute is free, so it may restart its context any number of times; what must not happen is
quality loss between cycles or losing track of the task. The owner proposed starting a handoff
at about 75% of the window and finishing by about 90%.

Evidence (lane 4): free-form summaries lose the artifact trail (Factory scores 2.2–2.45 of 5)
and erode detail when re-summarised (ACE; Amp replaced compaction with handoff); models
condition on their own earlier mistakes; quality drops long before the nominal window
(context rot, RULER, NoLiMa); Ollama silently truncates over-long prompts.

## Decision

1. **Cycle states**: `boot → orient → work → (wind_down) → handoff_write → handoff_validate →
   sealed → boot | finish | escalate`, with `harness_fallback` if validation fails twice.
2. **Thresholds from reserves**, in tokens, taken from runtime/adapter/policy:
   `H = W − R_turn − S`; `T_hard = H − R_ho − R_tool`;
   `T_soft = min(0.75·W, T_hard − step_med, E)`; boundary rule: hand off right after an item
   closes once usage ≥ `max(0.5·W, T_soft − next_item_estimate)`. `W` is the context actually
   loaded; `E` is the measured effective length of the model and quantization. For a 64k
   window this reproduces the owner's 75%/80–90%; for 32k the hard threshold lands near 68%.
3. **Handoff = ledger + notes + narrative** (`guanxi.handoff/v1`, JSON source of truth,
   rendered to Markdown). The ledger is the run-scoped view of the work ledger (ADR-0032):
   - *ledger* (harness-owned): plan item states, git branch/HEAD/diffstat, files touched,
     last verification runs, error and loop counters, time, budget, ETA;
   - *notes* (agent-written, typed: decision, dead_end, hypothesis, open_issue, lesson) are
     stored append-only; the handoff carries a **deterministic selection** (notes linked to
     open items, the last K decisions, unexpired dead ends) within its budget, and the
     executor can fetch the rest with `notes.search`;
   - *narrative* (written fresh each cycle, bounded): what I was doing, next 1–3 actions,
     hypothesis, watch-outs. Previous narratives are never summarised again.
4. **Fresh-context writer by default**: a separate call of the same model, in a clean context,
   writes the narrative from ledger + selected notes + the last K turns. In-session writing is
   allowed for `W ≥ 64k`.
5. **Sealing**: before sealing, schema, referential integrity (paths, item IDs, evidence,
   HEAD) and size (≤ 15% of `W`) are checked. Sealing uploads the handoff artifact and a git
   bundle of the attempt ref to the run's home, accepted there as a fenced attempt mutation
   (ADR-0018). "Last sealed" means the last handoff accepted under the current token.
6. **Probes**: in the next cycle's `orient`, 3–5 probes generated deterministically from the
   ledger must be answered correctly. A failed critical probe re-renders the handoff from the
   ledger (`degraded`) and retries once; a second failure triggers a J2 judge review and an
   escalation.
7. **Progress is observed, not claimed**: a cycle counts as progress only if the harness
   observes an item status change, a gate change or a non-empty committed diff. Otherwise
   `no_progress_cycles` increments (2 → J2 judge, 3 → escalate). Notes alone are not progress.
8. **Caps from the delegation brief are normative**: maximum cycles, tokens, money, wall time
   and J3 reviews; exceeding any cap moves the run to `wrapping_up`.
9. **Executor rights**: the plan revision is immutable to the executor; it may propose
   amendments that the lead accepts. Acceptance tests are written by the planner up front.
   Protected paths (tests, specs, CI config) are enforced by a deny-write sandbox profile
   (ADR-0027), and gates run in a clean checkout of the attempt commit with protected paths
   restored from the plan's base revision.
10. **Judge cascade** (layers J0–J3):
    - J0 deterministic watchdog (heartbeat, stall, lease, deadline, crash, disk);
    - J1 heuristics (OpenHands stuck patterns, edit-revert oscillation, same failing test
      signature, edits outside item scope, edits of protected paths, token blow-up per item,
      dead-end repetition);
    - J1.5 optional checker script authored by the lead at planning time;
    - J2 local LLM judge in a fresh context with a taxonomy rubric, fed harness-produced
      evidence; executor-written text is quoted as untrusted; verdict + diagnosis hint (never
      a prescribed action), 2–3 samples for confidence;
    - J3 strong-model review only on flagged cases and final acceptance.
    If the J2 host or model is unavailable, the run records `judge_unavailable`, J0/J1
    continue, and after 3 cycles without J2 the run escalates. The executor's own claims are
    triggers for checks, never evidence.
11. **ETA**: plan burn-down + evidence-based scheduling (Monte Carlo over estimate/actual
    ratios per model×host×repo) + throughput sanity from runtime counters; output P50/P80
    with basis and confidence.
12. **Secrets**: verification output stored in the ledger and handoff passes the egress
    scrubber (ADR-0017) before it is hashed or sent to any model.

## Invariants

- No request exceeds `H`; truncation detected through `prompt_eval_count` is a protocol error.
- The rendered handoff always matches the ledger (hash checked).
- Progress is never lost: a failed narrative falls back to a ledger-built handoff marked
  `degraded`.
- A stale attempt can never become the "last sealed" handoff.

## Validation (relay benchmark, stage B3)

About 20 tasks in real repositories that need at least 5 cycles at `W = 32k`. Arms: this
protocol, naive summary compaction, observation masking only, and a single large window where
it fits. Exit assertions, all numeric:

1. **No degradation**: the lower bound of the 95% CI of the per-cycle slope of item success is
   ≥ −1 percentage point per cycle (non-inferiority, not "includes zero").
2. **Better than the baseline**: relay item success ≥ naive-compaction item success with a
   non-inferiority margin of 3 points (paired).
3. Probe accuracy on critical fields ≥ 95%.
4. Zero guarded dead-end repeats; 100% ledger↔handoff consistency; zero truncation events.
5. ETA P80 coverage between 0.7 and 0.9.

## Evidence

Lane 4 §§2, 5, 6, 8 ([research](../research/README.md)), including Anthropic "Effective
harnesses for long-running agents", Factory compression evaluation, ACE (ICLR 2026),
OpenHands condensers and StuckDetector, SWE-PRM, METR time horizons, Evidence-Based
Scheduling; S0 review findings CR-4, H-4, H-8, M-12, M-13, L-12.

## Implementation boundary (R2, 2026-10-21)

The internal single-node `agent.relay` service implements the cycle/ledger/handoff protocol
in [server/relay](../../packages/server/src/relay/README.md). Handoffs carry a hash/reference
to the complete immutable ledger snapshot stored with the fenced seal, plus a bounded strip,
notes and narrative. This keeps context independent of accumulated evidence size. Seals are
atomic uploads of JSON, Markdown, the snapshot and git bundle to the R1 home database.

Runtime admission requires an execution-host observation of the actual loaded window and
rendered-request token count; K3 has no universal meter yet. The tests use fixture meters and
K3 fixture transports, without live models. Judge requests are emitted for R3. The R3-a
optional host-supplied ETA projection now persists empirical P50/P80 forecasts with explicit
unknown/uncalibrated states at safe executor boundaries; see the service README. It is not
live calibration evidence. Judge execution, delegation policy, automatic timing collection,
cross-node transport and B3 quality/non-inferiority remain proposed.
Linked/gitlink repository trees are refused by the current clean-checkout implementation.
See the [R2 hand-off](../plans/evidence/R2.md) for assertions, mutations and exact scope.

## Operational local runtime (R2-op, 2026-10-23)

Stock Ollama still has no exact rendered-request counter and still refuses. An explicit boot
option now supplies one for a **direct llama-server runtime** (ADR-0031 Tier 1): the dispatched
server renders (`/apply-template`), tokenizes (`/tokenize`) and reports the loaded window
(`/props`), and the counted string is the dispatched string. An Ollama-blob vocab sidecar was
rejected because Ollama's Go template and the GGUF Jinja template cannot be proven equal, the
installed llama-server has no vocab-only mode, and a llama.cpp-only host has no Ollama store.
The same option supplies an owned, isolated checkout allocator. See the
[relay README](../../packages/server/src/relay/README.md) and the
[R2-op plan](../plans/lanes/R2-op.plan.md). The status stays `proposed`; no real-model or
real-binary validation has been performed.

## Relay on another node (F2-d, 2026-10-23)

The relay may run on the home node while each model call is executed by another owned node's
llama-server. The executor renders, tokenizes and serves; it answers only signed F2 messages, each
bound to the executor identity, the relay run and its fence, with a fresh challenge. The exact
count is asynchronous (the synchronous bridge would block the loop that renews the fence); the
synchronous count is a lookup of exact answers already obtained for identical bytes. The counted
rendering, token count and served model identity are part of the immutable dispatch job and are
re-verified by the executor and echoed back. There is no local, byte-count or catalog fallback. See
the [F2-d plan](../plans/lanes/F2-d.plan.md) and the
[remote attempts README](../../packages/server/src/remote-attempts/README.md). Status `proposed`;
validated only against a fake llama-server over in-process nodes.
