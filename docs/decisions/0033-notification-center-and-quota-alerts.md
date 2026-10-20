# ADR-0033: Notification center, quota and balance alerts, actionable notifications

**Status:** accepted direction (owner decisions D-123–D-125); proposed design · **Date:** 2026-10-20
**Extends:** legacy ADR-0014 (durable, content-free notifications), [ADR-0017](0017-model-access-connections-and-secrets.md)
(balance and limit facts), [ADR-0019](0019-durable-runs-hibernation-and-wake.md) (signals and wakes).

## Context

The owner wants one place that says, before it hurts, that an API balance or a subscription
usage window is running out — not when a 429 arrives, but when 10% of a 5-hour or weekly
window is left — and lets them act from the notification: add a prompt, accept a recommended
action, or wake the lead(s) that depend on that connection.

What providers expose (lane 1 §10, verified 2026-10-19):

| Source | What Guanxi can observe |
| --- | --- |
| Claude via Claude Code | statusline `rate_limits.five_hour` / `seven_day` `used_percentage` and `resets_at`; Agent SDK `SDKRateLimitEvent` |
| Codex via app-server | `account/rateLimits/read` and the `account/rateLimits/updated` notification (window percentages and resets) |
| OpenRouter | `GET /api/v1/key`: `limit_remaining`, daily/weekly/monthly usage |
| DeepSeek | `GET /user/balance` |
| Anthropic / OpenAI API | rate-limit headers on every response; usage and cost endpoints only with an admin key; otherwise Guanxi's own metering |
| ChatGPT via "Sign in with ChatGPT" | no remaining quota, only the exhaustion error |
| Local runtimes | no money; capacity from the governor |

## Decision

1. **Quota facts**: every connection publishes one fact per window or balance
   (`five_hour`, `seven_day`, `daily`, `monthly`, `balance`, `rate_requests`, `rate_tokens`),
   each `{remaining (absolute and %), resets_at, source, observedAt, confidence}`. Where the
   provider gives nothing, Guanxi meters locally and marks the fact `estimated`.
2. **Alert rules** (D-123), evaluated whenever a fact changes:
   - thresholds at **20%, 10% and 5%** remaining for each window and balance, each firing
     **once per window instance** (reset-aware, with hysteresis so jitter does not re-fire);
   - a **forecast** alert when the current burn rate exhausts a window or balance before
     `resets_at`, or before the P80 ETA of a run that depends on it (ADR-0020 ETA);
   - an **exhausted** alert on the first refusal (429, `usage_limit_exceeded`, balance error);
   - thresholds are configurable per connection; defaults apply to every connection with a
     quota fact.
3. **Notification center**: one durable, per-account inbox for every kind of attention event —
   quota and balance alerts, run outcomes and `input_required`, judge escalations, node and
   home unreachable, security events, evolution proposals and bench verdicts. Rows carry
   `kind`, `severity` (info, warning, critical), `subject` (connection, run, node, project),
   facts with provenance, `state` (unread, read, acted, snoozed, expired) and the actions
   below. Rows are written in the same transaction as the event that causes them (legacy
   ADR-0014 outbox pattern).
4. **Actions** are typed API commands, executed the same way from the UI, the phone or an
   agent with permission, idempotent per notification and logged as events:
   - `open` (the run, session, connection or billing page — billing is an external link);
   - `add_prompt` (send a message to a run's lead or a session);
   - `accept_recommendation` / `choose_action` (from the list the recommender produced);
   - `wake_leads` (deliver a `quota` signal to hibernating leads that depend on the
     connection, ADR-0019 signals; batched into one delivery per lead);
   - `switch_connection` (rebind a role to a fallback connection for future steps of a run);
   - `pause_runs` / `resume_runs` (runs that use the connection; running steps finish);
   - `snooze` (until a time or until the window resets);
   - `raise_budget` (for budget-ledger caps; never spends money by itself).
5. **Recommended actions** come from deterministic rules first (for example: "the Claude 5-hour
   window is at 90% and resets in 1 h 40 min; two leads depend on it; recommended: defer lead
   wakes until the reset and let reviews use DeepSeek"). An optional short LLM explanation may
   be added by a local model; the recommendation itself never depends on an LLM.
6. **Automatic reactions** (D-124): Guanxi acts on its own only when the run's policy already
   names the reaction (for example `on_quota_low: {role: reviewer, fallback: deepseek-flash}`
   or `pause_background_when < 10%`). Otherwise it only recommends. Every automatic action
   creates a notification saying what was done, with an undo action where possible.
7. **Agents see the same facts** (`connections.status`, ADR-0017); a lead may also subscribe to
   `quota` signals through its wake policy.
8. **Delivery** (D-125): in-app notification center (desktop and web), operating-system
   notifications (macOS, Linux, Windows) and phone push (PWA Web Push, later the native app).
   Push and OS payloads are content-free beyond a short title; details load after opening.
   Quiet hours and per-kind channel settings apply; `critical` may bypass quiet hours if the
   user allows. More channels (Telegram, email) can be added later as plugins.
9. **Multi-user**: notifications belong to the account that owns the connection or run; a
   shared session's editor gets notifications only for their own connections.

## Invariants

- A threshold notification fires at most once per window instance and threshold.
- Every notification shows the source and observation time of the facts it is based on.
- An action executes at most once per notification (idempotency key).
- No automatic action happens unless the run policy named it.

## Consequences

Quota problems surface early and are actionable from the phone. Polling provider endpoints
costs a few requests per interval; facts from response headers and agent events are free.

## Validation

- A simulated window crossing 20%, 10% and 5%, jittering around 10%, and resetting produces
  exactly three notifications and then re-arms after the reset.
- A forecast alert fires when a synthetic burn rate exhausts the window before a dependent
  run's P80 ETA, and not otherwise.
- `wake_leads` delivers one signal per hibernating lead, exactly once, across a crash of the
  home node.
- With no fallback in the run policy, quota exhaustion only recommends; with a fallback, the
  role switches and a "done automatically" notification appears with undo.
- Push and OS payloads contain no session content (payload inspection test).

## Evidence

Lane 1 §10 ([research](../research/README.md)); legacy ADR-0014; ADR-0019 signals.
