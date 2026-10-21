# K4 input artifacts — next vertical slice (planning only)

**Status:** proposed; revised after independent review; root re-check required before implementation. **Base:** code `5e9bbfe9c693baa54270e77cb55b558e78575fee`; reviewed plan `52397bb` on `codex/k4-input-artifacts` · **Updated:** 2026-10-22
**Scope:** this plan file only; no production, status or handoff edit. No install, test, build, typecheck, browser gate, model, SSH or owner-data access ran: this clone has no `node_modules`, and the task forbids those checks. The scoped commands below are the implementation worker's planned envelope; the root runs the browser and full gates.

## Explicit plan

1. Land red tests first: large prompts/tool arguments are stored and indexed inline
   (`packages/server/src/native-agent/service.ts:338-342`, `packages/server/src/session-log/log.ts:241-256`) and replay reads only that inline text (`service.ts:370-386`).
2. Add backward-compatible event v2 for native `prompt`/`tool.call`, plus explicit REST/export/SSE
   version negotiation and a typed old-client compatibility error. Keep export v2 conditional.
3. Append migration **33** for session-owned input-artifact metadata; never touch 32 or main 34–37.
4. Reuse the existing pinned-directory primitive for a session-scoped SHA-256 store; do not trust
   an lstat preflight walk or an absolute final-file `O_NOFOLLOW`.
5. Produce v2 only above the published inline threshold, only from the native producer; keep full
   content for execution/replay, never for SQLite, FTS, logs, export or query.
6. Teach log, projection, inspector, query and export consumers the excerpt/reference rule.
7. Prove crash ordering, stale-writer safety, cascade/restart recovery, stop/unload sealing,
   late-secret redaction, legacy reads and old-client rejection; then hand off. Keep
   K4-INPUT-ARTIFACTS open for shell-tail recovery and bounded-memory paging (below).

## Producer scope and non-goals

- The only producer is `NativeAgents` for native `prompt` and `tool.call`. Chat messages through
  `ChatSessionMirror`/`JobStore`, K5 external-agent inputs, delegated/remote prompts,
  `assistant.message`, `reasoning`, `tool.result`, model requests containing image bytes and model
  outputs remain on their current path in this slice (`tool.result` keeps `NativeOutputs`). They may
  not import or write `SessionInputStore`.
- This is not a full K2 artifact claim. No REST route returns full input bytes; inspector, person
  export, local query and remote query receive only the excerpt/reference. `tool_output_read`
  remains output-artifact-only. No new content audience is invented.
- ADR-0023 §4 remains **proposed**, not accepted. The lane's authorized K4 migration scope
  (main ledger 32–33) is sufficient authorization; no new owner approval flow is proposed.

## Current truth, accepted policy and contradictions

- Accepted: reasoning may live only in the local session log, never exports or plain logs (D-113,
  `docs/decisions/2026-10-19-owner-decisions.md:34`). Known secrets are exact-match redacted in model context, logs, traces, exports and audit views (D-141, `docs/decisions/2026-10-20-owner-decisions-addendum.md:18`). Sessions have one writer (D-116, `docs/decisions/2026-10-19-owner-decisions-addendum.md:16`). Access modes add no storage/audience exception (ADR-0027:31-46).
- ADR-0023 is proposed, with only reasoning capture accepted by D-113
  (`docs/decisions/0023-session-event-log-and-tracing.md:3,29-35`). Its §4 — large payloads go to content-addressed artifacts; the event carries hash and bounded excerpt (:34) — is the only coherent target, not accepted policy; do not label it accepted.
- Defaults that are not input ceilings: reasoning retention seven days or the sooner parent TTL
  (`packages/server/src/session-log/log.ts:44-45,1161-1166`); native retention Keep / seven-day TTL / Session (`packages/server/src/native-agent/README.md:185-191`); tool/command output 64 KiB (`packages/server/src/native-agent/sandbox-protocol.ts:17,20-30`); output page 8 KiB (`packages/server/src/native-agent/outputs.ts:9`); attachment transport 32 MiB (`packages/server/src/artifacts/transfer-service.ts:15-17,176-189`). No accepted input-size cap.
