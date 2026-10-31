# K4 queue v3, round Q1: native reader and progress vertical slice

**Status:** implemented by lane `K4-queue-v3-Q1` (author round; no independent review yet) ·
**Date:** 2026-11-01 · **Branch:** `lane/k4-queue-q1`, from `lead/wave8` `2b8cf843` ·
**Ports/data:** `GUANXI_WEB_PORT=5242 GUANXI_API_PORT=4442 GUANXI_DATA_DIR=$PWD/.lane-data`

Scope authority: [`K4-queue-v3.plan.md`](K4-queue-v3.plan.md) section 4 (progress API),
section 5 (native flow), section 8 item 2 (the Q1 round) and acceptance rows Q03-Q09, Q11,
Q17, Q21. The parent plan requires Q1 and Q2 to be separate clean author/reviewer rounds.
This round implements Q1 only. The producer stays v1 and Q2 is not started.

## What Q0 left

Q0 (integrated, see [`K4-queue-v3.handoff.md`](K4-queue-v3.handoff.md)) shipped the
representation and the readers, and deliberately no native behavior:

- contract: `queue-v3.ts` leaf, `agent.queue` v3, `AgentProgressV2`,
  `agentProgressQuerySchema`, `nativeProgressVersionUnsupportedSchema` (definitions only);
- log: independent ledger 40, atomic multi-descriptor v3 append, v3 read projection, actual
  `requiredVersion` boundaries, export3; inspector max3;
- native: one guard in `NativeAgents.progress()` that refuses a non-v1 queue snapshot with the
  content-free `agent_unavailable`. The consumer loop in `launch()` still reads
  `progress(id).queue[0].text`, so a v3 snapshot would stop the session silently after a
  completed turn, and `result()` fails on v3 state because it goes through `progress()`.

## Q1 scope (exactly)

1. **Internal executable queue union.** New `native-agent/queue-state.ts`: the latest
   `agent.queue` snapshot of any version, normalized to
   `{id, kind:'inline', text} | {id, kind:'artifact', artifact}`, with every id already present
   in a `prompt.messageId` removed, order preserved. Distinct from the outward progress.
2. **Outward projections from that state.** Legacy `progress()` keeps the exact v1 body
   (`queue[].text`); an artifact-backed pending item refuses with the typed
   `native_progress_version_unsupported` (HTTP 406, `{code, supported:1, required:2}`).
   New `progressV2()` returns the strict v2 body: inline, artifact and `legacy-preview`
   (an oversized pending legacy-v1 inline entry: bounded excerpt of the complete scrubbed
   text plus its exact byte size, no executable text). `result()` and `launch()` use the
   internal state, never a versioned public body.
3. **Verified full-byte consumption.** After a completed turn drains, the next item is chosen
   from fresh events. A fresh R1 run/attempt and its FIFO are allocated *before* any async
   work; mutation admission (`active.queue`) stays closed until preparation ends. Artifact
   bytes are read with `SessionInputStore.read(sessionId, ref)` (session, id, checksum, size,
   media type, exact digest), strict UTF-8, current-registry scrub; inline legacy text is
   scrubbed afresh. The abort signal, session availability, active identity and R1 fence are
   rechecked after every await and synchronously before dispatch. The durable prompt append
   keeps the queue id as `prompt.messageId`, `origin: queued`.
4. **Truthful preparation failure.** A missing, corrupt, foreign or undecodable input records
   one content-free `error` then the failure terminal on the new attempt, with zero prompt
   marker, provider and tool calls. The selected id stays pending; it is never skipped, and
   the completed prior turn is never re-written. Stop during preparation cancels the
   preparation attempt. A deposed owner writes nothing.
5. **Route, plugin, clients.** `GET /api/agent/:id?progressVersion=1|2` (strict query);
   `progressV2` on the plugin service; web native API/page and both CLI polls (normal and
   cancellation confirmation) request progress2 and parse it. `/result` and
   `agentExecResult.version = 1` do not change.
6. **Restricted mutations.** On a latest pending v3 snapshot both add and remove refuse with
   HTTP 409 `{code:'native_queue_producer_unavailable'}`, read inside the queue FIFO, with no
   write, no blob read and no state replacement, including duplicate removal. v1-only
   behavior is exact.
7. **Rollback floor.** Q0+Q1 is the *restricted reader rollback floor*: progress2, verified
   consumption, result and stop work over v3 state; v3-state queue mutations wait for Q2. The
   native producer still emits v1, asserted by test.

Non-goals: producing v3 or any artifact queue item, any upload/download endpoint, FTS for
queues, changing Q0 representation, retention or sandbox code, dependencies.

## Migration

None. Ledger 40 and global 33 are untouched; Q1 adds no table, trigger or column.

## Contract changes

`packages/contract/src/native-agent.ts`: add `nativeQueueProducerUnavailableSchema`
(`{code:'native_queue_producer_unavailable'}`, strict). Nothing else in the wire changes; the
progress v2 shapes exist from Q0. Contract, server route, web client, CLI and tests change
together.

## Files

| Path | Change |
| --- | --- |
| `packages/contract/src/native-agent.ts` | typed 409 schema |
| `packages/server/src/native-agent/queue-state.ts` (new) | executable union, projection, v2 mapping |
| `packages/server/src/native-agent/service.ts` | state/progress/progressV2/result split, restricted mutations, consumer and preparation, stop |
| `packages/server/src/native-agent/plugin.ts`, `routes.ts` | `progressV2`, query, 406/409 bodies |
| `packages/cli/src/agent-exec.ts` | both polls on progress2 |
| `packages/web/src/features/native-agent/*`, `packages/web/src/lib/locale.ts` or `messages.ts` | progress2 client, one row per queue item, preview labels (EN source, curated RU) |
| tests (see below), `packages/server/src/native-agent/README.md`, `docs/plans/lanes/K4-queue-v3-Q1.handoff.md` | evidence and current behavior |

