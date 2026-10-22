# K4 queue input artifacts: concrete v3 implementation plan

**Status: root-accepted engineering contract; Q0 only authorized now.** Date:2026-10-22.
Standalone checkout `/Users/yuzuru/Projects/Guanxi-lanes/k4-queue-v3-foundation`, branch
`codex/k4-queue-v3-foundation`, base main `f8c65df460c1df9e37cdc5661cf6e730b4032ec5`
(executable1b6f495). Root read the original outside plan and independent review, corrected
all required sequencing/compatibility details below and reserves independent ledger40 here.
Q1/Q2 require separate clean author/reviewer rounds after the previous round closes.

Historical planning inspected candidatef2ffcd0c; independent review rechecked main3e4840bb.
Root verified the relevant source is unchanged throughf8c65df4 and independently rechecked
ledgers34–39/no40 collision. Original reports remain outside under reviews/k4-queue-v3-*.
No implementation or new check is claimed by this plan. Root owns local Node26 and shared
`/Users/yuzuru/.local/state/agent-dev` resourceheavy; assigned ports5204/4404, data.lane-data.

Used the repository AGENTS/NAVIGATION/WORKFLOW/lanes instructions, workstation-dev,
implementation-planning, architecture-migration, product-acceptance and guanxi-ui contracts.
This concretizes `reviews/k4-next-local-slice-plan-20261022.md`; its encoding recommendation
has since been implemented and independently reviewed. The accepted objective is to remove
large queue text from new durable queue snapshots without losing executable input. The
wire shapes, ledger allocation and engineering sequence below are proposals for root to
accept. They do not relabel proposed ADR-0021/0023 sections as accepted architecture and
need no new owner product decision.

## 1. Current seams and protected behavior

| Current implementation at the inspected pin | Consequence |
| --- | --- |
| `packages/contract/src/events/session-events.ts:157`: strict v1 `agent.queue {items:[{id,text}]}`; v2 supports only prompt/tool.call; max event version is 2. | Adding queue to v2 would break already shipped strict max2 parsers. Use a distinct v3 queue envelope. |
| `packages/server/src/native-agent/service.ts:208-240`: progress takes the last queue snapshot, then removes IDs present in prompt.messageId. | Separate internal executable queue state from outward display projection; never execute a progress preview. |
| `service.ts:260-283`: queue/remove read and append inside one `NativeAppendQueue` operation. | Preserve this admission order when artifact writes introduce awaits. Never take a snapshot before FIFO entry. |
| `service.ts:334-365`: after a completed turn, select queue[0], replay history, start a fresh R1 attempt. Active append queue is absent during transition. | Resolve artifact bytes and recheck abort/home/session availability across this transition. Do not widen mutation acceptance during that existing gap. |
| `service.ts:404-450`: pi-core user message listener awaits appendPrompt before provider dispatch; prompt.messageId is the queued item ID. | Keep the durable consume receipt before inference and preserve that ID. |
| `packages/server/src/session-log/log.ts`: v2 append resolves one artifact inside the append transaction; reads/output frames project current privacy; search queue text is currently null. | v3 needs multiple descriptors resolved atomically. Keep queues out of FTS rather than silently add queue search semantics. |
| `events/inspector.ts`, session-log routes and inspector API hardcode 2; required-version errors also hardcode 2. | Generalize actual boundary version, export branch and client requests together. |
| `contract/native-agent.ts`, native GET `/:id`, web native page and CLI polling require queue[].text. | Preserve the legacy body and add explicitly negotiated progress v2; never put an excerpt into its text field. |

Preserve existing single writer/home/attempt fencing, stop intent, retention touches,
same-session artifact lookup, exact tool-call acknowledgment and zero automatic inference on
restart. This changes representation, not prompt policy, routing, tools or model-visible
meaning. No new count/size acceptance cap is introduced.

## 2. Exact proposed event and append shapes

Keep all v1 shapes and the two v2 shapes unchanged. Keep `SESSION_EVENT_VERSION = 1` and
`SESSION_EVENT_VERSION_2 = 2`; add `SESSION_EVENT_VERSION_3 = 3` and set max to 3. New v3 is
allowed only for standard `agent.queue`:

```ts
type QueueInlineV3 = {
  id: string
  kind: 'inline'
  text: string
}
type QueueArtifactV3 = {
  id: string
  kind: 'artifact'
  artifact: SessionInputArtifactRef
}
type QueueDataV3 = { items: Array<QueueInlineV3 | QueueArtifactV3> }
// Full existing envelope fields remain unchanged:
// { version:3, type:'agent.queue', class:'standard', data:QueueDataV3, ...envelope }
```

