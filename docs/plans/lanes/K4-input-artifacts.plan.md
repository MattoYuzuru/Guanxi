# K4 input artifacts — next vertical slice (planning only)

**Status:** proposed; root GPT review required before implementation · **Base:** clean
`5e9bbfe9c693baa54270e77cb55b558e78575fee` on `codex/k4-input-artifacts` · **Updated:** 2026-10-22
**Scope:** this plan file only; no production, status or handoff edit. No dependency install, test,
build or browser gate ran: this clone has no `node_modules`, and the task forbids those checks here.

## Explicit plan

1. Land red tests first: large prompts/tool arguments are stored and indexed inline
   (`packages/server/src/native-agent/service.ts:338-342`, `packages/server/src/session-log/log.ts:241-256`) and replay reads only that inline text (`service.ts:370-386`).
2. Add backward-compatible event v2 for `prompt` and `tool.call`, plus export v2.
3. Append migration **33** for session-owned input-artifact metadata; do not touch 32.
4. Add a session-scoped, content-addressed store with explicit write/read/hash/trust rules.
5. Produce v2 only above the published inline threshold; keep full content for execution/replay.
6. Teach log, projection, inspector, query, export and CLI to use the excerpt, never as full content.
7. Prove crash ordering, late-secret redaction, legacy reads, retention/deletion and stale-client
   rejection; then hand off. Keep K4-INPUT-ARTIFACTS open for shell-tail recovery and bounded-memory
   paging (below).

## Current truth, accepted policy and contradictions

- Accepted: reasoning may live only in the local session log, never exports or plain logs (D-113,
  `docs/decisions/2026-10-19-owner-decisions.md:34`). Known secrets are exact-match redacted in model context, logs, traces, exports and audit views (D-141, `docs/decisions/2026-10-20-owner-decisions-addendum.md:18`). Sessions have one writer (D-116, `docs/decisions/2026-10-19-owner-decisions-addendum.md:16`). Access modes add no storage/audience exception (ADR-0027:31-46).
- ADR-0023 is **proposed**, with only reasoning capture accepted by D-113
  (`docs/decisions/0023-session-event-log-and-tracing.md:3,29-35`). Its §4 — large payloads go to content-addressed artifacts; the event carries hash and bounded excerpt (:34) — is the only coherent target, not accepted policy; do not label it accepted.
- Defaults that are not input ceilings: reasoning retention seven days or the sooner parent TTL
  (`packages/server/src/session-log/log.ts:44-45,1161-1166`); native retention Keep / seven-day TTL / Session (`packages/server/src/native-agent/README.md:185-191`); tool/command output 64 KiB (`packages/server/src/native-agent/sandbox-protocol.ts:17,20-30`); output page 8 KiB (`packages/server/src/native-agent/outputs.ts:9`); attachment transport 32 MiB (`packages/server/src/artifacts/transfer-service.ts:15-17,176-189`). No accepted input-size cap.
- Contradictions, recorded not rewritten: K4 evidence still lists retention/input artifacts as open
  (`docs/plans/evidence/K4.md:55,396-400`), while follow-up 2 records retention and R1 integration implemented with migration 32 (`docs/plans/evidence/K4-followup-2.md:8-21`). K4 says no K4 shared migration (`K4.md:107`), but 32 exists (`packages/server/src/native-agent/schema.ts:1-2`, `packages/server/src/store/db.ts:1501-1502`). `PHASE_STATUS.md:195` is stale; only the root may fix it. Native and session-log READMEs correctly say input artifacts are unfinished (`native-agent/README.md:145-150`, `session-log/README.md:117-118`).
- Current path: `prompt` stores `text` inline and `tool.call` stores `arguments` inline
  (`packages/contract/src/events/session-events.ts:105-135`); the agent appends them directly (`service.ts:338-342`), replay consumes them inline (`service.ts:370-386`), and FTS indexes full values (`log.ts:246-256`). `NativeOutputs` only artifactizes oversized *results*, pages at 8 KiB, and re-scrubs the whole file (`outputs.ts:18-38`); command tails past 64 KiB are deliberately discarded (`sandbox-protocol.ts:20-30`; K4 evidence `:102-103`).

## Decision: session-owned store, not the legacy ArtifactStore

