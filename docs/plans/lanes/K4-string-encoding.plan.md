# K4 next local slice: bounded UTF-8 write encoding

Status: accepted bounded implementation contract; root authorization recorded below.
Inspected main `a9b54e06a3b5853e015d977059e8188b18b9170e` and its K4 evidence, 2026-10-22.
The independently reviewed privacy fix is separately integrated at `aa878593`; its combined
checks are root-owned and not claimed complete here. No source/check/container/model/remote
operation was performed for this plan. This outside file is the only artifact written.

## Recommendation and scope judgment

Authorize **string-input write-side encoding with bounded auxiliary byte buffers** next.
`SessionInputStore.write()` and `utf8Excerpt()` currently encode an entire string into a new
Buffer even though the pinned helper already accepts an AsyncIterable of byte chunks.
Removing these copies is the smallest useful local vertical slice: exact bytes/digests,
artifact publication, v2 descriptors and native prompt/tool consumers can remain compatible.
It needs no new wire version, migration, UI or paid/live test. Do not call it end-to-end
bounded-memory input, queue artifactization, full K4 or MS1 completion.

Queue artifactization is the next functional storage slice, but is not a safe mechanical
extension of prompt/tool v2: it crosses queue event, progress API, replay, clients and version
negotiation. Specify and authorize that separately rather than silently replacing `text`
with an excerpt. The next section records the actual gap and required compatibility work.

## Current behavior and remaining exit evidence

| Area | Current source/evidence and status |
| --- | --- |
| Accepted modes / roadmap exit | D-111/D-118 and ADR-0027 accept Full access / Read-only behavior. ROADMAP K4 names OS read/write/egress boundaries, zero-root scratch-only behavior, stable exec JSON and <=300-token orientation. Existing K4 evidence carries local fixtures and named platform limits; this plan supplies no new operational evidence. |
| Native R1 / retention | K4-followup-2 records merged bounded completion, not original missing scope. Preserve home/attempt fences, one FIFO, cleanup ownership/quarantine, user-vs-model retention activity and no inference replay after restart. |
| Input artifacts | Migration33/v2 prompt+tool CAS, exact tool-call acknowledgement, replay verification and session deletion are implemented. Queue references, bounded-memory streaming, per-blob GC and output-tail recovery remain explicitly open. |
| Large-payload design | ADR-0023 is proposed except accepted reasoning policy; section4 is not independent blanket approval to rewrite every event. Current root-authorized bounded K4 work is the implementation authority. ADR-0021 likewise remains proposed; do not relabel either accepted. |
| HTTPS/UI/platform | Evidence/K4 continuation retains a reviewed Mac HTTPS-positive candidate and missing expanded UI/platform scope. Other kernels/architectures, Docker Desktop/distribution licensing, real assistive speech and production deployment require their own envelope. None are resolved by changing encoding. |

Owner decisions D-110 (light harness), D-141 (known-value redaction), D-189 (interactive
headroom) and the current explicit local-only instruction apply. No arbitrary input/queue
ceiling may be introduced as a substitute for representation or memory work.

## Actual queue and memory paths

- `native-agent/service.ts:249-269`: queue/remove read the current projection and append one
  immutable `agent.queue {items:[{id,text}]}` snapshot inside the attempt FIFO. The accepted
  text is copied into every later pending snapshot. Concurrent mutation ordering is fixed;
  do not revert to taking a snapshot before FIFO admission.
- `service.ts:203-229`: progress reads session events, takes the last queue snapshot, and
  removes IDs already consumed by prompt messageId. It returns the remaining full text.
  Consumption hides it from the current queue, but cannot remove earlier immutable events.
- `service.ts:329-345`: the launch loop executes `queue[0].text` after the prior run completes;
  it rebuilds history and starts a fresh R1 attempt. Restart does not automatically dispatch
  pending inference. A queued text must never be replaced by its display excerpt here.
- `contract/events/session-events.ts:157` and `contract/native-agent.ts:50`: event/progress
  queue items both require `text`. The native page renders that field; HTTP queue accepts
  full text. The v2 union and migration33 admit only prompt/tool.call artifact payloads.
- `service.ts:482-541`: prompt strings are fully scrubbed; tool arguments are fully scrubbed
  objects and canonical JSON strings. Large values become artifact references after the
  full representation exists. `utf8Excerpt()` then makes another full UTF-8 Buffer to keep
  only its first8KiB.
- `session-log/input-artifacts.ts:254-284`: `write()` copies the whole string/Uint8Array to
  a Buffer and hashes it, then sends it to the pinned helper. `pinned-directory.ts:320-332`
  already supports AsyncIterable<Uint8Array>, checks the verified cwd first, and streams with
  backpressure. Its write/verify path uses bounded chunks; change of helper protocol is not
  needed for the recommended string path.
- Reads are different: the helper read path collects chunks, concatenates and base64-encodes
  the whole artifact into one JSON line; the parent decodes it. `service.ts:600-651` decodes,
  re-scrubs/parses full inputs and builds a full AgentMessage history. Those read/replay/model
  boundaries, objects/strings and input transport remain whole-input buffers after this slice.

