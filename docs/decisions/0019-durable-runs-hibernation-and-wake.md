# ADR-0019: Durable runs, lead hibernation and wake-up

**Status:** proposed · **Date:** 2026-10-19 (revised after the S0 review the same day)
**Extends:** legacy ADR-0004 (durable jobs and events), ADR-0014 (notification outbox).

## Context

The north-star scenario (D-106) needs a lead agent that dispatches work to another machine,
stops consuming tokens, and is woken exactly when something needs it: completion, failure
after retries, a lost host, a deadline, a judge escalation or a question only the lead may
answer. Batch jobs (REQ-G6) and remote tests (REQ-B5) need the same machinery.

The legacy code already has a persisted-first durable Job store with idempotent create,
monotonic event sequence, transactional terminal state and startup reconciliation. Lane 3
found no embedded engine that fits a single-binary multi-node personal fleet (Temporal's
SQLite is dev-only, Restate is BSL, Inngest SSPL, DBOS TypeScript Postgres-only).

## Decision

1. Keep and extend Guanxi's SQLite run store with five additive primitives:
   `run_attempts`, `leases`, `promises` (+ waiters), `timers`, `outbox`.
2. **Run states** and their A2A mapping:

   | Guanxi state | A2A `TaskState` | Meaning |
   | --- | --- | --- |
   | `submitted` | submitted | accepted, not started |
   | `working` | working | an attempt is executing |
   | `waiting_children` | working (substate) | hibernating; awaits one or more promises; no process, no leases except retained resources |
   | `input_required` | input-required | needs a decision only the lead or user may make |
   | `wrapping_up` | working (substate) | finishing a report before a terminal state |
   | `completed`, `failed`, `canceled`, `rejected` | same | terminal |
   | `interrupted` | failed (with reason) | an executing attempt was lost at restart; recoverable by retry |

3. **Attempts**: every retry is a new attempt on the run's single execution fence (ADR-0018
   §3); unsafe mutating steps are never replayed automatically (legacy ADR-0004 rule).
4. **Timeouts** borrowed from Temporal (schedule-to-start, start-to-close, heartbeat,
   schedule-to-close) stop renewal; they never create a second active attempt.
5. **Hibernation**: `delegate()` creates the child run, a promise and moves the lead run to
   `waiting_children` in one transaction. Attempt leases are released; **run-scoped retained
   resources** (the lead's worktree, scratch directory) keep a lease owned by the run with
   `retain_until`, so the reaper does not delete them while the lead sleeps. The lead's home
   must be `always_on` (ADR-0018 §5).
6. **Signals and promises**:
   - a promise resolves exactly once: the child's terminal transition or the deadline timer,
     whichever commits first ("first emit wins");
   - escalations (`input_required` from the child, a judge flag) and `quota` events of a
     connection the lead depends on (ADR-0033) are **signals**: they wake the lead without
     resolving the promise; the promise stays pending;
   - after a deadline the child is canceled with a `wrap up and report` request or detached,
     per the delegation brief (default: cancel after wrap-up);
   - a *wake* is the decision to resume the lead (one per resolution or signal); a *delivery*
     is the handler run. Several wakes may be batched into one delivery (debounce, quiet
     hours); each wake is still recorded and acknowledged exactly once.
7. **Wake delivery**: the outbox row is written in the same transaction as the resolution or
   signal. A waker creates a new **lead attempt** with idempotency key `(run_id,
   wake_seq)`. The wake is acknowledged only when that attempt has started its first model
   call; an unacknowledged wake is redelivered.
8. **Wake packet** (≤ about 4k tokens, scrubbed by the egress scrubber of ADR-0017):
   outcome, item table with evidence links, gates, diffstat, last narrative, judge summary,
   open questions, metrics, and links for drill-down. The full trace is never loaded into the
   lead's context.
9. **External agents as leads**: waking a Claude Code or Codex lead resumes its session
   through its protocol; if it cannot resume, a new lead session is seeded with the lead's
   last handoff and the wake packet. If the lead connection is unavailable (quota exhausted,
   subscription login missing), the lead attempt fails with `lead_unavailable`, the packet is
   kept, the user is notified, and a fallback lead connection is used only if the run policy
   names one.
10. **Cancel along the chain**: canceling a run cancels or detaches each child per the
    delegation brief (default cancel), exactly once, including while the lead is hibernating.
11. **Restart reconciliation** per state:

    | State at restart | Action |
    | --- | --- |
    | `waiting_children`, `input_required` | untouched |
    | `working` with a local attempt | attempt → lost; run → `interrupted` or retry per policy |
    | `working` with a remote attempt | keep during the grace period; expire normally afterwards |
    | wake delivered but not acknowledged | redeliver as a new lead attempt |
    | `wrapping_up` | resume the report step |

## Invariants

- Exactly one resolution per promise and exactly one acknowledged wake per resolution or
  signal, across any crash point.
- While the run's home is up, a deadline always wakes the lead, even if the child's host is
  gone. If the home was asleep, the wake fires when it returns.
- Model installation on a node becomes a node-owned run with resumable download in stages F2
  and W1 (D-147). Until then, and for every other connection-owned stream, the legacy rule
  holds: those streams are not durable.

## Consequences

Durable execution remains in-house, small and testable. Guanxi owns correctness tests that a
framework would otherwise provide (simulation, fault injection).

## Validation

- Property test over every crash point of both the hibernation and the wake sequence: one
  resolution, one acknowledged wake, no lost wake.
- A late completion from an expired attempt is rejected (`409 stale_lease`) and wakes nobody.
- A deadline wakes a lead whose child's node never returns; the child is canceled or detached
  as configured.
- An escalation wakes the lead and a later completion wakes it again (two wakes, one
  resolution).
- The lead's worktree still exists after an 8-hour hibernation.
- Canceling a hibernating lead cancels its children exactly once.

## Evidence

Lane 3 §5 and §7.9, lane 4 §8.4 ([research](../research/README.md)); Temporal timeouts;
Absurd and OpenWorkflow event semantics; Restate/Resonate durable promises (pattern only);
A2A task states; S0 review findings H-3, H-6, H-11, M-14, M-15, L-12.