Every object/union branch is strict. Reuse current item ID acceptance (`z.string()`), require
unique IDs within a snapshot, and preserve IDs exactly; generated new IDs remain UUIDs.
Inline v3 text must be at most `INPUT_INLINE_BYTES` (16 KiB) in scrubbed UTF-8. Artifact
branches contain no `text` and use only `SESSION_INPUT_TEXT_MEDIA_TYPE`, byteSize above
16 KiB, the existing SHA-256/reference schema, and the existing <=8 KiB exact excerptBytes.
There is no `arguments`, path, provider text, download URL or fallback full text. Empty
snapshots are valid. New mutations emit v3 consistently, including all-inline/empty snapshots.
Legacy v1 queues remain readable and are not rewritten in place.

Use a dependency-free shared contract leaf for queue/reference runtime schemas, re-exporting
existing public names. Do not create an eager native-agent <-> session-events Zod import
cycle. Actual cold import/parse through both public entries is required; tsc is insufficient.

Proposed append input has artifact **descriptors**, never caller-selected artifact IDs:

```ts
type QueueAppendDataV3 = {
  items: Array<QueueInlineV3 | {
    id: string
    kind: 'artifact'
    input: SessionInputArtifactInput  // checksum, byteSize, text mediaType, excerpt
  }>
}
// handle.append({type:'agent.queue', data:QueueAppendDataV3}, {eventVersion:3})
```

Extend the conditional `SessionAppendData` for this one type. Parse the strict v3 append
schema before use; resolve every descriptor with `resolveInputArtifactWithin` inside the
same synchronous transaction as the event/head/FTS insertion. Construct and validate the
published `QueueDataV3` before insert. Existing v2 `inputArtifact` option remains unchanged;
reject that option on v3 and reject `input`/published `artifactId` misuse. A retained artifact
is converted to its descriptor (including its current safe excerpt) when constructing a new
snapshot; the log re-resolves its owned ID and validates media/size/checksum, rather than
trusting a foreign published reference. Same checksum/session dedupes through the existing
metadata unique key. Different queue IDs with equal text remain distinct work items.

Keep singleton `inputArtifactOf()` semantics for prompt/tool.call. Add plural
`inputArtifactsOf(event)` or an equivalent queue-specific helper for inspector rendering;
do not silently return the first queue artifact as though it described the whole event.
Add a display-only queue item text helper. Neither helper is a native execution input API.

## 3. Migration allocation and compatibility deployment

Main `MIGRATIONS` ends at **33**. Independent ledgers occupy **34** federation, **35** relay,
**36** remote offers, **37** remote dispatch, **38** judge and **39** trusted relay start.
Layout owns its own v1/v2 ledger; K3/K5 have separate databases/ledgers. Do not append an
array element called global40 (it would actually become global34), pad global34–39, reuse
an independent reservation, or edit migration33.

**Root reserves independent ledger40 for this slice**, same SQLite database, named
`session_queue_migrations`, with one row `(version=40)`. New file
`packages/server/src/session-log/queue-schema.ts` owns its immutable migration40 SQL and
installer. This deliberately supersedes the earlier plan's assumption of a new global slot;
it avoids consuming reserved numbers or changing main `user_version`. Root rechecked the merged
f8c65df4 source before author launch: ledger40/session_queue_migrations remains unallocated.

Installer runs in SessionLog construction before providing the service, after openDb has
applied global33. In `BEGIN IMMEDIATE`, re-read the component ledger; reject unknown/future
versions and incompatible existing table/trigger shapes, apply migration40 once, then commit
the ledger row. Competing initializers observe the committed version rather than blindly
applying DDL. Failure rolls back the trigger change and row. Do not suppress arbitrary DDL
errors or initialize this ledger in the middle of an R1 append transaction.

Migration40 replaces only `session_events_policy_insert`. Preserve its v1/v2/reasoning
conditions verbatim in the new migration and add v3 allowed only for `agent.queue` with an
items array. For each `json_each` item, require an object, valid ID/kind, no opposite-branch
fields, inline text within16 KiB UTF-8 (`length(CAST(text AS BLOB))`), or an artifact object
whose ID/checksum/byteSize/mediaType match the same-session metadata row and text media type.
Reject duplicate item IDs and malformed/null/non-array items. Keep full strict/exact-byte
reference validation in Zod too. Explicit raw-SQL negative tests must prove that missing,
foreign or mismatched metadata cannot bypass the database policy. No table rebuild, data
backfill, historical payload/FTS rewrite, schema33 edit or independent-ledger mutation.

