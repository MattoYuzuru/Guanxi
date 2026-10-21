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
| Gap-free `seq` per session, no duplicates | an event is inserted only at `last_seq + 1`, and inserting it advances the head (triggers); the head moves only onto an existing event; `UNIQUE (session_id, seq)`; the envelope is validated before the insert, so a caller that catches a refused append and commits leaves no gap | `session-log.test.ts` (append-only schema, gap test) |
| Single writer (D-116) | one open `SessionHandle` per session per process; a `session_writers` row with an epoch; the database refuses an event whose epoch is not the current unreleased one | `session-log.test.ts` (single writer) |
| A writer changes only by grant, release, expiry or handover from a gone process | `acquireWithin`; the epoch may only move to the next value, a released epoch cannot resume and a writer row goes only with its session (triggers); each change appends `writer.acquired` with its reason | same, `session-log-review.test.ts` |
| Crash at any append point leaves the event fully present or fully absent | one `BEGIN IMMEDIATE` transaction advances the head, inserts the event and indexes it (FTS5 triggers); the mirror shares the Job transaction | `session-log-crash.test.ts` (in-process throw and child `SIGKILL` at every point) |
| A retried append is not a duplicate | `idempotencyKey` (`UNIQUE (session_id, idempotency_key)`) or `expectedSeq` returns the stored event | same |
| Persisted before streamed, checked when emitted | subscribers are woken after commit and read SQLite after their cursor; each event of a page read earlier is checked (readiness, withheld, catching up) and its row read again when it is yielded and again in the route right before it is serialised, so a value registered, a catch-up started, a retention purge or a deleted Thread while a stream is open applies to its next frame; `closeSubscriptions()` ends streams at shutdown | `session-log-routes.test.ts`, `session-log-chat.test.ts`, `session-log-review.test.ts` (shutdown), `session-log-recheck.test.ts` (N5) |
| No secret value in an event (D-141) | every payload passes the egress scrubber before it is stored and again when it is read; the serialised payload and the joined search text are scrubbed again and a payload that would still change is refused; titles come from the scrubbed first prompt; search snippets are built from the scrubbed indexed text and drop hits that matched only a now-redacted value, and search reads ranked candidates lazily until the limit is filled or the matches run out; echoed queries are scrubbed; identifiers holding a registered value are refused at write, and a session whose id holds a value registered later is withheld from every read (`session_withheld`, HTTP 403, a content-free tool error), left out of search hits and counted, not listed, by the session list; the generated event id must stay a UUID, so an event whose id holds a value registered later withholds every read that would return it, at read and at emit time | `session-log.test.ts` (scrubbing), `session-log-chat.test.ts` (planted secret), `session-log-review.test.ts`, `session-log-recheck.test.ts` (N1, N4, N6) |
| Reasoning never reaches a remote agent or an export (D-113) | `remote_agent` reads filter `class = 'standard'` in SQL; exports drop reasoning | `session-log-chat.test.ts`, `session-log-routes.test.ts` |
| Reasoning retention | reasoning events carry `expires_at` (7 days, or the parent Chat's sooner TTL; a caller may shorten it, never extend it); reads and search treat an expired event as purged; the plugin purges at start and every 10 minutes, then optimizes the FTS index; `secure_delete` zeroes freed pages; the event stays | `session-log.test.ts` (reasoning class), `session-log-review.test.ts` (no bytes left in the file) |
| Events disappear only with their Thread | delete triggers on `sessions` and `session_events` | `session-log.test.ts` |
| Reasoning never in plain logs | the module never writes to the console; the test captures stdout, stderr and console during a full turn | `session-log-chat.test.ts` |
| Nothing written or read before every secret source registered (K3 review H3), nothing lost meanwhile (GPT review R2), and no history shown before it is complete (GPT re-check N2) | while `egress.scrubber` is not ready the mirror records only the Job id in `session_mirror_backlog` inside the Job transaction; once ready (or at the session's next Job event, or at the next start) it reconstructs the trace from `job_events` and `chat_job_inputs`, idempotently, with the source times, per session in durable chat order (the user message's sequence) and before anything newer: a ready write first drains the session's backlog inside its own transaction and defers as well if that fails. Until a session's backlog is empty its reads refuse with `session_catching_up` (HTTP 503 with `details.failure`, a content-free tool error), the list counts it (`catchingUp`, `catchUpFailed`) instead of listing it, and search leaves it out; a failed attempt is retried after a bounded delay doubling from 1 s to 5 min, and later Job events of that session defer behind it without rebuilding it. Handles, reads, routes, exports and the query tool fail closed with `egress_not_ready` | `session-log-readiness.test.ts` (including `SIGKILL` before ready), `session-log-recheck.test.ts` (N2, N3) |

## Writing

```ts
const handle = log.open(sessionId, { kind: 'agent' }) // throws writer_busy if held
handle.append({ type: 'prompt', data: { origin: 'typed', messageId, text, attachmentCount: 0 } },
  { idempotencyKey: `prompt:${messageId}` })
handle.close() // releases the writer row
```

The legacy Chat path does not open a handle. `JobStore` (constructed with a `ChatSessionMirror`)
appends inside each Job transaction through `appendAsSystemWithin`, which acquires or renews the
writer row in that transaction. The trace is a deterministic function of the durable Job store,
and the mirror works by catching up:

- for a Job it mirrors every Job event after the trace's cursor (the highest mirrored Job
  sequence), in order, through one mapping; normally that is just the event being inserted;
