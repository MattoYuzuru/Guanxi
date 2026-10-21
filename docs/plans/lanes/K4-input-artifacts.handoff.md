# K4 input artifacts — implementation handoff

**Status:** bounded vertical slice implemented and locally tested; root independent GPT review and
full/browser/native gates pending. **Does not close `K4-INPUT-ARTIFACTS`.**
**Branch:** `codex/k4-input-artifacts` · **Implementation base:** `b08805c`
**Updated:** 2026-10-22

## Commits

| Commit | Scope |
| --- | --- |
| `cf1b6e2` | docs-only binding of the four implementation-contract corrections |
| `870b834` | contract v2, migration 33, pinned-directory extraction, session input store, fenced log append |
| `081dde1` | native append FIFO, awaited tool-call gate, async replay, deletion path |
| `2f23813` | REST/export/SSE negotiation and inspector excerpt/incompatible states |
| `d28faef` | self-review: R1 fence rechecked before each input artifact write |
| `7a9d617` | self-review: quarantine removal bound to the captured identity |
| `750471b` | self-review: `0400` input files and a malformed-migration-33 rollback guard |
| `8b85fe9` | self-review: minimal incompatible-trace copy (no internal code) |
| `bc7596e` | self-review: queued appends overtaken by a failure cannot follow the terminal |
| `297cf00` | self-review: artifact-root identity pinned across ancestor swaps |
| `983d58e` | self-review: typed pre-open 406 on the live tail |
| `6fb7d23` | handoff evidence update |
| this commit | handoff table hashes only |

No source file from another lane, no `PHASE_STATUS`/`NEXT_AGENT_PROMPT`, package manifest/lock,
approval record/token, user data or infrastructure was edited.

## Implemented

- **Contract.** Event v2 for native `prompt`/`tool.call` with a scrubbed excerpt (≤ 8 KiB) and a
  session-owned SHA-256 reference; no full `text`/`arguments` field exists in v2. v1 bytes and
  schemas are unchanged. `eventVersion` (1–2, default 1) on `/events` and `/stream`;
  `exportVersion` (1–2, default 1) on `/export`; typed
  `session_event_version_unsupported` 406. v1-only export bodies are unchanged; a v2 session
  exports at `exportVersion: 2` only to a max-2 client.
- **Migration 33.** Main ledger appends `session_input_artifacts` (session-owned, unique
  `(session_id, checksum)`, cascade), verifies a pre-existing table's shape (an incompatible
  table fails and rolls back) and replaces only `session_events_policy_insert`: v2 is
  limited to prompt/tool.call, requires an `artifact` object, forbids inline `text`/`arguments`,
  and requires the referenced row to exist for the same session with matching checksum, size
  and media type. Migrations 1–32 are byte-identical; independent ledgers 34–37 are untouched.
- **Store.** New session CAS under `<dataDir>/session-artifacts/<sha256(sessionId)>/`, directory
  `0700`, file `0400` (asserted). The repository-owned pinned helper is extracted to
  `store/pinned-directory.ts` and retains the legacy `ArtifactStore` behavior and its full
  security regression suite. The helper reports its `cwd`/`dev`/`ino`; the parent compares them
  with the trusted identity **before any payload byte**, creates its own random temporary name,
  writes/hashes/`fsync`s/publishes by relative link, verifies the digest, `fsync`s the directory
  and unlinks only the temporary file. Content travels only over the private stdio pipe; no
  absolute-path content operation or fallback exists. A post-operation identity mismatch fails
  closed after the bytes reached the original pinned directory. A failing writer never unlinks a
  published digest.
- **Log.** The metadata row is resolved/inserted in the same fenced SQLite transaction as its
  event, reusing the `(session_id, checksum)` row and ID. FTS, title, search, projection and the
  query tool use the scrubbed excerpt only. A secret registered after the write is re-scrubbed on
  read, and the projection recomputes `excerptBytes` without mutating stored payload.
- **Native producer.** One FIFO per attempt serializes all service/tool-owned appends; `seq` and
  idempotency are computed when an operation executes. Listeners return their promises, and
  `tools.ts` additionally awaits the exact `toolCallId` durable `tool.call` acknowledgment
  before guard, path resolution or any body effect. A missing/failed acknowledgment aborts the
  turn with zero actual tool bodies. The initial prompt append acknowledgment precedes the first
  model dispatch. A queue failure is latched once and writes at most one content-free `error`
  plus failed terminal; R1 completes after the drain. `stop()` enqueues `intervention` then
  aborts without awaiting artifact I/O; `close()` seals/drains before handles close.
- **Replay and cleanup.** Replay resolves v2 references through the session store, verifies
  session/size/SHA-256, decodes, parses JSON arguments and re-scrubs the full bytes; the excerpt
  is never execution input. Missing/corrupt/foreign artifacts fail with a content-free
  `input_artifact_unavailable` before any partial replay. Native deletion removes the session
  artifact directory beside scratch/attachments/output; maintenance reaps a directory whose
  `sessions` row is absent by home-fenced quarantine rename with a post-rename row/live recheck.
- **Wire/client/UI.** A max-1 REST page/export containing v2 returns 406 with zero events/body
  and no cursor; an already-open max-1 stream emits `guanxi-error` with no `id:` at the boundary,
  and the current client throws a typed non-retryable `SseServerError` without `onInvalidFrame`
  or reconnect. The inspector requests 2, shows the scrubbed excerpt with an explicit
  local-only/full-input note, and preserves a typed incompatible state with EN/RU keys. Only
  existing primitives (`Callout`, `Link`, `Badge`, `Button`) are used; no new component, token,
  colour or ceiling.