- Contradictions, recorded not rewritten: K4 evidence still lists retention/input artifacts as open
  (`docs/plans/evidence/K4.md:55,396-400`), while follow-up 2 records retention and R1 integration implemented with migration 32 (`docs/plans/evidence/K4-followup-2.md:8-21`). K4 says no K4 shared migration (`K4.md:107`), but 32 exists (`packages/server/src/native-agent/schema.ts:1-2`, `packages/server/src/store/db.ts:1501-1502`). `PHASE_STATUS.md:195` is stale; only the root may fix it. Native and session-log READMEs correctly say input artifacts are unfinished (`native-agent/README.md:145-150`, `session-log/README.md:117-118`).
- Current path: `prompt` stores `text` inline and `tool.call` stores `arguments` inline
  (`packages/contract/src/events/session-events.ts:105-135`); the agent appends them directly (`service.ts:338-342`), replay consumes them inline (`service.ts:370-386`), and FTS indexes full values (`log.ts:241-256`). `NativeOutputs` only artifactizes oversized *results*, pages at 8 KiB, and re-scrubs the whole file (`outputs.ts:18-38`); command tails past 64 KiB are deliberately discarded (`sandbox-protocol.ts:20-30`; K4 evidence `:102-103`).

## Decision: session-owned store, not the legacy ArtifactStore

The legacy store cannot own inputs: `artifacts` is project/projectless with no session or Thread
owner, fixes `retention_mode='keep'`, reports `gc.state='not_implemented'`, and its triggers forbid
deleting artifacts or referenced blobs (`packages/server/src/store/db.ts:1173-1219,1288-1311`;
`packages/contract/src/artifacts.ts:35-47,61-77`). Its 32 MiB policy is attachment transport, and its export surface is attachment download, not session export (`packages/server/src/http/artifacts-routes.ts:285-317`). Adding nullable session columns would mean rewriting settled immutability/delete triggers.

Use a new `SessionInputStore` under the session owner:

- Root `dataDir/session-artifacts/<sha256(sessionId)>/`, directory `0700`, file `0400`, filename the lowercase SHA-256 digest. The directory key is derived, never a user path, display name or raw UUID.
- New `session_input_artifacts` table owned by K2: `artifact_id` primary key, `session_id REFERENCES sessions(id) ON DELETE CASCADE`, `checksum`, `byte_size`, `media_type`, `created_at`, `UNIQUE(session_id, checksum)`. It is resolved/inserted in the **same SQLite transaction** as its event; the row is inserted first and the event carries the resolved ID, so an existing `(session_id, checksum)` reuses its row/ID and both commit or roll back together.
- Native deletion adds this path beside scratch, copied attachments and `native-output` (`packages/server/src/native-agent/sessions.ts:77-80`). Trash/TTL keeps bytes; explicit delete and the 24-hour Session recovery remove them; rows cascade with the owning session.
- Full bytes are internal to the session log for replay. No REST route returns them in this slice. That avoids inventing an artifact-content audience.

## Compatible wire contract and explicit negotiation

Keep every v1 event byte-identical. Add v2 only for the two input-bearing types:

```ts
// Published representation policy, not an acceptance cap.
const INPUT_INLINE_BYTES = 16 * 1024
const INPUT_EXCERPT_BYTES = 8 * 1024
const inputArtifactRef = z.object({
  artifactId: z.string().uuid(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  byteSize: z.number().int().positive().safe(),
  mediaType: z.enum(['text/plain; charset=utf-8', 'application/json']),
  excerpt: z.string(),            // scrubbed, valid UTF-8, <= INPUT_EXCERPT_BYTES bytes
  excerptBytes: z.number().int().nonnegative().max(INPUT_EXCERPT_BYTES).safe(),
}).strict().refine((v) => new TextEncoder().encode(v.excerpt).byteLength === v.excerptBytes)
// version:2 envelope; no full `text`/`arguments` field exists to misuse as content.
promptV2.data   = { origin, messageId, attachmentCount, artifact: inputArtifactRef }
toolCallV2.data = { toolCallId, name, source, parsedFrom, diffPath, artifact: inputArtifactRef }
```

