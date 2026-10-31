# Session log

**Status:** implemented (K2), locally validated; queue v3 reader/migration foundation unreleased
(Q0 plus the Q1 restricted native reader) · **Updated:** 2026-11-01 · **Owner:** lanes K2/K4

One append-only event log per session is the trace
([ADR-0023](../../../../docs/decisions/0023-session-event-log-and-tracing.md)). It lives in the
node's SQLite database (migration 29), runs as the kernel plugin `guanxi.session-log`
(service `session.log`, `requires: ['egress.scrubber']`) and is read by the inspector routes,
the web inspector and the agent query tool.

## Files

| File | What it holds |
| --- | --- |
| [`schema.ts`](schema.ts) | Migrations 29 and 33: `sessions`, `session_writers`, `session_events`, session input artifacts, the FTS5 index and the triggers that enforce the log's shape |
| [`queue-schema.ts`](queue-schema.ts) | Independent ledger 40 and its atomic installer; replaces only the event-policy trigger to admit strict v3 queue snapshots |
| [`log.ts`](log.ts) | `SessionLog` and `SessionHandle`: single writer, append, read, search, purge, subscribe; v3 queue descriptor resolution and current-registry projection |
| [`excerpt.ts`](excerpt.ts) | Current-registry projection of v2 excerpts and per-item v3 queue previews; never reads a blob |
| [`input-encoding.ts`](input-encoding.ts) | Restartable ≤64 KiB UTF-8 chunk iterator, exact string hashing and bounded excerpt prefix encoding |
| [`chat-mirror.ts`](chat-mirror.ts) | The legacy Chat Job store behind the log: `JobStore` appends the trace inside its own transactions |
| [`projection.ts`](projection.ts) | Spans, token meter and transcript projections over events |
| [`query-tool.ts`](query-tool.ts) | `session_log_query` tool and the audience rule |
| [`routes.ts`](routes.ts) | `/api/sessions/**` inspector routes |
| [`plugin.ts`](plugin.ts) | The kernel plugin, bound by the host to the node database |

Event schemas are in `packages/contract/src/events/`.

## Paged metadata for navigation

`GET /api/sessions/list/page` is an additive, loopback-only metadata endpoint; the existing
`GET /api/sessions` response remains unchanged. Its cursor orders rows by creation time and
session id, and each page skips withheld identifiers and incomplete mirrors before filling the
requested size. It returns no event payloads or reasoning. Run state comes from the actual
root run's `session_id` association, with its stored observation time; it is not a live-process
or execution-authority claim.

Navigation targets come from active native-session or legacy Thread records, including the
Thread's actual Project. Missing, left, trashed, deletion-requested or newly withheld targets
fall back to the session inspector. Session kind and the display-only scrubbed `threadId` do
not authorize a chat destination. `session-list-page.test.ts` covers pagination, provenance,
scrubbing, readiness and these navigation boundaries. The web shell consumes this metadata in
a separate slice.

## Queue v3 and independent ledger 40 (Q0)

Queue snapshots have a third, strictly discriminated envelope. v1 `agent.queue`
`{items:[{id,text}]}` and every v1/v2 shape stay readable and unchanged; the producer in
`native-agent` still writes v1 until Q2 (Q1 reads v3). A v3 snapshot is a standard `agent.queue` event
whose items are either `{id,kind:'inline',text}` (at most 16 KiB scrubbed UTF-8) or
`{id,kind:'artifact',artifact}` (the existing exact excerpt/reference shape, media
`text/plain; charset=utf-8`, byte size above 16 KiB). Empty snapshots are valid, item ids are
unique per snapshot, and no opposite-branch field is accepted. Each artifact entry is plural:
`inputArtifactsOf(event)` returns every reference in item order, while the singleton
`inputArtifactOf(event)` keeps its prompt/tool-call meaning and returns `null` for a queue.

Append input carries descriptors, never caller-selected artifact ids:

```ts
handle.append({
  type: 'agent.queue',
  data: { items: [
    { id: inlineId, kind: 'inline', text: scrubbedText },
    { id: artifactId, kind: 'artifact', input: { checksum, byteSize, mediaType, excerpt } },
  ] },
}, { eventVersion: 3 })
```

`log.ts` parses the strict descriptor schema, resolves every descriptor through
`resolveInputArtifactWithin` and validates the published snapshot inside the same synchronous
transaction as the event/head/FTS insert. Equal text with distinct queue ids stays distinct;
same-session equal checksums share one metadata/blob row. A failure after an earlier metadata
insert rolls the whole snapshot back.