## Exact proposed DSH implementation contract

Target: a root-prepared isolated clone based on the final reviewed U1/K4 privacy union after
its gates, not this stale main or a live candidate. Keep existing dependencies and Node26
resolution local; root assigns ports/data and reviews the clean pin. Only local synthetic
fixtures; no model/account/owner workspace/containers/SSH. Root alone owns heavy/full gates.

Owned production files: `session-log/input-artifacts.ts`, a small new private
`session-log/input-encoding.ts` if useful, and their README. New encoding unit tests plus
proportional existing `session-log-input-artifacts.test.ts` and
`native-agent/input-artifacts.test.ts` assertions. Avoid touching shared pinned-directory,
egress, native service, wire schemas, migration33, UI or dependencies unless a demonstrated
contract issue forces a root-approved seam. No code copying or notices entry is needed.

1. For immutable **string** input, use a restartable bounded UTF-8 chunk iterator, with at most
   the existing64KiB transport chunk as one encoded byte allocation. First pass computes exact
   SHA-256 and safe-integer byteSize; second pass feeds the same bytes as an AsyncIterable to
   the existing pinned write helper after its identity handshake. No full `Buffer.from(text)`,
   full `TextEncoder.encode(text)`, joined chunk array or whole encoded copy is allowed.
2. Preserve Node UTF-8 semantics exactly, including surrogate pairs across chunk boundaries,
   lone surrogates, empty strings and all UTF-8 boundary lengths. A code-unit slice must not
   turn half a pair into a replacement character. Count bytes from encoded chunks and refuse
   unsafe size arithmetic with a content-free existing error code.
3. Chunks handed to writable stdin must retain immutable bytes while queued. Existing
   `writeStdin()` waits for `drain` only when write returns false; it does not acknowledge
   every true write. Therefore do not reuse/mutate a yielded backing buffer immediately.
   Yield owned bounded chunks (or explicitly await each write callback under a separately
   reviewed change). Avoid changing this shared primitive just to optimize one copy.
4. `utf8Excerpt()` must stop after the requested bounded prefix, without encoding the full
   string. Preserve existing return/UTF-8 semantics and the published8KiB default; use the
   integrated privacy marker rules so a new cut does not split a known redaction marker.
   Its caller's requested bound is not a new total-input limit. Complete fitting strings
   retain their representation; a malformed/unsupported bound must fail content-free.
5. Preserve the public `write(string | Uint8Array)` API and existing Uint8Array snapshot-copy
   semantics. This first slice may leave that byte-input copy unchanged and must say so.
   Silently replacing the copy by a mutable caller-owned view changes the checksum contract.
   No caller/provider/replay stream API is introduced.
6. Preserve abort/failure semantics: pre-abort emits no payload; identity is verified before
   the transport iterator is pulled; cancel/backpressure failure stops and awaits helper
   settlement, cleans only its temp and cannot delete an already-published digest. Do not
   add timeout-based release, absolute-path payload IO, new argv/env data, automatic retry,
   or a bypass around the current R1 post-await fence / K2 transaction / tool-call gate.
7. Preserve exact `(sessionId,checksum)` dedupe, file modes, fsync/link/verify protocol, errors,
   metadata/excerpt shape, event versions and session retention/deletion. The native dispatch
   must still await initial prompt persistence; tools still await their exact durable receipt.
   No benchmark/routing/prompt change is proposed: model-visible bytes must remain equal.

### Required falsifiable assertions

- A table of strings including ASCII, BMP, supplementary characters, lone surrogates and
  code-point pairs straddling the64KiB boundary: independent `Buffer.from(original,'utf8')`
  oracle in the TEST ONLY equals concatenated test output, byteSize, checksum and stored
  readback. Test0/1/exact-chunk/chunk+1/multi-chunk and16KiB threshold boundaries.
- Allocation instrumentation rejects a whole-large-input encoding/copy in write and excerpt
  construction. Observe bounded iterator chunks/allocation sizes rather than claim an RSS
  ceiling; fixture input and crypto/native internals are outside that measurement. A guard
  restoring the old full-string Buffer path must fail this assertion.
- Exact published bytes from a large synthetic Unicode string; two writes dedupe and do not
  change a published digest after a later failed/canceled write. A short byte-input control
  still takes the existing snapshot, including caller mutation while the helper is held.
- Deferred/held helper handshake consumes zero transport chunks and writes zero input bytes
  before validation; deliberately failed identity has zero payload. Backpressure/cancel
  exercises owned immutable chunks, no corruption, bounded queued data and actual helper
  close before write settlement. Preserve ancestor-swap and published-file survivor tests.
- Excerpts equal the intended UTF-8 prefix within8KiB, have no replacement caused by splitting
  a valid pair and no split redaction marker; complete values and native16KiB representation
  thresholds stay compatible. Keep all19 integrated privacy assertions unchanged.