- `INPUT_INLINE_BYTES` decides representation only. Measure the **scrubbed canonical bytes** (prompt UTF-8; tool arguments `JSON.stringify(scrubbed arguments)`). At or below it, v1 is unchanged. Larger inputs are fully accepted and stored. There is **no new total input cap**; threshold, excerpt and page bound are not acceptance limits. Acceptance remains bounded by existing HTTP transport and model/runtime context, named in the error surface rather than invented.
- `sessionEventSchema` unions existing v1 shapes with v2 prompt/tool-call shapes. `sessionEventTypeSchema`, classes and v1 data schemas stay. Append gains optional `eventVersion: 1 | 2` and an `inputArtifact` descriptor carrying checksum, size, media type and excerpt; v2 requires both, append resolves/inserts the row first and writes its resolved `artifactId` into the event data, and v2 for any other type is rejected.
- Explicit negotiation, because parser rejection alone is not wire compatibility: `eventVersion` on `/events` and `/stream`, `exportVersion` on `/export`, each an integer 1–2 with default **1**. The value is the maximum the client can parse. The current web client asks for 2; an old client that omits it asks for 1 and keeps receiving v1.
- REST `/events` with max 1 whose next page contains a v2 event returns HTTP 406 `session_event_version_unsupported` with content-free details `{ seq, supported: 1, required: 2 }`; it returns **zero** events and no `nextAfter`, so the cursor cannot advance past the unread v2. `/export` with max 1 returns the same 406 and no export body when any v2 event exists; a v1-only session exports `exportVersion: 1` identically, and a session with any v2 returns `exportVersion: 2` to a max-2 client.
- SSE: if the first unread event is a v2 event and the client asked for max 1, the route returns the 406 JSON before opening the stream. If an already-open max-1 stream encounters the first v2 event, it emits `event: guanxi-error` with that ApiError and **no `id:` line**, then closes; the client's `Last-Event-ID` remains the last v1 seq, no v2 payload is read and the sequence is not silently advanced. `sseStream` (`packages/web/src/lib/sse.ts:139-258`) parses `guanxi-error` into a typed non-retryable error instead of passing it to `onInvalidFrame`; the inspector shows an incompatible state, not a reconnect loop. A client too old to parse the error frame still sees the stream end without an id for the unread event and must not retry; an older REST/export build sees the 406 and cannot advance, while an updated client parses the typed code.
- Contract changes: `SESSION_EVENT_VERSION` stays the v1 literal; add an explicit v2 literal and maximum; add `sessionExportQuery` and the v2 export branch; add `session_event_version_unsupported` to `apiErrorSchema` (`packages/contract/src/schemas.ts:3304-3350`). Do not add fields to v1 response envelopes: old strict parsers must still parse v1 pages unchanged. Routes are `packages/server/src/session-log/routes.ts:185-210,224-244,246-313`; client calls are `packages/web/src/features/inspector/api.ts:59,62-95`.
- Search, titles, projection and FTS use **only** `artifact.excerpt`; full bytes never enter SQLite, FTS, events or logs. Search therefore cannot find text beyond the excerpt. The inspector labels the excerpt as bounded and names the local artifact.
- Reasoning is unchanged: inline K2 `reasoning` class, seven-day/sooner expiry, remote SQL exclusion, export exclusion and purge (`log.ts:694,1161-1166`; `routes.ts:224-243`). It needs no class-separated store while it is local-only.

## Native execution, replay and ordered appends