Ship additive readers before enabling native v3 production (section8). A reader-compatible
release is the rollback floor once v3 is written. The pre-change max2 binary cannot be taught
v3 by a new server: its own read path may report stored_data_invalid, and its migrate()
currently ignores a future main user_version. Do not claim an old binary will gracefully
negotiate v3 in its own database. A binary rollback to before the compatibility release
requires a stopped consistent pre-upgrade DB/WAL plus artifact-directory backup, with its
explicit loss-of-new-writes boundary; never downgrade triggers/ledger under a running node.

## 4. Progress API: preserve text semantics explicitly

Keep `agentProgressSchema`, `AgentProgress`, and unversioned/default legacy GET body as v1:
queue entries are still `{id,text}` and text is still the complete current scrubbed inline
value. No new field is inserted into that strict legacy body.

Add `GET /api/agent/:id?progressVersion=2`, strict query accepting only 1/2, default1, and:

```ts
type AgentProgressV2 = Omit<AgentProgress, 'queue'> & {
  version: 2
  queue: Array<
    | QueueInlineV3
    | QueueArtifactV3
    | {
        id: string
        kind: 'legacy-preview'
        excerpt: string
        excerptBytes: number
        byteSize: number
      }
  >
}
```

The third branch is necessary for a pending oversized **legacy v1 queue**: a read-only
progress request cannot fabricate a persisted artifact reference or silently backfill it.
Derive its excerpt from the complete current-registry-scrubbed legacy string, use existing
UTF-8/whole-marker bounds, and report its exact current byteSize. It has no executable text
field or artifact ID. Legacy small entries map to `kind:inline`; v3 entries retain their
branch. All three render as a queue item with its unchanged removable ID; preview branches
are visibly labeled as previews using locale keys, not as missing input or full text.

For progressVersion1, if any pending entry is artifact-backed, return **406** with a
content-free typed body `{code:'native_progress_version_unsupported', supported:1, required:2}`
(declare its exact schema). Never hydrate an artifact for this request and never return a
partial/empty success. Inline-only queues, including legacy oversized inline data, still
return the exact legacy shape. The current v1 legacy-large response remains a compatibility
residual; new clients use progress2 and never fetch it for previews. No artifact download
endpoint is added. `/result` and stable CLI stdout `agentExecResult.version=1` do not change.

Refactor service projection into internal queue state plus outward progress; `result()` and
launch() use the internal state/status rather than a versioned public progress body. Keep a
legacy progress service adapter with typed refusal, add progressV2, expose it in plugin.ts,
and make route choice explicit. The web native API and **both** CLI polling paths (normal
and cancellation confirmation) request progress2 and parse its schema. CLI result/exit codes,
loopback/origin checks and cancellation-confirmation behavior remain unchanged.

For a new client on a pre-change node: native routes currently ignore the unknown query and
return the old full body. A bounded adapter may accept an exact legacy progress schema and
render its legacy text as a preview; do not reinterpret an arbitrary malformed v2 body as
legacy. Inspector requests max3 on a max2 server currently get 400 validation_failed; a single
read-only fallback to the existing max2 request is permissible only for that exact validation
response, before accepting events/advancing a cursor. Never replay POST/DELETE mutations as
version fallback. Include explicit mixed-version fixture tests or document that old-node
client pairing is unsupported; do not silently assume it works.

## 5. Native queue flow, ownership and failure ordering

Use a private normalized executable queue union: `{id,kind:'inline',text}` or
`{id,kind:'artifact',artifact}`. Normalize v1 snapshots to inline internally, take only the
latest queue snapshot, filter every ID already present in any prompt.messageId, and preserve
order. Keep this projection distinct from AgentProgressV2 and its legacy-preview branch.

Queue acceptance:

1. Validate nonempty input and active/unsealed queue exactly as today; user activity touches
   retention only for user calls (`userActivity=true`), not the agent's queue tool.
2. Capture the active attempt/handle/AbortSignal/FIFO at admission. Enter that same FIFO
   before reading the latest pending projection or generating the accepted snapshot. Capture
   a new item's UUID once for this operation; no automatic request retry is introduced.
3. Scrub the full incoming text with the ready current registry. Keep <=16 KiB inline;
   write larger text through existing SessionInputStore, then store only its descriptor and
   bounded excerpt. Normalize every retained oversized legacy-inline pending item the same
   way before re-emitting it in a new v3 snapshot. Reuse retained artifact descriptors; do
   not reread or rewrite their blobs just to remove/add another item.
4. Filesystem awaits remain outside SQLite. Check abort, session availability, R1
   execution/home/attempt and captured active identity before/after each awaited write and
   immediately before appendNow. Append uses the captured fenced handle; never reacquire a
   fresh permit to commit work after that owner has lost its epoch.
5. appendNow(eventVersion3) resolves **all** metadata and appends exactly one snapshot in
   the R1/K2 synchronous transaction. Acceptance/HTTP202 follows that commit only. Published
   blobs whose event fails remain harmless orphans until existing session deletion/reaping;
   never delete a digest another historical event may reference.