- Fake native provider observes the same full large prompt and canonical tool arguments,
  initial storage failure means zero dispatch, failed tool receipt means zero tool effects;
  existing FIFO concurrent queue/stop/fence/retention tests remain intact. No inline queue
  offload is credited. No content in logs/argv/env or extra source metadata appears.

Pure unit/type checks may run locally in the clone. Filesystem/helper/native fixture envelope
must use shared `~/.local/state/agent-dev` resource `heavy`; the mechanical DSH host follows
its existing nested-sandbox restriction and root runs any such envelope outside that worker.
Independent GPT review follows source pin; root owns final integration/full checks.

Compatibility/rollback: no persisted format or schema change, backfill or data rewrite.
Reverting this encoding implementation preserves the same artifact bytes/references. Keep
pre-migration33 rollback restrictions unchanged: a pre-v2 binary still cannot consume a
v2-bearing DB. Stop if digest/UTF-8/receipt identity differs; do not "repair" stored hashes.

## Queue artifactization: required subsequent authorization

Before implementation, root must approve a real wire/data transition. Suggested direction:
new queue event envelope version3 with item IDs plus inline-small text OR the same session
input reference and bounded excerpt. Update the strict queue/progress schemas, log append
metadata transaction, migration guard (new root-reserved global slot, never rewrite33),
projection, native consumer, REST/version negotiation, query/search/export/SSE and web/CLI
consumers together. Exact schema/version design remains a proposal, not decided in this plan.

Merely adding `agent.queue` to v2 is insufficient: already-shipped max2 parsers do not know
that new shape. A new server must refuse before the first unsupported version with no cursor
advancement; an old server does not magically learn the new error. A progress response that
replaces `text` with an excerpt also needs explicit compatibility, not a silent meaning change.
No public endpoint should rehydrate full queued artifacts just to draw a preview.

The FIFO must publish queue acceptance only after artifact+event metadata commit under the
current home/attempt writer, preserve concurrent queue/remove and stop intent, and re-resolve
an exact same-session/checksum reference before consumption. A failed/missing/foreign artifact
means zero prompt/model dispatch; never execute the excerpt. Preserve queue item ID as the
consumed prompt messageId, one new R1 attempt per consumed turn, removal-before-consumption
semantics and restart with zero automatic inference. Existing inline histories stay readable
and immutable; old snapshots remain large until normal session deletion. Per-blob deletion
cannot remove bytes still referenced by any historical queue/prompt event.

Its tests need exact queue order/IDs under blocked write/remove/stop/fence races,0inline large
queued bytes in new event/FTS/progress/export, useful previews with current privacy projection,
exact full bytes reaching the fake model once, valid migration rollback and max2/max3 SSE/REST
boundaries. It needs proportional mocked browser/keyboard removal evidence because the user
queue representation changes. No real provider or other host is needed to implement/test this
contract locally; root must still explicitly authorize schema and consumer changes first.

## What remains operational or owner-dependent

No new owner product decision is needed for the recommended encoding slice; root authorization
and clone assignment are enough. Queue wire/progress policy and migration allocation need the
root's concrete acceptance before code. True end-to-end bounded memory would additionally
need a read/replay/provider contract that cannot execute unverified bytes; changing only the
helper read stream cannot make pi-core's full message history and JSON model input disappear.
A measured peak-RSS/latency claim needs a named representative local workload and baseline,
not just bounded chunk unit assertions. Platform expansion, real language/tools/providers,
physical suspend, production privacy/security and >=6h MS1 retain their separate envelopes
and current local-only restriction. This recommendation closes none of those gates.

## Root authorization and checkout binding — 2026-10-22

Root authorizes the recommended string-write/excerpt slice only in the standalone clone
`/Users/yuzuru/Projects/Guanxi-lanes/k4-string-encoding`, branch `codex/k4-string-encoding`,
prepared from independently reviewed U1/privacy source `aa878593`. Own offline installation
passed `check-5v7wilx3`, clean and unchanged. `@guanxi/contract` resolves inside this clone.
The original plan's inspection pin remains historical context. U1 final gates run separately;
root authorizes this isolated preparation before those gates finish, without claiming they
already passed. Root corrected two inherited handoff blank lines; no executable change.

Clarifications: first-pass hashing necessarily encodes chunks before the storage handshake;
zero-before-handshake applies to transport bytes/transport-iterator consumption, not hashing.
Keep owned immutable chunks, exact Node UTF-8 bytes and complete-string excerpt semantics,
including lone surrogates. Requested excerpt bound zero is valid; invalid bounds fail with
content-free errors. Whole-marker clipping is the only intended excerpt representation repair.
No shared helper/egress/native-service/contract/migration/UI/dependency change is authorized.
Keep queue storage, end-to-end streaming, byte-input snapshot copies, full read/replay/provider
buffers and all operational stage exits explicitly open. Root runs heavy helper/filesystem/
native checks; DSH runs pure focused tests only. Independent GPT review follows a clean pin.