## New / regression evidence

**New tests: 43.**
- `packages/server/test/session-log-input-artifacts.test.ts` — 18.
- `packages/server/test/session-log-version-negotiation.test.ts` — 6.
- `packages/server/test/native-agent/input-artifacts.test.ts` — 12 (fake provider and injected
  command runner; no sandbox, container, network or live model).
- `packages/web/test/component/inspector-input-artifacts.test.tsx` — 6.
- `packages/web/test/component/sse-terminal.test.tsx` — 1 new typed-error case.

**Regression envelope actually run: 83 server tests in 9 files (47 regression) and 33 web tests
in 4 files (27 regression).**

```bash
nice -n 10 node --test \
  packages/server/test/session-log-input-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/artifacts.test.ts \
  packages/server/test/migration.test.ts \
  packages/server/test/durable-run-migration.test.ts \
  packages/server/test/relay/schema.test.ts
# 83 pass / 0 fail
nice -n 10 npx tsc --noEmit -p packages/contract/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/server/tsconfig.json
nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json
# all clean
cd packages/web && nice -n 10 npx vitest run \
  test/component/inspector-input-artifacts.test.tsx \
  test/component/sse-terminal.test.tsx \
  test/component/inspector.test.tsx \
  test/component/localization.test.tsx
# 4 files, 33 tests pass
```

Not run here (root owns them): full `npm test`, browser gate, build, Storybook/snapshots,
`npm run check:licenses`, eslint/stylelint, `agent-dev`, nested sandbox/containers, live models,
SSH/external services/owner data. `packages/server/test/native-agent/agent.test.ts` was not run in
this harness because its nested-sandbox scope is not proven; it was adapted for async
prompt/queue and `promptTextOf`, and the root should run the native envelope outside this sandbox.

## Migration, rollback, storage, GC, queue and memory limits

- **Migration 33** is append-only. Independent F1 34, R2 35 and F2 36–37 ledgers stay
  independent and untouched. If main consumes 33 before merge, stop and take a new
  root-assigned global slot; never renumber into 34–37.
- **Rollback** restores a stopped, consistent pre-upgrade SQLite/WAL backup; there is no down
  migration or table drop under a running node. An older binary does not understand v2 events
  or exports and must not reuse a v2-bearing database. The supported old-client path is the new
  server's explicit v1 negotiation (406 or an `id`-less SSE error), not old-server compatibility.
- **Storage/GC.** A published digest is never unlinked by a failed append; it remains an orphan
  until the whole session is deleted or maintenance reaps a directory with no session row. There
  is no per-blob GC in this slice. A future per-blob GC must hold the K2 writer fence and
  re-check the `(session_id, checksum)` row after acquiring it. A quarantined directory is kept
  if a session row or live owner appears before removal.
- **Queue.** `agent.queue.items[].text` is still the full immutable inline text, including after
  consumption. A consumed queued prompt may produce a v2 `prompt` event, but the prior queue
  event remains inline. No new queue cap or reference representation exists. Chat, K5,
  delegated/remote prompts, assistant output, reasoning, tool results, image bytes and model
  outputs stay on their current paths.
- **Memory.** Full input bytes are buffered for replay and re-scrubbing; the excerpt is at most
  8 KiB. The 16 KiB threshold controls representation only, not acceptance: there is no new
  total input cap, and acceptance remains bounded by existing transport and model/runtime
  context. Output paging still reads and scrubs a whole artifact in memory; command tails past
  the explicit 64 KiB bound stay discarded.

## Deferred and not claimed

- Whole canonical `K4-INPUT-ARTIFACTS` closure; bounded-memory streaming; per-blob GC; queued
  prompt reference representation; output-tail recovery.
- Chat/K5/reasoning/results/image path changes; any new content audience or REST route returning
  full input bytes; provider/export of reasoning.
- Live/model/browser/build/full-suite validation. `ADR-0023 §4` remains **proposed**, not
  accepted; this slice's authorization is the root's bounded K4 migration scope.

## Shared edits

- `packages/contract`: event union, version/export schemas and 406 error code.
- `packages/server/src/store/db.ts` and `session-log/schema.ts`: main migration ledger 33.
- `packages/server/src/store/artifacts.ts` + new `store/pinned-directory.ts`: extracted
  repository-owned primitive; legacy behavior and `artifacts.test.ts` assertions preserved.
- `packages/server/src/session-log/routes.ts`: explicit negotiation on the existing K2 routes.
- `packages/web/src/lib/sse.ts` + locale/API error map: typed server-error frame handling.
- `packages/web/test/component/inspector.test.tsx`: export href now carries
  `exportVersion=2` (contract adaptation, no assertion removed).
- Existing migration/fixture tests: current-version markers moved from 32 to 33, the session-log
  downgrade fixture drops `session_input_artifacts`, and v2-safe `promptTextOf` /
  async `prompt`/`queue` adaptations were applied in session-log, federation-persistence and
  native tests. No assertion was removed or weakened.

## Review-fix

No root review findings yet. Any later findings will be fixed in separate commits and appended
here without rewriting this section.