The legacy store cannot own inputs: `artifacts` is project/projectless with no session or Thread
owner, fixes `retention_mode='keep'`, reports `gc.state='not_implemented'`, and its triggers forbid
deleting artifacts or referenced blobs (`packages/server/src/store/db.ts:1173-1219,1288-1311`;
`packages/contract/src/artifacts.ts:35-47,61-77`). Its 32 MiB policy is attachment transport, and its export surface is attachment download, not session export (`packages/server/src/http/artifacts-routes.ts:285-317`). Adding nullable session columns would mean rewriting settled immutability/delete triggers.

Use a new `SessionInputStore` under the session owner:

- Root `dataDir/session-artifacts/<sha256(sessionId)>/`, directory `0700`, file `0400`, filename the lowercase SHA-256 digest. `lstat` each directory and reject symlinks/identity changes; no user path, display name or UUID is a filesystem key.
- New `session_input_artifacts` table owned by K2: `artifact_id` primary key, `session_id`, `checksum`, `byte_size`, `media_type`, `created_at`, `UNIQUE(session_id, checksum)`. It is inserted in the **same SQLite transaction** as its event, so no row exists without a referencing event and no event exists without its row; an existing `(session_id, checksum)` reuses its artifact ID, while a duplicate append verifies the row is present.
- Native deletion adds this path beside scratch, copied attachments and `native-output` (`packages/server/src/native-agent/sessions.ts:77-80`). Trash/TTL keeps bytes; explicit delete and the 24-hour Session recovery remove them; rows cascade with the owning session.
- Full bytes are internal to the session log for replay. No REST route returns them in this slice: inspector, person export, local query and remote query receive the bounded excerpt and reference only. `tool_output_read` remains output-artifact-only; it is not repurposed for inputs. That avoids inventing an artifact-content audience.