`queue-schema.ts` owns `session_queue_migrations` (one row, version 40) in the same database.
It runs in every `SessionLog` construction after `openDb` applied global 33, takes
`BEGIN IMMEDIATE`, re-reads the ledger and trigger, rejects future/unknown/incompatible shapes,
and commits the trigger replacement with the ledger row. The constructor has no install opt-out:
a future or incompatible ledger refuses before the log serves any write. Main `user_version`
stays 33 and migrations 1–33, independent ledgers 34–39 and the `session_input_artifacts` table
are not edited. Migration 40 replaces only `session_events_policy_insert`; its v1/v2/reasoning
clauses are verbatim, and its v3 branch checks every `json_each` item, the exact UTF-8 inline
bound, unique ids, the text media type, exact excerpt bytes and same-session metadata matching.

On read, each v3 item is projected independently with the current registry. An artifact excerpt
is bounded again after marker expansion and gets exact `excerptBytes`; a queue id or artifact
reference that would be rewritten by a late-registered value fails closed with
`stored_data_invalid`. Inline text that expands above 16 KiB after a late registration is a
content-free failure, not executable truncation: the stored payload and pending input remain
unchanged and no cursor, prompt or dispatch advances. Queue snapshots never enter FTS:
`search_text` stays `NULL` and queue text is not searchable. The REST/SSE boundary reports the
actual required envelope version (2 for v1-only readers meeting v2, 3 for max-2 readers meeting
v3); export bodies are 1/2/3 by the highest exported event and a smaller requested maximum is a
406 before any partial body.

## Guarantees and where they are enforced

| Property | Enforcement | Test |
| --- | --- | --- |
| Gap-free `seq` per session, no duplicates | an event is inserted only at `last_seq + 1`, and inserting it advances the head (triggers); the head moves only onto an existing event; `UNIQUE (session_id, seq)`; the envelope is validated before the insert, so a caller that catches a refused append and commits leaves no gap | `session-log.test.ts` (append-only schema, gap test) |
| Single writer (D-116) | one open `SessionHandle` per session per process; a `session_writers` row with an epoch; the database refuses an event whose epoch is not the current unreleased one | `session-log.test.ts` (single writer) |
| A writer changes only by grant, release, expiry or handover from a gone process | `acquireWithin`; the epoch may only move to the next value, a released epoch cannot resume and a writer row goes only with its session (triggers); each change appends `writer.acquired` with its reason | same, `session-log-review.test.ts` |
| Crash at any append point leaves the event fully present or fully absent | one `BEGIN IMMEDIATE` transaction advances the head, inserts the event and indexes it (FTS5 triggers); the mirror shares the Job transaction | `session-log-crash.test.ts` (in-process throw and child `SIGKILL` at every point) |
| A retried append is not a duplicate | `idempotencyKey` (`UNIQUE (session_id, idempotency_key)`) or `expectedSeq` returns the stored event | same |
| A v3 queue snapshot commits all descriptors or none | the strict append schema is parsed before use; every descriptor is resolved and the published snapshot validated inside the one append transaction; the database trigger re-checks every item and metadata row | `session-log-queue-artifacts.test.ts` |
| A reader never advances past an envelope it cannot parse | `read()` returns the unsupported `seq` with the actual `requiredVersion`; REST refuses the page, SSE emits preceding supported frames and then a `guanxi-error` with no event id; export refuses before a partial body | `session-log-version-negotiation.test.ts`, `session-log-queue-artifacts.test.ts` |
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

`GET /api/sessions/:id/events` accepts `eventVersion` 1–3 (default 1) and
`GET /api/sessions/:id/export` accepts `exportVersion` 1–3 (default 1). A max-1 reader meeting a
v2 event and a max-2 reader meeting a v3 event get a content-free 406 whose
`details.required` is the actual envelope (2 or 3), never a hardcoded 2. The inspector web
client requests max 3 for both paged reads and the live stream and uses export 3. An older
node that rejects `eventVersion=3`/`exportVersion=3` is an unsupported mixed-version pairing for
this client; no mutation or partial-success retry is performed.

## Residuals

- Legacy `job_events.output` and `messages` keep their unscrubbed private Chat payloads; they
  are the execution substrate until R1. The trace, the inspector, exports and the query tool
  never read them.
- Sessions created before migration 29 have no backfilled trace; their trace starts with the
  next turn.