- Prompts: `create`/`prompt` keeps the full string for the current model call (`service.ts:246-258,279-311`). One FIFO per active native session serializes every native trace append from the service; queued operations carry closures, not precomputed sequences. An artifact-bearing operation writes the artifact, then in one transaction resolves/inserts its metadata and appends v2. If the scrubber is not ready, neither artifact nor event is written. Consumed queued prompts use the same path.
- Tool arguments: at assistant `message_end`, canonicalise `JSON.stringify(scrubbed arguments)`, artifactize above threshold, append v2. The FIFO makes `tool.call` commit before `tool.result`; `expectedSeq` and any idempotency key are computed when the append executes, not when it was queued (`service.ts:275-277,335-350`).
- Each operation rechecks both fences at commit: R1 `runs.checkExecution(attempt)`/the fenced append (`packages/server/src/runs/store.ts:327-334,346-377`) and K2's writer epoch in `SessionLog.appendWithin` (`log.ts:1089-1125`). Check before starting an artifact write and again immediately before the SQLite transaction; a fenced/stopped operation appends nothing and leaves any published blob as an orphan.
- Terminal order: enqueue `agent.state`/`turn.done` as the final FIFO operations, **seal** the queue at that enqueue, drain it, then run R1 `complete`; later callbacks are rejected. `stop()` enqueues `intervention` before abort; `close()` seals, aborts, waits for `active.settled`/queue drain, then closes handles. No native trace event is written after the terminal pair; only R1's own terminal `run.lifecycle` may follow.
- Storage failure while callbacks continue: abort the turn with typed `input_artifact_storage_failed`, reject later enqueues, append one content-free `error` plus terminal if SQLite is writable, and mark R1 failed. No v2 event is invented and no native trace callback may append after the terminal.
- Replay becomes async: resolve each v2 reference through `SessionInputStore`, verify session, size and SHA-256, re-scrub full bytes with the current scrubber, parse JSON arguments, then rebuild `AgentMessage`s (`service.ts:370-386`). Missing/corrupt/foreign artifacts fail the continuation with a content-free error; the excerpt is never execution input. `prompt` and the queued-history path await replay; `native-agent/routes.ts:30` and the plugin binding become async accordingly.
- Images remain attachment bytes in the model request (`service.ts:319-324`); this slice does not put model-request image bytes into session events.

## Crash consistency, parent-directory trust and cleanup

1. Scrub full prompt/arguments; refuse while `egress.scrubber` is not ready.
2. Create the temp under the session path after identity validation (random name, `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`), hash while writing, `fsync`, close. Publish by passing only its **basename** to the pinned helper, which hard-links it relative to its verified cwd; after the link the helper opens the digest and verifies its size/hash (whether new or existing), `fsync`s the directory and unlinks the temp. If the path changed before creation, the helper cannot resolve the basename and the operation fails; if it changed after, the helper's cwd remains the original directory. No partial file is addressable by a digest.
3. Reuse the ArtifactStore pinned-helper/directory-identity pattern rather than a preflight lstat walk: `RELATIVE_FILE_HELPER` (`packages/server/src/store/artifacts.ts:34-96`), `directoryIdentity` (`:262-272`) and `relativeFileOperation` (`:274-350`). Spawn a short-lived helper with `cwd` = the validated session directory; it reports `cwd`, `stat('.')` dev/ino; compare with lstat+realpath identity and reject symlink/non-directory/mismatch. All helper `link`, `open` and directory `fsync` operations use relative names with `O_NOFOLLOW`; re-check the directory identity after the operation. Extract this primitive to `packages/server/src/store/pinned-directory.ts` rather than copying it. A replaced parent after validation cannot redirect the helper's cwd-relative operation; an identity mismatch is a typed unsafe-storage failure with no absolute-path fallback.
4. In one `BEGIN IMMEDIATE` transaction with the session writer fence: resolve/insert `session_input_artifacts`, then insert the event carrying that ID. A crash before commit leaves no row and no event; after commit, both. A published blob without a row is an orphan, never a referenced half-state.
5. **Never unlink a published digest in an append-failure catch path.** A stale writer can publish digest D, lose its lease, and a successor can reuse D, insert the row and commit its event before the stale catch runs; unlinking D would corrupt a referenced artifact. Only the unique, non-addressable temp file created by the failing call may be unlinked. This slice does not do per-blob GC: a published orphan lives until its whole session directory is removed by explicit delete/TTL recovery, or by restart reaping of a directory whose `sessions` row is absent. A future per-blob GC must acquire the K2 session-writer fence and re-check the `(session_id, checksum)` row after acquiring it; the row is the only refcount.
6. Orphans and cascade: `NativeSessions.remove` (`sessions.ts:82-128`) persists the deletion intent first, then removes every session path; a crash retries the intent on the next maintenance pass. The generic Thread-delete guard still refuses direct native Thread deletion (`native-agent/schema.ts:42-45`); a DB cascade or Chat-retention `DELETE FROM threads` (`store/threads.ts:331`, `store/chat-retention.ts:425`) removes rows but has no filesystem hook, so maintenance/reap must scan `session-artifacts`: compute `sha256(sessionId)` for every `sessions` row plus in-process `preparing`/`active` IDs, and for a directory with no match, atomically rename it to a random quarantine name in the same parent, re-check under the R1 home fence that no session row/writer exists, then remove it. If a session row appeared, keep the renamed directory as an orphan and never merge it into the new session. Stale `.tmp-*` files are removed only when the session has no live writer and the file is older than a grace period. No resumable session may survive with missing input bytes: the persisted deletion intent and `assertAvailable` block continuation.
7. Read verifies session, checksum and size through the same pinned helper, re-hashes and re-scrubs full bytes before excerpt/page/replay; when re-scrubbing changes the excerpt, recompute `excerptBytes` in the returned projection without mutating the stored payload. Unknown IDs, wrong sessions, symlinks, replaced parents and tampered bytes return typed content-free errors. No path, prompt fragment, secret value or raw error in errors/logs.