## Compatible wire contract

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
  excerptBytes: z.number().int().nonnegative().safe(),
}).strict()
// version:2 envelope; no full `text`/`arguments` field exists to misuse as content.
promptV2.data   = { origin, messageId, attachmentCount, artifact: inputArtifactRef }
toolCallV2.data = { toolCallId, name, source, parsedFrom, diffPath, artifact: inputArtifactRef }
```

- `INPUT_INLINE_BYTES` decides representation only. At or below it, v1 is unchanged. Larger inputs are fully accepted and stored. There is **no new total input cap**; threshold, excerpt and page bound are not acceptance limits. Acceptance remains bounded by existing HTTP transport and model/runtime context, named in the error surface rather than invented.
- `sessionEventSchema` unions existing v1 shapes with v2 prompt/tool-call shapes. `sessionEventTypeSchema`, classes and v1 data schemas stay. Append gains optional `eventVersion: 1 | 2` and an `inputArtifact` descriptor; v2 requires both, and v2 for any other type is rejected.
- Stale clients fail visibly: v2 carries envelope `version: 2`, which a v1-only parser rejects. Export stays `exportVersion: 1` when all events are v1 and becomes `2` when any v2 is present, so a legacy session exports identically and an old parser rejects v2 by its literal. `sessionExportSchema` gains a v2 branch and keeps `excluded: { reasoning }` plus the no-reasoning refinement.
- Search, titles, projection and FTS use **only** `artifact.excerpt`; full bytes never enter SQLite, FTS, events or logs. Search therefore cannot find text beyond the excerpt. The inspector and CLI label the excerpt as bounded and name the local artifact.
- Reasoning is unchanged: inline K2 `reasoning` class, seven-day/sooner expiry, remote SQL exclusion, export exclusion and purge (`log.ts:694,1161-1166`; `routes.ts:224-243`). It needs no class-separated store while it is local-only.

## Native execution and replay correctness

- Prompts: `create`/`prompt` keeps the full string for the current model call (`service.ts:246-258,279-311`). An ordered native append worker writes the artifact then appends v2 before the prompt event; if the scrubber is not ready, neither artifact nor event is written. Consumed queued prompts use the same path.
- Tool arguments: at assistant `message_end`, canonicalise `JSON.stringify(scrubbed arguments)`, artifactize above threshold, append v2. All native appends go through one FIFO so `tool.call` commits before `tool.result`, and `expectedSeq` is computed when the append executes, not when it was queued (`service.ts:275-277,335-350`). Drain the FIFO before terminal `agent.state`/`turn.done` and before closing the handle; a failed artifact write aborts the turn with a typed error rather than dropping the event.
- Replay becomes async: resolve each v2 reference through `SessionInputStore`, verify session, size and SHA-256, re-scrub full bytes with the current scrubber, parse JSON arguments, then rebuild `AgentMessage`s (`service.ts:370-386`). Missing/corrupt/foreign artifacts fail the continuation with a content-free error; the excerpt is never execution input. The current turn still uses the in-memory full value, so a crash before event commit remains the existing R1/K2 boundary, not a silent truncation.
- Images remain attachment bytes in the model request (`service.ts:319-324`); this slice does not put model-request image bytes into session events.

## Crash consistency, trust and cleanup

1. Scrub full prompt/arguments; refuse while `egress.scrubber` is not ready.
2. Write a temp file with `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW`, hash while writing, `fsync`, close, hard-link to the digest name (verify an existing file's size/hash on `EEXIST`), `fsync` the directory, unlink temp. No partial file is addressable by a digest.
3. In one `BEGIN IMMEDIATE` transaction with the session writer fence: insert event, then `session_input_artifacts`. A crash before commit leaves no row and no event; after commit, both. A published blob without a row is an orphan, never a referenced half-state.
4. On append failure, unlink only a blob this call created; a crash leaves an orphan for maintenance. Orphan sweep skips sessions with a live writer, removes only temp files past a short grace, and removes published blobs with no row under the R1 home fence. Session deletion sets the durable intent first, which blocks continuation (`sessions.ts:82-128`), then removes the directory; a crash leaves the intent or an orphan, never a resumable session with missing input.
5. Read verifies session, checksum and size, opens with `O_NOFOLLOW`, re-hashes and re-scrubs full bytes before excerpt/page/replay. Unknown IDs, wrong sessions, symlinks and tampered bytes return typed content-free errors. No path, prompt fragment, secret value or raw error in errors/logs.

**Residuals retained:** output paging still reads and scrubs a whole artifact in memory (`outputs.ts:28-37`); a streaming scrubber is a separate kernel change. Command tails beyond the explicit 64 KiB bound stay discarded and are not recoverable. The handoff must keep K4-INPUT-ARTIFACTS open for those two items rather than claim the canonical issue closed.

## Migration 33 and rollback

The node ledger ends at 32 (`db.ts:1495-1502`); F1 uses independent ledger 34 and R2 uses 35 (`packages/server/src/federation/schema.ts:3`, `packages/server/src/relay/store.ts:11`). F2b reserves **37**. This slice appends **33**, the last K4 slot; if main already consumed 33 before merge, stop and renumber only before any user database applies it.

Migration 33 creates `session_input_artifacts` and its index and replaces only `session_events_policy_insert` so `event_version IN (1,2)` and v2 is limited to `prompt`/`tool.call`. It rewrites no rows, tables, search text or migration 32. Legacy sessions read byte-identically and still append v1. Rollback restores a stopped pre-upgrade SQLite/WAL backup; never a down migration or table drop under a running node. A failed migration rolls back and retries. An older binary on a 33 database ignores the new table and can append v1, but cannot parse v2 events or exports.

## Code ownership and dependency order

| Order | Path | Change |
| --- | --- | --- |
| 1 | `packages/contract/src/events/session-events.ts` | v2 prompt/tool-call data, union, version helpers |
| 2 | `packages/contract/src/events/inspector.ts` | export v1/v2 branches and refinement |
| 3 | `packages/server/src/session-log/schema.ts` | migration 33 table/index and trigger replacement |
| 4 | `packages/server/src/store/db.ts` | append migration 33 only |
| 5 | `packages/server/src/session-log/input-artifacts.ts` (new) | session store write/read/verify/orphan sweep |
| 6 | `packages/server/src/session-log/log.ts` | `eventVersion`, atomic artifact row, excerpt FTS/title |
| 7 | `packages/server/src/session-log/projection.ts` | v2 excerpt projection |
| 8 | `packages/server/src/native-agent/service.ts` | ordered v2 append writer and async replay |
| 9 | `packages/server/src/native-agent/sessions.ts` | session-artifact deletion path |
| 10 | `packages/web/src/features/inspector/model.ts`, `InspectorPage.tsx`, `lib/locale.ts` | excerpt/reference rendering, EN/RU labels |
| 11 | tests and both READMEs | new/regression envelope, limits, residuals |

Do contract, migration/store, log, native producer/replay, consumers, docs in that order. Update only current-version markers, not historical migration bytes, in `migration.test.ts`, `session-log.test.ts`, `durable-run-migration.test.ts`, `relay/schema.test.ts`, `reasoning-artifact*.test.ts`, `native-agent/migration.test.ts` and `job-migration.test.ts`. No dependency, token, catalog, approval or central status edit is required. Shared edits to list in the handoff: the contract event/export surface and the migration ledger.

## Assertions (12) and exact commands

| # | Meaningful assertion |
| --- | --- |
| 1 | A prompt over `INPUT_INLINE_BYTES` produces `version:2`, bounded scrubbed excerpt, valid UUID/hash/size, and no full prompt bytes in `session_events`, FTS, title or JSONL logs. |
| 2 | A large `tool.call` produces v2; replay reconstructs exact scrubbed arguments; a small prompt and small tool call remain byte-identical v1. |
| 3 | A continuation after a v2 turn sends the **full** prompt and tool arguments to the fixture transport, not the excerpt; byte equality is asserted. |
| 4 | Missing, wrong-session, symlinked, truncated or checksum-mismatched artifacts fail closed with a content-free error; no partial replay, path or private digest is returned. |
| 5 | A secret registered after write is redacted on excerpt read, across the 8 KiB boundary, in export and in replay; no page returns the late value. |
| 6 | A legacy session exports `exportVersion:1` with identical events; a v2 session exports `exportVersion:2` with references/excerpts, zero full content and zero reasoning. |
| 7 | The query tool for both audiences returns v2 references/excerpts only; remote still has zero reasoning, local still has reasoning, and neither receives artifact bytes. |
| 8 | Crash points (temp write, publish, before transaction, after event insert, after commit) leave either an orphan blob or a complete event+row; no event references a missing artifact, no duplicate/gap appears. |
| 9 | TTL Trash preserves bytes; explicit delete removes directory and rows; partial deletion recovers from the persisted intent; a second session cannot read the first's artifact. |
| 10 | Threshold edge: exactly 16 KiB is v1; 16 KiB + 1 byte is v2 and accepted in full; a 1 MiB input is not rejected by the threshold or the 32 MiB attachment policy. |
| 11 | Migration 33 applies to 32, fails/rolls back atomically, reopens idempotently, leaves v1 rows and migrations 1–32 unchanged, and a v1-only parser rejects a v2 event/export explicitly. |
| 12 | Reasoning stays inline class `reasoning`, expires/purges as before, is absent from person export, remote query and provider history, and creates no reasoning artifact. |

Implementation worker first lands failing versions of 1, 3, 4, 8 and 12. Focused commands (Node 26, `nice -n 10`; no full suite here):

```bash
nice -n 10 node --test packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/session-log.test.ts packages/server/test/session-log-routes.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/native-agent/agent.test.ts
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
```

The root runs the browser gate for the inspector change and the full core/web envelopes. This planning checkout ran none of them.

## UI, CLI and acceptance

- Inspector component test: a v2 prompt row shows the excerpt and an explicit “full input stored locally; not included in this event/export” label; the full tail/marker is absent; a search term only beyond the excerpt returns no hit. This is a DOM/text assertion, not a visibility claim.
- Browser assertion: the v2 fixture survives reload and replay exactly once, with no duplicate event and no console/storage secret; the root runs it.
- CLI `agent exec --json` keeps its five-field snapshot and sends the full prompt; stdout contains no prompt bytes. The server-side fixture test, not the CLI process, proves the v2 event and full replay. `packages/cli/test/agent-exec.test.ts` is regression, not new evidence.
- Sandbox, platform and live-model scope are unchanged; no new runtime claim.

## Owner decisions and commit

No new owner decision is required. Engineering defaults: 16 KiB inline representation, 8 KiB excerpt/page, session-owned per-session CAS, excerpt-only export/query, and no total input cap. Genuine owner-level gap: ADR-0023 §4 remains proposed; this plan treats the canonical K4 residual as authorization and does not ask for a new decision. Do not label §4 accepted. This planning commit is docs-only: `docs(k4): plan session input artifacts` (no code, no test result, no handoff claim).