Removal enters the same FIFO, projects fresh state there, filters only the requested ID,
and emits a normalized v3 snapshot. Successfully accepted earlier removals must be visible
to later selection. Concurrent add/add/remove cannot overwrite an accepted item. Duplicate
removal can retain current no-op success semantics. No per-blob deletion follows removal.

Consumption uses the internal union, not outward progress:

1. After the prior turn completes and its FIFO drains, select the first unconsumed ID from
   fresh events. Keep mutation admission sealed throughout this inter-turn preparation.
   Do not acknowledge add/remove against a changing attempt or create another writer.
2. Allocate the next existing R1 run/attempt and its turn/FIFO ownership **before** async
   artifact resolution/history replay. Establish turn.start/agent.state, renewal/cancellation
   ownership and a live fence for failure recording. Do not commit a prompt consume marker,
   reopen queue mutations or dispatch provider/tools during preparation.
3. Resolve SessionInputStore bytes using sessionId/artifactId/checksum/byteSize/mediaType,
   pinned helper, exact digest/size, strict UTF-8 and current-registry scrubbing. Freshly scrub
   inline legacy input too. Never execute an excerpt/preview, foreign bytes or guessed path.
   After each await (including replay), recheck abort, availability, captured identity/home/
   attempt, and recheck synchronously before prompt append/dispatch. A deposed owner writes0.
4. On success, preserve selected queue ID as prompt.messageId/origin=queued. The awaited
   prompt append remains the durable consume marker before the first provider call. A newly
   scrubbed full input can correctly have a new digest; immutable metadata has no excerpt
   equality requirement. Keep accepted previous-turn history untouched.
5. On missing/corrupt/foreign/unreadable input, the new live preparation attempt records one
   content-free error/terminal and fails with zero prompt marker/provider/tool calls. Keep
   selected ID pending/unconsumed; do not skip to the next item. Never append after the
   completed prior turn.done or re-complete that old successful run. Stop during preparation
   cancels the new owning attempt with zero dispatch. No swallowed transition failure.

Stop must remain immediate: record the intervention intent before aborting, never await the
blocked artifact write in stop(), and retain that intent through the queue failure path.
During the existing inter-turn gap, retain cancelled/interrupted R1 truth and zero next
dispatch; do not invent a successful next-turn intervention receipt when no attempt owns it.
Keep leave/session retention behavior, cleanup quarantine and home-owned reaping unchanged.

“Exactly once” is testable here as **one successful live FIFO consumption/prompt ID and one
first request containing the full verified queued bytes**, with explicit counts. It cannot
mean an atomic external-provider exactly-once guarantee across process death: a crash after
the durable prompt commit but before/after the provider call has an uncertain dispatch
window. Preserve the accepted zero automatic inference/retry on restart. A restarted process
shows pending items and interruption truth; it never resumes a queue automatically. A later
explicit prompt continues current behavior; already consumed IDs are not dispatched again.

## 6. Read/privacy/version boundaries

For every v3 artifact item apply `projectInputExcerpt` independently to its nested descriptor
before outward serialization, including late-registered secret-prefix protection and exact
recomputed excerptBytes. Preserve the original completeness inputs before replacement.
Bound excerpts again after redaction expansion; current marker clipping and ordinary
decorative-prefix controls must stay green. Scrub surrounding inline fields and identifiers;
if a required opaque reference/UUID becomes invalid under late registration, fail closed
with a content-free existing error instead of fabricating a usable reference.

Late redaction may also expand a valid stored inline value beyond16KiB. The locked Q0/Q1
policy is a content-free fail-closed read, with no cursor advance, prompt consumption or
provider dispatch and preserved stored/pending input. Name the availability residual; never
truncate executable inline.text or pretend an excerpt is complete input. There is no new
input acceptance cap and no display hydration of artifact bytes.

Apply the same projection to REST pages, subscription reads, each final SSE frame, exports,
native progress2, inspector details and session query tools. No preview path opens a blob.
Queue FTS remains null (current behavior); assert it instead of claiming full-text queue
search. Prompt titles/search retain their existing v2 behavior. No queue tail beyond its
excerpt can appear in new event JSON, search_text, export or progress2.

Add export3; preserve v1/v2 response schemas and explicitly constrain export2 events to <=2
(today its broad union would accidentally accept v3 after extending sessionEventSchema).
Choose the minimum required export version of the actual exported events; refuse a smaller
requested maximum with 406 before returning a partial body. Always exclude reasoning.