- Native typed `prompt` and `tool.call` inputs above the published 16 KiB representation
  threshold use event version 2: the scrubbed full bytes live in a session-owned
  `session-artifacts/<sha256(sessionId)>` CAS, while the event, FTS, title, search, REST,
  export and the query tool carry only a scrubbed excerpt of at most 8 KiB and a reference.
  The metadata row and event commit in one fenced transaction; a published blob without a row
  is an orphan. Below the threshold v1 is byte-identical. String writes use bounded UTF-8 chunks;
  reads, replay, base64 transport, scrubbing and byte-input snapshot copies remain whole-buffer.
  Chat, K5, assistant output, reasoning, tool results, images and model requests remain on their
  current paths.
- Q0 adds the v3 queue contract, migration 40, atomic log append/read/privacy support, export 3
  and an inspector renderer. The native producer still writes v1 `agent.queue`. Q1 adds the
  native restricted reader: executable queue state, progress2, verified full-byte consumption
  and a typed 409 for add/remove over a pending v3 snapshot (see the
  [native README](../native-agent/README.md)); Q0+Q1 is the restricted reader rollback floor,
  and the producer round Q2 is still open. Legacy v1 queue events remain readable and are not
  rewritten in place; an old immutable inline snapshot can still be larger than the published
  excerpt bound, and the inspector shows a bounded preview rather than the full tail.
- Queue FTS remains `NULL`: queue text is not searchable, and no queue-tail hydration or
  artifact download endpoint exists. Prompt titles/search retain their existing v2 behavior.
- Other large payloads are still stored inline; ADR-0023 §4 remains proposed, not accepted.
  Output paging still reads and scrubs a whole artifact in memory, command tails beyond the
  explicit 64 KiB bound stay discarded, and a published orphan of a live session is not
  reclaimed until the whole session is deleted. A future per-blob GC must hold the K2 writer
  fence and re-check the `(session_id, checksum)` row before removing a blob.
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
- Native agent sessions now have a Thread owner and coordinated retention/deletion through
  K4; see the [native lifecycle](../native-agent/README.md#durable-execution-and-retention-k4f2).
  Other unowned agent sessions remain undeletable.

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

## Bounded string input encoding

`input-encoding.ts` creates a fresh async iterator for each pass. Every yielded chunk is at most
64 KiB and owns an unpooled backing buffer; the iterator does not mutate a chunk after yielding
it. `SessionInputStore.write()` hashes a string through one bounded pass and pulls a fresh
transport iterator only after the pinned helper's identity handshake is validated. The first
hash pass necessarily encodes chunks before that handshake, so this is not a claim of zero
encoding before validation; the deferred part is the transport iterator. Byte inputs keep the
existing snapshot copy.

`utf8Excerpt()` scans only the requested UTF-8 prefix. It returns the original string when the
whole value fits, preserving complete lone surrogates, and drops a partially included known
redaction marker whole instead of splitting it; ordinary decorative or unmatched `⟦` text stays
in the prefix. A zero bound is valid; a malformed or negative bound fails with a content-free
`invalid_input` error. The requested bound is a representation request, not a total input limit.

Reads, replay, base64 helper transport, scrubbing, provider history, byte-input copies and queue
events remain whole-buffer. The 64 KiB value is a transport chunk, not a total input or process
memory cap.

## Current-registry v2 excerpt projection

`excerpt.ts` protects prompt/tool-call input excerpts using the stored original byteSize,
excerptBytes and UTF-8 length before any replacement. A known right-truncated excerpt uses
the scrubber's private prefix capability, including a one-character boundary fragment.
If an excerpt already contains a stored marker, append-time expansion may have erased byte
proof of an earlier cut; its boundary is conservatively protected as ambiguous too. This
can redact an otherwise ordinary matching suffix in that affected excerpt. List/summary titles derive from that protected excerpt before their title cut. Event reads,
export and each outward SSE frame apply the same current-registry projection; an earlier
read does not pin an obsolete redaction registry. Search may use FTS to nominate candidates,
but rebuilds v2 searchable text from the safe event before matching surviving terms or
cutting a snippet. Complete v1 messages retain their exact-match behavior.

Projection recomputes excerptBytes, respects the existing 8-KiB UTF-8 bound and drops an
expanding marker whole if it cannot fit. It never reads full artifacts or writes payloads,
hashes, FTS rows, event IDs, versions or sequence numbers. With an older scrubber port missing
the optional capability, only known-truncated or marker-ambiguous excerpts become empty; ordinary complete
excerpts and other session metadata remain available. Stored forensic erasure and arbitrary
unknown message cuts are not provided by this read-only projection.