## Rollback proof

A new test in `native-agent/queue-v3-reader.test.ts` pins both halves of the floor. (a) Over
real Q1 production (queue add/remove/consume, including a text above 16 KiB), no stored event
has version 3 and every event is readable by a `maxVersion: 2` reader with no
`unsupportedSeq`, so a pre-Q0 max-2 binary keeps working on Q1-written data. (b) Over seeded v3
state, a max-2 reader reports `requiredVersion: 3` at the first v3 event (the documented
limit of an older binary), and the Q1 node behaves as the restricted floor: progress2, verified
consumption, result and stop work, add/remove return the typed 409 and leave head, event count,
metadata and blobs unchanged. Binary rollback to before Q0 is unchanged from the Q0 handoff
(stopped consistent backup, loss-of-new-writes boundary).

## Tests and how each is checked to fail without its implementation

Each property gets an assertion written against an independent oracle (Buffer bytes, event and
row counts, a recording fake provider, deferred promises). The handoff records for every test
which production line was reverted to confirm a failure ("mutation check") and the result.

| Row | Test |
| --- | --- |
| Q06 | seeded v3 pending artifact (>16 KiB with a tail sentinel): one queued prompt with the original id, one provider request containing the full bytes including the tail, never the excerpt; consumed once; one new run/attempt per consumed item |
| Q07 | missing blob, tampered bytes, foreign session reference, wrong checksum/size/media type, invalid UTF-8: one `error`, one terminal, selected id still pending, zero prompt/provider/tool, next item not dispatched, old turn untouched |
| Q08 | stop and session leave while the read is held, deposed fence: zero dispatch, cancelled truth for stop and failed truth for leave, mutations rejected during preparation |
| Q03 | existing v1 FIFO tests (add/add/remove) unchanged and green |
| Q05 | stop returns without waiting; existing stop/intervention tests unchanged; preparation stop adds one intervention before one terminal |
| Q09 | restart before/after prompt commit: reopen inference count 0, pending/consumed ids truthful |
| Q11 | progress1/default over inline, legacy-large and artifact queues; progress2 over inline, legacy-preview and artifact, no tail, no blob read; `/result` unchanged; route status and bodies |
| Q17 | CLI normal and cancel polls over a progress2 server fixture; stdout record and exit codes unchanged |
| Q21 | seeded v3 pending artifact plus another item: add, remove either, duplicate remove all refuse with the exact 409; nothing changes; progress2, result, stop and consumption work |
| rollback | described above |
| web | component tests: one row per queue item, preview labels, EN/RU, removal request count, tail absent |

## Defaults used (plan left the point open)

1. "Latest applicable pending v3 snapshot" means: the latest queue snapshot is version 3 and
   at least one of its ids is unconsumed. A v3 snapshot whose items were all consumed (or
   removed) does not block; the next mutation writes a v1 snapshot as today.
2. The restriction is evaluated inside the queue FIFO against fresh events, before the
   side-chat duplicate-id check, so a refused call never reports `duplicate`.
3. Side-chat Send onto a restricted queue reports the existing `agent_unavailable` (no new
   `SideChatError` code is added to a separate contract).
4. A stop issued during preparation records its intervention through the preparation FIFO
   (the preparation attempt owns the turn), then the cancelled terminal.
5. A preparation failure other than abort uses the new content-free code
   `input_artifact_unavailable` in the `error` event and `agent.state`; it reuses the
   existing `NativeAgentError` code of the replay path.
6. A failure to read the events at selection time is treated as a preparation failure (a new
   attempt records the failed terminal) instead of being swallowed after a completed turn.
7. If the session is already unavailable before the next attempt is allocated, no attempt is
   started and nothing is written; if it becomes unavailable during preparation (a leave), the
   preparation attempt ends with the existing generic failed terminal (`agent_failed`), not a
   cancellation and not an `input_artifact_unavailable` claim. Only an explicit stop or a close
   is recorded as cancelled.
8. `progressVersion` is a strict query (unknown keys give 400 `validation_failed`).
9. A client built for progress2 against a pre-Q1 node is unsupported: the node ignores the
   query and returns the legacy body, which fails the strict v2 parse, and the client fails
   closed (CLI `agent_exec_failed`, web offline state). No legacy-body adapter is added.
   Asserted for the CLI.
10. A v3 queue holding only inline items answers progress1 in the exact legacy shape.

No `OPEN_QUESTIONS.md` entry concerns the queue representation; none was closed.

## Checks to run (scoped, no full suites)

```sh
node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test \
  packages/server/test/native-agent/queue-v3-reader.test.ts \
  packages/server/test/native-agent/agent.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/native-agent/crash.test.ts \
  packages/server/test/native-agent/review.test.ts \
  packages/cli/test/agent-exec.test.ts
npm exec --workspace @guanxi/web -- vitest run test/component/native-agent.test.tsx
npx tsc --noEmit -p packages/contract && npx tsc --noEmit -p packages/server \
  && npx tsc --noEmit -p packages/cli && npx tsc --noEmit -p packages/web
```