Change `read()` boundary result to carry actual requiredVersion alongside unsupportedSeq.
REST rejects the page without advancing nextAfter. SSE may yield supported preceding events,
then emits a guanxi-error with required3, **no event id**, closes, and leaves the last valid
cursor before the unsupported event. Preflight unsupported-first returns406. Never advance
to lastSeq or skip v3 merely because max2 cannot parse it. `Last-Event-ID` rules remain.
No hardcoded required2 survives in read/subscribe/routes; max1 encountering v2 still reports2.

## 7. Exact implementation ownership

All paths below are relative to the new root-prepared standalone clone, not the frozen
integration checkout. Existing exports are re-exported through the contract event barrel;
adjust its index only if the new schemas/helpers require it.

| Paths | Required change |
| --- | --- |
| `packages/contract/src/events/session-events.ts`, `events/inspector.ts`, `native-agent.ts`; if needed `schemas.ts`, `events/index.ts`, `index.ts` | Strict queue3 append/published schemas, versions/export3, progress2/query/typed refusal, display/reference helpers. No widening v1/v2 meanings. |
| `packages/server/src/session-log/queue-schema.ts` (new), `log.ts` | Independent migration40 installer; multi-descriptor atomic append, actual version boundary, v3 read projection. Main db.ts and applied schema.ts migration strings stay unchanged. |
| `packages/server/src/session-log/excerpt.ts`, `routes.ts`, `projection.ts`, `query-tool.ts` | Queue artifact projection/output/version/export paths. projection/query-tool may need only type coverage/tests; avoid unnecessary behavior edits. |
| `packages/server/src/native-agent/service.ts`, `plugin.ts`, `routes.ts` | Internal executable projection, negotiated progress, producer/remove normalization, verified consumer, post-await guards and truthful transition failure. |
| `packages/server/src/native-agent/append-queue.ts` | Preserve implementation if its current enqueue/stop/failure seam suffices; any necessary change needs its own focused regression assertions and review. |
| `packages/web/src/features/inspector/api.ts`, `model.ts`, `InspectorPage.tsx`; `features/native-agent/api.ts`, `NativeAgentPage.tsx`, `messages.ts`; inspector locale keys in `packages/web/src/lib/locale.ts` | Request max3/export3/progress2, render every queue item once with bounded preview and per-item metadata; preserve loading/error/offline/keyboard/removal states. Reuse existing Button/Badge/text components and tokens. No new component approval or token needed. |
| `packages/cli/src/agent-exec.ts` | Both progress polls use negotiated schema; stable result JSON and exits unchanged. |
| `packages/server/test/session-log-queue-artifacts.test.ts`, `native-agent/queue-artifacts.test.ts` (new) | Focused store/log/migration/native race tests; use existing synthetic fixture and fake provider. |
| Existing `session-log-version-negotiation.test.ts`, `session-log-routes.test.ts`, `session-log-truncated-egress.test.ts`, `native-agent-contract.test.ts`, `native-agent/input-artifacts.test.ts`, `native-agent/crash.test.ts`, `native-agent/review.test.ts`, `packages/cli/test/agent-exec.test.ts` | Compatibility, unchanged privacy/fences, legacy residual expectations and cancellation. Replace the current “keeps queued prompts inline” residual test with the new observable behavior; preserve historical v1 fixtures. |
| `packages/web/test/component/native-agent.test.tsx`, `inspector-input-artifacts.test.tsx`, `inspector.test.tsx`; `packages/web/test/browser/native-agent.spec.ts`, `inspector.spec.ts` | Exact item/request counts, preview/tail absence, replay/reconnect/removal keyboard, mobile/reduced motion, incompatible-node state. |
| Both session-log/native-agent READMEs; new lane plan/handoff | Current behavior, compatibility/rollback floor and residuals. Root updates PHASE/NEXT only at integration. |

Do not change shared pinned-directory/helper, encoding/hash, byte snapshots, migrations1–33,
independent34–39, dependencies, egress matching rules, provider/tool policies, queue acceptance
caps or retention storage prefixes. Any demonstrated need to cross these boundaries returns
to root with exact evidence; no speculative refactor or license copying is needed.

## 8. Bounded delivery sequence

There is no safe “change only queue text to a reference” increment. Use **three sequential
author/reviewer rounds**, each from a clean root-assigned pin, with no parallel shared edits:

1. **Q0 compatibility foundation.** Contract3/progress2 definitions, migration40, log append/
   reader/privacy/version/export machinery, inspector readers/rendering and seeded-v3 fixture
   tests. Native producer stays v1; do not advertise queue artifactization complete. Keep
   this as an unreleased reviewed foundation until Q1: it is not yet a whole-node v3 rollback
   baseline because native consumers/progress still need the next round.