- token and thinking deltas are not mirrored one by one; at the next non-delta Job event the
  deltas since the cursor are read back and appended as one `reasoning` and one
  `assistant.message` event, so the scrubber sees whole messages;
- while the scrubber is not ready the mirror writes nothing and records the Job id in
  `session_mirror_backlog`; the backlog is caught up when the scrubber becomes ready, at the
  Job's next event, or when the next mirror starts;
- each mirrored event carries the Job event's time (`occurredAt`) and the idempotency key
  `job:<jobId>:<jobSequence>:<part>`, so a reconstruction equals the trace a ready mirror would
  have written, and repeating it adds nothing.

## Writer epochs

- **First grant:** epoch 1, `writer.acquired` with reason `initial`.
- **Takeover:** the next epoch, allowed only when the previous writer `released` its row, its
  row `expired` (TTL 30 s, renewed by every append, handles included), or its process is gone
  (`writer_process_gone`). A row with another PID is gone when `kill(pid, 0)` says so; a row
  with this process's PID is gone unless its writer id is live in this process (a container
  restart reuses PID 1). The host name is recorded for diagnostics only: the node database is
  local, and macOS host names follow the network.
- **A fenced writer** gets `writer_fenced` on its next append. Its in-flight transaction cannot
  commit an event either, because the insert trigger checks the current epoch.
- **Not an ADR-0018 lease.** The epoch is a process-level fencing token for one node database.
  `writer_process_gone` hands over before expiry, which ADR-0018 forbids for leases; R1's
  lease table must not reuse `session_writers`.
- **Trace failures block the Chat Job write.** The mirror runs inside the Job transaction, so a
  refused trace write (a live second writer, an identifier holding a secret) rolls the Job event back.
  The exception is catching up older deferred Jobs before a ready write: that runs in a savepoint,
  and on failure the newer Job is deferred behind them instead, so the Chat keeps working while
  its session stays `session_catching_up`.
  This is deliberate: a Job event without its trace would break the trace's completeness and
  could hide an unscrubbed payload. Two servers on one data directory are unsupported; the
  second fails loudly instead of corrupting the first one's sessions.

## Reading

The inspector routes serve the `person` audience, so until the remote security profile exists
(accounts, TLS, scoped credentials) they answer **loopback socket peers only** (`403
loopback_only` otherwise, and when the peer is unknown), even if the server listens on another
interface through `HOST`. The check reads the socket's remote address; a Host-header allowlist
(K3) does not authenticate a peer and does not replace it.

| Audience | Gets |
| --- | --- |
| `person` (inspector routes, loopback peers only) | every event, reasoning included |
| `local_agent` | every event |
| `remote_agent` | every event except the reasoning class, filtered in SQL |

`audienceForAgent({ endpoint, runtime, model })` returns `local_agent` only when the endpoint is
loopback, the runtime adapter executes on this machine (today: `ollama`) and the model is not
cloud-backed (Ollama's `…-cloud` and `:cloud` models run on ollama.com through the local
daemon). Anything else or unknown, including a loopback proxy, is `remote_agent`.

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
- PID reuse by an unrelated process delays a handover until the row expires (30 s). Startup
  recovery fails in that window. A data-directory lock in R1 replaces the PID heuristic.
- Once the system writer (the mirror) has written a session, `open()` on it returns
  `writer_busy` for the life of the process; K4 must hand sessions between the two.
- `session.log` is provided as the `SessionLog` instance. A frozen facade with a node-bound
  audience is K4's, before agents consume it.
- A secret cut off by a cancel never appears in full in the output, so exact match cannot catch
  its prefix.
- Remote audiences see gaps in `seq` where reasoning events are; they learn how many there were,
  not what they said.
- Agent sessions (no Thread) cannot be deleted yet; they need their own retention.

R1 node-home services use `appendFromHomeWithin` in their existing SQLite transaction. It
appends through this log's current handle fence if present. Otherwise it acquires a node-home
fence within that transaction, reserving no handle slot on commit or rollback. Closing the
log releases all durable rows owned by its writer identity.
The caller notifies only after commit. This additive path permits K4's
`log.open(sessionId, { kind: 'agent' })` before or after R1 lifecycle events; a second handle
still fails with `writer_busy`. The legacy mirror API and its exclusivity are unchanged.

R1 migration 30 also adds `idx_session_mirror_backlog_thread` on
`session_mirror_backlog(thread_id, job_id)` for K2 thread readiness/catch-up lookups. Migration
29 and its schema bytes stay unchanged; this shared additive index changes no event contract.