**Residuals retained:** output paging still reads and scrubs a whole artifact in memory (`outputs.ts:28-37`); a streaming scrubber is a separate kernel change. Command tails beyond the explicit 64 KiB bound stay discarded and are not recoverable. A published orphan left by a failed append in a live session is not reclaimed until that session is deleted; per-blob GC is deliberately out of this slice. The handoff must keep K4-INPUT-ARTIFACTS open for these items rather than claim the canonical issue closed.

## Migration 33 and rollback

The main node ledger ends at 32 (`db.ts:1495-1502`). This slice appends **33**, the last K4 main-ledger slot. Independent reservations **34** (F1 federation ledger, `packages/server/src/federation/schema.ts:4`), **35** (R2 relay ledger, `packages/server/src/relay/store.ts:12`), and **36–37** (other lanes; F2b reserves 37) are untouched; never renumber into them. If main already consumed 33 before merge, stop and take a new root-assigned main slot before any user database applies it; never reuse 34–37.

Migration 33 creates `session_input_artifacts` and its index and replaces only `session_events_policy_insert` so `event_version IN (1,2)`, v2 is limited to `prompt`/`tool.call`, the payload has an `artifact` object, no `text`/`arguments` key, and its referenced row exists for the same session. It rewrites no rows, tables, search text or migration 32. Legacy sessions read byte-identically and still append v1. Rollback restores a stopped pre-upgrade SQLite/WAL backup; never a down migration or table drop under a running node. A failed migration rolls back and retries. An older binary on a 33 database ignores the new table and can append v1, but cannot parse v2 events or exports; it gets the explicit negotiation error rather than a parse crash.

## Code ownership and dependency order

| Order | Path | Change |
| --- | --- | --- |
| 1 | `packages/contract/src/events/session-events.ts` | v2 prompt/tool-call data, input ref, union, version helpers |
| 2 | `packages/contract/src/events/inspector.ts`, `packages/contract/src/schemas.ts` | `eventVersion`/`exportVersion`, export v1/v2 branch, 406 error code |
| 3 | `packages/server/src/session-log/schema.ts` | migration 33 table/index and policy-trigger replacement |
| 4 | `packages/server/src/store/db.ts` | append migration 33 only |
| 5 | `packages/server/src/store/artifacts.ts`, `packages/server/src/store/pinned-directory.ts` (new) | extract/reuse helper, identity and relative publish/read |
| 6 | `packages/server/src/session-log/input-artifacts.ts` (new) | session store write/read/verify/reap |
| 7 | `packages/server/src/session-log/log.ts` | version-aware append, atomic artifact row, excerpt FTS/title |
| 8 | `packages/server/src/session-log/projection.ts` | v2 excerpt projection |
| 9 | `packages/server/src/native-agent/service.ts`, new `append-queue.ts` | FIFO, fence rechecks, async replay, seal/drain |
| 10 | `packages/server/src/native-agent/routes.ts`, `plugin.ts`, `sessions.ts` | await prompt/replay, deletion path and reaper |
| 11 | `packages/server/src/session-log/routes.ts` | REST/export 406, SSE error frame without `id` |
| 12 | `packages/web/src/features/inspector/api.ts`, `packages/web/src/lib/sse.ts` | request max 2, parse `guanxi-error`, typed non-retry |
| 13 | `packages/web/src/features/inspector/model.ts`, `InspectorPage.tsx`, `packages/web/src/lib/locale.ts` | excerpt/reference rendering and incompatible state, EN/RU keys |
| 14 | `packages/server/test/session-log-input-artifacts.test.ts`, `session-log-version-negotiation.test.ts`, `session-log-routes.test.ts`, `native-agent/input-artifacts.test.ts`; `packages/web/test/component/inspector.test.tsx`, `sse-terminal.test.tsx`; both READMEs | route/store/native/web tests, limits, exact residuals |