2. **Q1 native reader/progress vertical slice.** Internal executable union, verified full-byte
   consumption, progress route/client/CLI cutover and native UI, transition failure/stop/
   fence tests over seededv3. Producer remainsv1. On a latest applicable pendingv3 snapshot,
   BOTH add/remove refuse409 with strict content-free code native_queue_producer_unavailable,
   without writing/hydrating/replacing state, even for duplicate removal. Existing v1-only
   mutation behavior stays exact. Q0+Q1 is a **restricted reader rollback floor**: progress2,
   verified consumption, result and stop work, but v3-state queue mutations wait forQ2.
   Assert that restriction and native normal production remainsv1. No artifactization claim.
3. **Q2 native producer activation.** Queue write/remove normalization and atomic v3 append,
   held-write/concurrent add/remove/stop/fence regressions, current-privacy full-byte native
   inference and restart counts, then README/handoff. All consumers already understand the
   representation. Root integrates/enables only after the complete union independently
   passes its full envelope. This is the first feature-completion candidate.

POST/DELETE mutation shapes remain unchanged, with no new capability header/query/body.
AfterQ2 an old POST may return202, then progress1 explicitly refuses406 while an artifact
is pending; progress2/result/stop remain usable. This client pairing is upgrade-required,
not fully backward-operable. Test exactly that pairing; no mutation retry/partial-success,
blob hydration or excerpt substitution is permitted. Q2 replaces Q1's mutation restriction
with real v3-preserving add/remove rather than retaining an availability workaround.

DSH can author the specified schema/adapter code, pure tests and type checks. It must not run
nested-sandbox, native/helper filesystem or full/browser suites. Give it resolved project and
skill paths, exact checkout/HEAD, Node26, root runtime owner, assigned ports/data, shared lock
location, owned paths and pure-only commands. Independent GPT 6.1 Sol/high reviews pinned
diffs, including adversarial FIFO/stop/privacy/mixed-version cases, and runs the root-approved
helper/native fixture scope through heavy. Fix findings in separate commits. No author
self-certification. A round that merely adds schemas cannot claim queue completion.

## 9. Falsifiable acceptance matrix

Every row is required evidence, not an assertion that the work has already passed.

