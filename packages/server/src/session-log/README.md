# Session log

**Status:** implemented (K2), locally validated · **Updated:** 2026-10-20 · **Owner:** lane K2

One append-only event log per session is the trace
([ADR-0023](../../../../docs/decisions/0023-session-event-log-and-tracing.md)). It lives in the
node's SQLite database (migration 29), runs as the kernel plugin `guanxi.session-log`
(service `session.log`, `requires: ['egress.scrubber']`) and is read by the inspector routes,
the web inspector and the agent query tool.

## Files

| File | What it holds |
| --- | --- |
| [`schema.ts`](schema.ts) | Migration 29: `sessions`, `session_writers`, `session_events`, the FTS5 index and the triggers that enforce the log's shape |
| [`log.ts`](log.ts) | `SessionLog` and `SessionHandle`: single writer, append, read, search, purge, subscribe |
| [`chat-mirror.ts`](chat-mirror.ts) | The legacy Chat Job store behind the log: `JobStore` appends the trace inside its own transactions |
| [`projection.ts`](projection.ts) | Spans, token meter and transcript projections over events |
| [`query-tool.ts`](query-tool.ts) | `session_log_query` tool and the audience rule |
| [`routes.ts`](routes.ts) | `/api/sessions/**` inspector routes |
| [`plugin.ts`](plugin.ts) | The kernel plugin, bound by the host to the node database |

Event schemas are in `packages/contract/src/events/`.

## Guarantees and where they are enforced

| Property | Enforcement | Test |
| --- | --- | --- |
| Gap-free `seq` per session, no duplicates | the head advances by exactly one (trigger); an event must be inserted at the head (trigger); `UNIQUE (session_id, seq)` | `session-log.test.ts` (append-only schema) |
| Single writer (D-116) | one open `SessionHandle` per session per process; a `session_writers` row with an epoch; the database refuses an event whose epoch is not the current unreleased one | `session-log.test.ts` (single writer) |
| A writer changes only by grant, release, expiry or handover from a gone process | `acquireWithin`; the epoch may only move to the next value (trigger); each change appends `writer.acquired` with its reason | same |
| Crash at any append point leaves the event fully present or fully absent | one `BEGIN IMMEDIATE` transaction advances the head, inserts the event and indexes it (FTS5 triggers); the mirror shares the Job transaction | `session-log-crash.test.ts` (in-process throw and child `SIGKILL` at every point) |
| A retried append is not a duplicate | `idempotencyKey` (`UNIQUE (session_id, idempotency_key)`) or `expectedSeq` returns the stored event | same |
| Persisted before streamed | subscribers are woken after commit and read SQLite after their cursor | `session-log-routes.test.ts`, `session-log-chat.test.ts` |
| No secret value in an event (D-141) | every payload passes the egress scrubber before it is stored and again when it is read; thread titles and echoed queries are scrubbed too | `session-log.test.ts` (scrubbing), `session-log-chat.test.ts` (planted secret) |
| Reasoning never reaches a remote agent or an export (D-113) | `remote_agent` reads filter `class = 'standard'` in SQL; exports drop reasoning | `session-log-chat.test.ts`, `session-log-routes.test.ts` |
| Reasoning retention | reasoning events carry `expires_at` (7 days, or the parent Chat's sooner TTL); a bounded purge nulls the content and its index entry; the event stays | `session-log.test.ts` (reasoning class) |
| Events disappear only with their Thread | delete triggers on `sessions` and `session_events` | `session-log.test.ts` |
| Reasoning never in plain logs | the module never writes to the console; the test captures stdout, stderr and console during a full turn | `session-log-chat.test.ts` |
| Nothing written or read before every secret source registered (K3 review H3) | the mirror holds writes in a bounded buffer while `egress.scrubber` is not ready and flushes them in order once it is; a full buffer refuses the write (`egress_buffer_full`, the Job transaction rolls back); handles, reads, routes, exports and the query tool fail closed with `egress_not_ready` | `session-log-readiness.test.ts` |

## Writing

```ts
const handle = log.open(sessionId, { kind: 'agent' }) // throws writer_busy if held
handle.append({ type: 'prompt', data: { origin: 'typed', messageId, text, attachmentCount: 0 } },
  { idempotencyKey: `prompt:${messageId}` })
handle.close() // releases the writer row
```

The legacy Chat path does not open a handle. `JobStore` (constructed with a `ChatSessionMirror`)
appends inside each Job transaction through `appendAsSystemWithin`, which acquires or renews the
writer row in that transaction:

- token and thinking deltas are not mirrored one by one;
- at the next non-delta Job event the mirror reads the deltas since the last mirrored Job event
  back from `job_events` and appends one `reasoning` and one `assistant.message` event, so the
  scrubber sees whole messages and nothing is held in memory;
- each mirrored event's idempotency key is `job:<jobId>:<jobSequence>:<part>`.

## Writer epochs

- **First grant:** epoch 1, `writer.acquired` with reason `initial`.
- **Takeover:** the next epoch, allowed only when the previous writer `released` its row, its
  row `expired` (TTL 30 s, renewed on append), or it ran on this host and its process is gone
  (`writer_process_gone`, checked with `kill(pid, 0)`).
- **A fenced writer** gets `writer_fenced` on its next append. Its in-flight transaction cannot
  commit an event either, because the insert trigger checks the current epoch.

## Reading

| Audience | Gets |
| --- | --- |
| `person` (inspector routes) | every event, reasoning included |
| `local_agent` | every event |
| `remote_agent` | every event except the reasoning class, filtered in SQL |

`audienceForModelEndpoint(url)` returns `local_agent` only for a loopback model endpoint.
Anything else, including no endpoint, is `remote_agent`.

## Residuals

- Legacy `job_events.output` and `messages` keep their unscrubbed private Chat payloads; they
  are the execution substrate until R1. The trace, the inspector, exports and the query tool
  never read them.
- Sessions created before migration 29 have no backfilled trace; their trace starts with the
  next turn.
- Large payloads are stored inline; content-addressed artifacts with excerpts (ADR-0023 §4)
  are not wired yet.
- The query tool is built and tested through the legacy `ToolRegistry`, but no agent loop
  registers it by default; K4 does.
- Reasoning retention is the fixed 7-day default (or the parent's sooner TTL); a per-project
  setting does not exist yet.
- Writer liveness is judged per host by PID; PID reuse can only delay a handover (safe), never
  create a second writer.