Rows 2 and 11–14 are the contract/route/client/test ownership; no route change lands without all
four. Rows 1–10 precede them in the dependency order.

Do contract, migration/store, log, native producer/replay, routes/client, consumers, docs in that
order. Update only current-version markers, not historical migration bytes, in `migration.test.ts`,
`session-log.test.ts`, `durable-run-migration.test.ts`, `relay/schema.test.ts`,
`reasoning-artifact*.test.ts`, `native-agent/migration.test.ts` and `job-migration.test.ts`.
No dependency, token, catalog or central status edit is required. Shared edits to list in the
handoff: the contract event/export/error surface, the migration ledger and the extracted storage
helper.

## Assertions (18) and exact commands

| # | Meaningful negative assertion |
| --- | --- |
| 1 | After validation, rename the session directory and put a symlink to an attacker directory at the same path: publish/read returns a typed unsafe-storage error, **no published digest** exists there and no attacker bytes are returned; any stray temp is unaddressable and cleaned. A preflight-lstat/absolute-`O_NOFOLLOW` implementation fails this. |
| 2 | Stale-writer successor interleaving: A publishes D and loses its lease; B reuses D, inserts the row and commits an event; A's append raises `writer_fenced`, D still exists, B's replay returns the exact bytes, and the unlink count for D is **zero**. |
| 3 | Append failure leaves the published D and any existing row untouched; only the failing call's temp file is gone, and a retry reusing D succeeds. A catch path that unlinks D fails this assertion. |
| 4 | A max-1 REST page whose range contains the first v2 event returns HTTP 406 `session_event_version_unsupported`, **zero** `events`, no `nextAfter` and unchanged cursor; no v2 payload bytes appear in the body. |
| 5 | A max-1 export of a session containing v2 returns the same 406 with **no** export body and no successful `exportVersion`; a v1-only export is byte-identical apart from `exportedAt`. |
| 6 | An already-open max-1 SSE stream that reaches the first v2 event emits `guanxi-error` with **no `id:` line**, no v2 data; the captured `Last-Event-ID` stays at the last v1 seq; the current client throws a typed non-retryable error and does not call `onInvalidFrame`; a v1-only stream's frames are unchanged. |
| 7 | Native-only scope: a Chat job and a K5 external-agent input each above 16 KiB produce **zero** v2 events, zero `session_input_artifacts` rows and zero `session-artifacts` directories; the migration trigger rejects a v2 `assistant.message`. |
| 8 | Direct `DELETE FROM threads` for a native session is refused by the guard; after the coordinated native deletion, artifact rows are zero and the next maintenance removes the directory. `SIGKILL` mid-remove plus restart retries the persisted intent, `assertAvailable` stays expired and no resumable session has missing bytes; a stale temp is removed but a published orphan is not. |
| 9 | Storage failure while three tool callbacks keep arriving yields exactly one content-free `error` and one terminal, **zero** v2 events, zero native trace events after `turn.done` (only R1's terminal `run.lifecycle` follows), R1 state `failed`, a closed handle and rejected later enqueues. |
| 10 | A stale R1 attempt and a stale K2 writer epoch each commit zero rows and zero events; if a blob was already published it remains an orphan and is not unlinked; the successor's read succeeds. |
| 11 | A prompt and a `tool.call` over threshold produce `version:2`, no `text`/`arguments` key, a scrubbed excerpt of at most 8 KiB with correct hash/size, and full content is absent from `session_events`, FTS, title and JSONL logs. |
| 12 | Replay sends the **full** prompt and tool arguments byte-identically, not the excerpt; exactly 16 KiB stays v1, 16 KiB + 1 byte becomes v2, and a 1 MiB input is not rejected by the threshold or the 32 MiB attachment policy. |
| 13 | Missing, wrong-session, symlinked, replaced-parent, truncated and checksum-mismatched artifacts fail closed with a content-free error; no partial replay, path or private digest is returned, and the excerpt is never used as execution input. |
| 14 | A secret registered after write is redacted on excerpt read, across the 8 KiB boundary, in export and in replay; no page returns the late value. |
| 15 | A v2 export has `exportVersion:2`, zero full content and zero reasoning; local/remote query return only references/excerpts, remote still excludes reasoning; a v1 session exports `exportVersion:1` with identical events. |
| 16 | Migration 33 applies to 32, fails/rolls back atomically, reopens idempotently, leaves v1 rows and migrations 1–32 unchanged; a v1-only parser rejects a v2 event/export explicitly; the main ledger is 33, while independent 34–37 remain untouched. |
| 17 | Reasoning stays inline class `reasoning`, expires/purges as before, is absent from person export, remote query and provider history, and creates zero reasoning artifacts. |
| 18 | `stop()` enqueues `intervention` before the terminal and `close()` seals/waits: no native trace event commits after the terminal pair or after a sealed handoff (only R1's terminal `run.lifecycle` follows); late callbacks are rejected and a drained queue leaves no uncommitted v2 row. |

Implementation worker first lands failing versions of 1, 2, 4, 6, 7, 8, 9 and 10. Focused commands
(Node 26, `nice -n 10`; no install, full suite, browser gate or build here):

```bash
nice -n 10 node --test packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/native-agent/agent.test.ts
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
```

The root runs the browser gate for the inspector change and the full core/web envelopes. This
planning checkout ran none of them.

## UI, CLI and acceptance

- Inspector component test: a v2 prompt row shows the excerpt and an explicit “full input stored locally; not included in this event/export” label; the full tail/marker is absent; a search term only beyond the excerpt returns no hit. This is a DOM/text assertion, not a visibility claim. An incompatible stream shows the typed compatibility state, not a silent stop.
- Browser assertion: the v2 fixture survives reload and replay exactly once, with no duplicate event and no console/storage secret; the root runs it.
- CLI `agent exec --json` keeps its five-field snapshot and sends the full prompt; stdout contains no prompt bytes. The server-side fixture test, not the CLI process, proves the v2 event and full replay. `packages/cli/test/agent-exec.test.ts` is regression, not new evidence.
- Sandbox, platform and live-model scope are unchanged; no new runtime claim.

## Owner decisions and commit

No new owner decision or approval flow is required. The authorized K4 migration scope (main 32–33)
covers migration 33. Engineering defaults: 16 KiB inline representation, 8 KiB excerpt/page,
session-owned per-session CAS, excerpt-only export/query, explicit version negotiation, and no total
input cap. ADR-0023 §4 remains proposed; do not label it accepted. This docs-only revision is
`docs(k4): fix input artifact plan after independent review` (no code, no test result, no handoff
claim).

## Review-fix (2026-10-22)

Independent review `../../../../reviews/codex-k4-input-plan-20261022.md` (root GPT,
planning source `52397bb`) found three blocking gaps and three clarifications. This revision keeps
the proposed status, base and no-check statement and corrects the plan only:

- Parent trust: replaced the lstat-walk/absolute-final-`O_NOFOLLOW` claim with the existing ArtifactStore pinned-helper/directory-identity primitive and assertion 1.
- Stale-writer cleanup: published digests are never unlinked by a failing writer; only temp files are removed. Assertion 2 covers the successor-reference interleaving; per-blob GC is deferred and fenced.
- Old-client compatibility: added explicit `eventVersion`/`exportVersion` negotiation for REST, export and already-open SSE, with a typed 406/`guanxi-error`, no `id:` on the unread event, updated routes/client tests and an incompatible inspector state.
- Clarifications: producer scope is native prompt/tool.call only; cascade/Thread/restart recovery and the R1/K2-fenced, sealed, drained queue are defined; assertions 7–10 cover them.
- Migration slots 33 versus independent 34/35/36/37 are preserved; no new owner approval flow.

**Pin:** this docs commit on `codex/k4-input-artifacts`, parent `52397bb`; no production, install,
test or gate ran. The root verifies the exact `git rev-parse HEAD` and an empty `git status`.