| ID | Preconditions/action | Exact required observation |
| --- | --- | --- |
| Q01 | New small/16 KiB/exact+1/multi-chunk Unicode queue inputs, including surrogate and markers. | <=threshold inline; above threshold artifact branch only; independent Buffer bytes/checksum/size exact, correct bounded excerpt and no full tail in new snapshot. |
| Q02 | Add equal large text twice with distinct item IDs. | Two FIFO work items, one same-session metadata/blob digest; no ID collapse. Same append expectedSeq/idempotency returns one event, conflicting reuse refuses. HTTP retries have no new exactly-once promise. |
| Q03 | Block first queue write; concurrently add second and remove an earlier item. | Recorded snapshot order equals FIFO admission, every accepted remaining ID exactly once; no stale overwrite; removals before selection never dispatch. |
| Q04 | Existing pending v1 oversized item, then new add/remove. | Old event unchanged; new v3 snapshot normalizes retained large data to artifact; progress2 legacy preview before normalization contains no tail, legacy progress semantics explicit. |
| Q05 | Held write; explicit stop, failed helper, abort, deposed home/attempt. | stop returns without waiting; zero uncommitted acceptance; exactly one intervention before exactly one terminal when current attempt owns it; zero native events after turn.done; stale owner commits0, later item dispatch0. |
| Q06 | Successful large queued consumption while fake provider captures requests. | One queued prompt with the exact original queue ID, one first request containing full verified current-scrubbed bytes (tail present), never excerpt; no duplicate consumption; one fresh R1 run/attempt per consumed item. |
| Q07 | Delete/tamper/foreign-reference/wrong media/size/checksum/invalid UTF-8 artifact; change roots/symlink parent. | One new live preparation attempt/turn records exactly one content-free error/terminal, selected ID remains pending, zero prompt marker/provider/tool calls, no writes to completed prior turn or skipped-to-next dispatch. |
| Q08 | Leave/stop/home handover while read or replay held, or between resolution and next prompt append. | Zero next dispatch; preparation-owned cancellation truth, unavailable/sealed mutations reject; current fence rechecked after awaits; no second lease/writer or old-turn append. |
| Q09 | Restart at queue acceptance, before prompt commit, after prompt commit, and after provider admission. | Reopen inference count0 in every case; pending/consumed IDs truthful; later explicit continuation does not reconsume a committed ID. Document uncertain crash dispatch window. |
| Q10 | Known-value secret at write; late secret crosses stored excerpt edge; marker expands at projection; ordinary decorative bracket controls. | Secret/full-tail absent from REST/SSE/export/query/progress/UI; no partial registered-secret prefix; bounded exact excerptBytes; closed real markers and ordinary UTF-8 prefixes correct. Stored payload immutable. |
| Q11 | Native progress1/default vs progress2 over inline, legacy-large and artifact queues. | v1 exact old full text or typed406 when pending artifact exists; never excerpt in text. v2 strict expected branch, no tail, no blob reads for previews; result JSON unchanged. |
| Q12 | Mixed v1/v2/v3 log, max1/max2/max3 REST and SSE, unsupported event at first/middle/page boundary and after reconnection. | Actual required2/3 correct; no unsupported payload/frame; last valid cursor retained; error SSE has no id; max3 receives exact IDs once; no infinite reconnect retry on terminal version error. |
| Q13 | Export maximum1/2/3; query-tool audiences; queue search/FTS. | Older maxima refuse before incompatible bytes, export3 schema valid, reasoning absent, queue search_text NULL, no artifact opens to make previews. Tail sentinel absent from every new public representation. |
| Q14 | Fresh/global33 DB, competing initialization, injected DDL failure, future component ledger, reopen. | Independent40 installed once/atomic; main user_version33 and migration1–33 bytes unchanged; ledgers34–39/settings/history unchanged; failure/future refusal leaves no partial trigger/ledger change. |
| Q15 | Raw SQL v3 insert with malformed item, duplicate IDs, missing/foreign/mismatched metadata, opposite-branch fields, wrong type/version. | Database rejects each, head/FTS/metadata transaction unchanged. Valid multi-artifact snapshot commits all metadata/event or none. |
| Q16 | Mobile/desktop, EN/RU, keyboard remove, reload/SSE duplicate replay, reduced motion, offline/version error. | Exact queue li count/order/ID, exactly one DELETE, removed item count0, tail absent from DOM, preview label/source truthful, focus retained/returned, no horizontal overflow or animated insertion; states accessible. |
| Q17 | CLI normal and cancelled polling on versioned progress; old-node adapter fixture if supported. | Both polls parse correctly, no input echoed, result stdout stays one version1 JSON record and exit codes unchanged; cancellation remains confirmed or explicitly unconfirmed. |
| Q18 | Existing prompt/tool/encoding/retention/fence/privacy suites unchanged. | Previously asserted exact bytes, helper settlement, receipt gate, ancestor safety, FIFO and retention properties still pass; no total-memory claim inferred from them. |
| Q19 | Late registry expansion takes stored inline text over16KiB. | Content-free refusal, no cursor/consume/dispatch, original input preserved; no executable truncation. |
| Q20 | Cold runtime import/parse from both public event/native entry paths. | No initialization cycle; one strict shared runtime schema, unchanged v1/v2 controls. |
| Q21 | Q1 seededv3 pending artifact plus another item, add/remove either/duplicate remove. | Exact typed409; head/count/metadata/blob unchanged, read/progress2/stop/verified consumption usable. This is the restricted reader rollback floor. |
| Q22 | Q2 old POST with large input then default/progress1 and progress2. | POST202, old GET typed406, new GET2 valid, result/stop usable; no hydration/partial success/retry. |

Use independent test oracles: Buffer for exact bytes, explicit fixture spans for marker cuts,
DB/event counts for no duplicates, controllable deferred promises for races, and a recording
fake provider. Do not count visibility as no-duplication proof or copy the producer predicate
into the expected output. Register every new test separately from the inherited envelope.

## 10. Future check commands and exit boundary

These commands are a plan only and were **not run**. Root prepares an isolated clone with
its own dependencies, assigns free ports/data, and confirms local @guanxi resolution. DSH
runs pure schema/projection/append-queue tests and `tsc --noEmit -p packages/server/tsconfig.json`
plus affected package type/lint checks only. Root/reviewer runs real helper/native fixtures:

```sh
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  node --test packages/server/test/session-log-queue-artifacts.test.ts \
  packages/server/test/session-log-version-negotiation.test.ts \
  packages/server/test/session-log-routes.test.ts \
  packages/server/test/session-log-truncated-egress.test.ts \
  packages/server/test/egress-truncated-prefix.test.ts \
  packages/server/test/native-agent/queue-artifacts.test.ts \
  packages/server/test/native-agent/input-artifacts.test.ts \
  packages/server/test/native-agent/review.test.ts \
  packages/server/test/native-agent/crash.test.ts \
  packages/cli/test/agent-exec.test.ts
```

Then root runs separate source-bound typecheck, lint, npm test, browser gate, build,
lint:md/link and license gates on the **combined final pin**, one heavy command at a time.
Stop at the first failure; no stale/skipped/helper-unrun result is called green. Web edits
require the browser gate and appropriate UI gates. No live model, paid provider, network
service, Docker/SSH, hardware or owner keys are needed; do not widen the current envelope.

Done means new queue snapshots/progress2/export3 are bounded per item and execute full
verified data under current privacy and ownership, compatibility refuses explicitly, the
matrix has direct assertions, review fixes are separate commits, and root folds evidence
into PHASE/NEXT. Still open: old immutable inline snapshots, whole read/replay/provider
buffers, HTTP body/full scrubbed strings, total queue count growth, per-blob GC, command
output tail recovery, peak RSS/end-to-end streaming, platform expansion and operational
K4/MS1 exits. This slice closes none of those residuals.


## Root Q0 authorization and exact ownership

Implement only Q0 now: contract shared-leaf/v3/progress2 definitions; independent40 append/
reader/privacy/version/export support; inspector max3/export3 and bounded rendering; seeded
v3 contract/log/migration/routes/inspector assertions and current READMEs/handoff. Native
service/plugin/routes, native UI and CLI producer/consumer changes belong toQ1/Q2 and are
not authorized here. Existing native producer emitsv1; native progress stayslegacy untilQ1.
Do not insert an inert feature flag then advertise runtime completion. Q0 is unreleased
foundation and cannot be the native rollback floor by itself.

Own contract event/shared-leaf exports only as necessary; session-log queue-schema/log/
excerpt/routes/projection/query-tool as needed; inspector API/model/page and locale keys;
proportional existing/new contract/log/inspector tests; lane docs. No deps/lockfile/pinned
helper/schema1–33/independent34–39/snapshots/approvals/token changes. Reuse existing UI
components/public imports and EN/RU keys. Independent GPT6.1Sol/high reviews after clean
handoff and runs real log/helper/browser checks. Author pure contract/schema/projection
checks and tsc/lint only, no real native/helper filesystem/browser/build/full suites in DSH.
Own npmci is root-installed first; source quiet for every command. NoSSH/provider/model/
ownerdata/push/central-status edits. Root updates PHASE/NEXT only after actual integration.

## Root-authorized independent Q0 review repair

Independent review at clean `92637fb1` requests changes; report is outside
`reviews/codex-k4-queue-v3-Q0-20261022.md`. Repository62 cases are32 new/30 inherited,
58pass/4fail (`check-iada7ni5`); original outside controls2pass/3fail (`check-h90odbgf`).
Broader component/browser/native stages stopped and are still unrun. This round closes:

1. Remove the exported installQueueSchema opt-out. Independent40 is mandatory even with a
   future/invalid ledger; no caller/test switch may bypass it. Replace the historical31
   migration fixture's modern SessionLog writer with test-local valid legacy session/writer/
   four-event SQL, preserving existing trigger/hash/sequence/timestamp/adoption/rollback
   assertions. Do not change applied global migrations or manufacture a production fixture API.
2. Root authorizes only the necessary native legacy type-boundary exception: the original
   agent.queue branch must explicitly refuse non-v1 with the existing content-free
   agent_unavailable before assigning narrowed legacy items. Never silently ignore v3 and
   retain an earlier v1 queue. No native v3 consumer/progress2/hydration/dispatch activation
   or new HTTP406 schema is authorized; Q1 remains a later restricted-reader slice.
3. Correct three null-prototype node:sqlite row assertions by comparing actual values or
   explicit plain projections, with exact count/version retained. Correct the FTS oracle:
   external-content rowid existence is not indexed text. Keep/assert search_text NULL and
   MATCH/log.search negative controls plus a positive indexed-text control. No weaker privacy
   assertion or production index change is justified by these test failures.
4. Fix inspector boundedPreview so a decorative `⟦` is ordinary text. Recognize only the
   actual marker syntax when avoiding a clipped marker, preserve maximal valid UTF-8 prefix,
   enforce the real byte bound and protect real-marker controls. Original outside probe must
   pass unchanged; do not erase legitimate text to avoid a privacy test.
5. Add the missing actual competing-initializer/held-writer assertion from Q14, with separate
   SQLite connections/processes and explicit synchronization. Both constructors must observe
   one committed ledger40/unchanged trigger after serialization; no partial ledger/DDL,
   stale pre-lock version acceptance or timing-only claim. Author it for root/reviewer actual
   execution; no SQLite/helper/native/browser checks inside DSH.

Commit discriminating tests before each minimal fix where practical, separate test-oracle
repairs from production fixes, then exact handoff new/envelope and unrun evidence. Preserve
the outside controls' bytes and accepted v1/v2 meanings. No status/snapshot/signature/dependency/
policy expansion. All prior reviewer checks are terminal; source ownership returns to author
until a clean final handoff, then the same independent reviewer reruns original controls.
