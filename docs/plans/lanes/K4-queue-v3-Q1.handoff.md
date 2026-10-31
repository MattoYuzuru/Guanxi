# K4 queue v3 Q1 handoff

**Status:** Q1 implemented by its author and its independent review findings fixed (see
"Review findings and fixes" and "Review round 2"); scoped checks pass. The review found no Critical or High issue and
the focused re-review of the first fixes found none either; round 2 itself has not been re-reviewed
and no hosted CI has run. Q2 is not started. Date: 2026-11-01.

- Worktree: `/Users/yuzuru/Projects/Guanxi/.claude/worktrees/agent-a7420ea54d5e47359`
- Branch: `lane/k4-queue-q1`, from `lead/wave8` `2b8cf843`. Ports 5242/4442, data `.lane-data`.
- Plan: [`K4-queue-v3-Q1.plan.md`](K4-queue-v3-Q1.plan.md) (scope, files, defaults used).
  Parent: [`K4-queue-v3.plan.md`](K4-queue-v3.plan.md); Q0: [`K4-queue-v3.handoff.md`](K4-queue-v3.handoff.md).
- Commits: `b2f9d198` plan; `3e1499df` server reader/progress/restriction/preparation;
  `7a19666a` web + CLI + tests; `fc593f06` docs/handoff; review fixes `25b61186` (production,
  contract, web strings, README) and `01a27f8a` (tests); this section's docs commit is HEAD.

## Changes

- **Contract** (`packages/contract/src/native-agent.ts`): `nativeQueueProducerUnavailableSchema`
  (`{code:'native_queue_producer_unavailable'}`, strict). Nothing else on the wire changed;
  progress2, the query and the 406 body were Q0 definitions.
- **Server** `native-agent/queue-state.ts` (new): the internal executable union, the latest
  snapshot of any version with consumed ids removed, the legacy projection (artifact refuses),
  the v2 projection (`legacy-preview` for an oversized legacy entry) and the restriction
  predicate.
- **Server** `native-agent/service.ts`: `progress()` (legacy, typed `NativeProgressVersionError`),
  `progressV2()` (strict-parsed, fail-closed `agent_unavailable`), `result()` from an internal
  `snapshot()`; add/remove inside the FIFO refuse with `native_queue_producer_unavailable`
  before any write; the consumer loop selects from fresh events, allocates the next attempt
  first, and prepares through `queuedTurn()` (store read, strict UTF-8, current scrub, replay,
  owner rechecks after each await and once more synchronously before dispatch); the new
  `Active.preparing` FIFO keeps mutations closed while still receiving stop and the failure
  record; `writeFailureTerminal` reports `input_artifact_unavailable`; side-chat Send's receipt
  reads the internal state.
- **Server** `routes.ts`, `plugin.ts`: strict `progressVersion` query; 406 and 409 bodies;
  `progressV2` on the plugin service.
- **CLI** `agent-exec.ts`: both polls request and parse progress2; result record and exit
  codes unchanged.
- **Web**: `nativeApi.progress` asks for progress2; one row per queue item; artifact and
  legacy-preview rows show the stored excerpt with a bounded-preview line (EN source, curated
  RU in `messages.ts`); a refused mutation shows its own explanation; story and browser fixtures
  moved to the v2 body.
- **Docs**: native and session-log READMEs, a pointer in the parent plan, this hand-off. No
  `PHASE_STATUS.md` / `NEXT_AGENT_PROMPT.md` edits (root owns them).
- **No migration, no dependency, no change to ledger 40, retention, sandbox or the store.**

## Properties and their tests

New file `packages/server/test/native-agent/queue-v3-reader.test.ts` (20 cases) unless noted.
"Mutation check" is the production line reverted to confirm the test fails.

| Row | Evidence | Mutation check (result) |
| --- | --- | --- |
| Q06 | seeded v3 artifact then inline: one `queued` prompt per id, one request each with the full bytes and tail, one new run per item; legacy oversized inline consumed whole and freshly scrubbed | consume the excerpt instead of the bytes: 11 cases fail, including this one |
| Q07 | 7 variants (missing blob, same-size tamper, truncated, invalid UTF-8, metadata checksum/size/row differing): one `error`, failed terminal on a new run, zero prompt/provider/tool, selected id and the next stay pending | skip the failure record: 8 fail; no new attempt before preparation: hangs (timeout, detected) |
| Q08 | stop during a held read: sealed mutations, one intervention before one cancelled terminal, nothing dispatched; leave during a held read: failed truth, nothing dispatched; deposed home: zero commits and dispatches | reopen mutations early: fails; stop ignores the preparing FIFO: fails; owner rechecks made no-ops: leave case fails (later re-pinned by the review cases) |
| Q09 | reopen starts no inference; explicit continue consumes once, never again; restart after the prompt commit leaves the id consumed and the sibling pending, count 0 | do not filter consumed ids: runaway consumption, detected as timeout |
| Q11 | progress1/default exact text, typed 406 with a pending artifact, progress2 branches with exact `byteSize`/`excerptBytes`, no tail, zero blob reads (store hook), strict query 400, `/result` keys unchanged; v3 inline-only answers progress1 | legacy progress approximates artifact by excerpt: fails; preview treated as inline: fails |
| Q21 | five refusals (POST queue, DELETE of each id, a never-existing id, POST prompts) are exact typed 409; head, event count, metadata rows, blob files and read count unchanged; progress2, result, stop work; consumed v3 no longer blocks | restriction removed: fails; result through legacy progress: 13 fail |
| rollback floor | Q1 production (add, remove, consume a >16 KiB item) writes no v3 event and a `maxVersion: 2` read has no boundary and the same event count; seeded v3 gives a max-2 reader `requiredVersion: 3`, and Q1 still reports progress2 and result | covered by the Q21 and Q06 mutations (the v1 production path is existing behavior) |
| side-chat | Send onto a pending v3 queue: `agent_unavailable`, head unchanged | restriction removed: fails |
| Q17 (`cli/test/agent-exec.test.ts`, 3 new) | both polls use `?progressVersion=2`, all three queue branches parse, stdout record and exit codes unchanged, an old-node legacy body fails closed, a non-progress2 body never confirms a cancellation | poll URL reverted to unversioned: both Q17 cases fail |
| Q16 (`web/test/component/native-agent.test.tsx`, 3 new `it`, 5 cases EN/RU) | one row per item in order, preview wording, artifact id absent from the DOM, exactly one remove call with that id, refusal explanation with exactly one DELETE, progress2 request and fail-closed on a legacy body | detail line removed: both row cases fail |

Mutation runs 1 (M1–M4, M8) were made on a loaded machine and an over-strong assertion in the
stop case ("wait is still pending") also failed in every row; that assertion was a race with an
abort-aware read, not a product property, and was replaced by the synchronous-return check
before the later runs (M5–M13), which were clean. The required tests failed as listed.

## Commands and results

All server runs: `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test ...`
with the lane ports and data dir. Results after the review fixes (HEAD):

| Command (suites included) | Result |
| --- | --- |
| Server: `queue-v3-reader` (20 new), `queue-v3-review` (17 new), `queue-v3-round2` (6 new), `native-agent/{agent,input-artifacts,crash,review,side-chat,lifecycle,tool-errors,port-wiring}` (92 envelope), Q0 `session-log-queue-v3-{contract,projection}` (14 envelope) | 149 tests, 149 pass, 0 skipped (after round 2); `cleanup`, `migration`, `outputs` (4 envelope, delete path) also pass |
| `packages/cli/test/agent-exec.test.ts` (3 new, 4 envelope) | 7 pass |
| `vitest run test/component/native-agent.test.tsx test/component/side-chat.test.tsx` (native: 7 new, 29 envelope; side-chat: 29 envelope) | 65 pass |
| `agent-dev ... --resource heavy` `test:browser`: `native-agent`, `native-session-timeline`, `side-chat`, `phone-shell` specs (20 envelope) | 20 passed, receipt `check-pgjj1_li` |
| `npx tsc --noEmit -p` contract, server, cli, web | exit 0 each |
| `npx eslint` over changed server/web/contract files | no output |
| `npm run ui:check` | no failing gate |
| `markdownlint-cli2` on the touched docs, `scripts/check-doc-links.mjs` | 0 errors, 0 problems |

`packages/server/test/native-agent/sandbox.test.ts` is not part of this set. It fails 2 of 33
cases in this worktree only (`listen EINVAL` on `.lane-data/k4-sandbox-*/root/pipes.sock`)
because the long worktree path makes the Unix socket path exceed macOS's 104-character
`sun_path`. That is environmental; the test was not changed.

Not run: full `npm test`, the full browser gate, build, Storybook, the Q0 session-log files that
Q1 does not touch, and hosted CI. The external `guanxi-ui` symlink makes agent-dev receipts
non-reusable.

## Counts

- **New in Q1 (cumulative):** server 43 (20 `queue-v3-reader`, 17 `queue-v3-review`, 6 `queue-v3-round2`), CLI 3, web
  component 7 cases (5 original + 2 for the new failure messages), plus the shared helper module
  `queue-v3-support.ts`.
- **Changed expectations, none weakened:** `agent.test.ts` "legacy progress ..." (Q0 interim guard
  replaced by "newest snapshot defines the queue"); the `queue-v3-reader` side-chat case now
  expects the typed floor error instead of `agent_unavailable` (review item L2); CLI, component
  and browser fixtures moved to the progress2 body.
- **Regression envelope:** the 92 other native-agent cases and 14 Q0 cases above, 4 CLI, 29 + 29
  web component, 20 browser. A file is never credited twice.

## Review findings and fixes

The independent review found no Critical or High issue and confirmed consumption and crash
behavior on every probe. Fixes are in `25b61186` (production, contract, web strings, README) and
`01a27f8a` (tests, with the mutation checks below). Mutation = the production line reverted,
then the new and old queue tests rerun.

| Finding | Fix | Test and mutation result |
| --- | --- | --- |
| M1 stuck head | Named as an availability residual here and in the native README. `input_artifact_unavailable` (and `stored_data_invalid`) now have their own EN/RU web explanation instead of the generic session error | component test, EN and RU, asserts the specific text, "you can still stop", and that the generic text is absent |
| M2 late expansion over 16 KiB | `NativeAgents.readLog` maps the log's `stored_data_invalid` to the typed content-free `NativeAgentError('stored_data_invalid')` for every native read (progress, progress2, result, wait, prompt, mutations, idle stop). Residual named per design section 6 | native test: no prompt marker, zero extra requests, one `error` `stored_data_invalid` on its own attempt, stored payload byte-preserved, `wait()` and HTTP 503 typed; raw-log mapping removed: fails |
| M3 unpinned rechecks | *Superseded in part by review round 2 below.* Preparation reordered: image staging moves before preparation; the single `verify()` runs synchronously on return from `prepare()`, so no await separates it from the prompt append; the check after the artifact read stays and guards the replay. The check after replay was removed as redundant for dispatch safety (the synchronous check follows it with no await). The check before the read was removed in this round and **restored in round 2** | 6 cases: stop, leave and a deposed fence during a held read and during a held replay (the seed prompt is an artifact so replay really reads): zero extra requests, zero prompt marker, item pending, zero head delta for the fence, replay read count 1 after a held read. Final `verify()` made a no-op: the leave-during-replay case fails. Check after the read removed: leave and fence during a held read fail |
| M4 restart during preparation | none needed; promoted to a test | hold the read, `restart(..., true)`, release: zero head delta, zero extra requests, item pending, then one explicit turn consumes it exactly once |
| M5 tool path, default 2, preview scrub | README corrected: the agent `queue` tool refusal is a tool error result with the typed code, not an HTTP 409 | tool case: error result, turn completes, one `agent.queue` event. Duplicate: same operation id is refused, never `duplicate` (order swapped: fails). Preview: the read projection already scrubs a v1 snapshot, so through the public API `const text = item.text` is an equivalent mutation. A pure `queueV2Of` test with a scrub that expands a secret straddling the cut pins the function (mutation fails) and a native case pins the public result |
| L1 touch order | `sessions.touch` moved after the restriction check, inside the FIFO read block | refused add leaves `last_user_activity_at` alone, accepted add changes it (touch moved before the check: fails) |
| L2 side-chat Send | the shared typed 409 `native_queue_producer_unavailable` for a restricted queue (route-level). Send *during a queued turn's preparation* is 409 `session_busy` (the existing mapping of `session_not_running`), not 503; the 503 `session_not_running` applies to the direct queue routes and is documented in the README | HTTP case and the changed `queue-v3-reader` case (pass-through removed: both fail); the preparation case is pinned in round 2 |
| L3 BOM | `TextDecoder(..., { ignoreBOM: true })` | request contains the BOM, the durable prompt checksum equals the sha-256 of the exact bytes (decoder reverted: fails) |
| L4 strict query | contract schema accepts only the exact strings `1`/`2`; the route passes repeated keys as arrays | `02`, a leading-space 2, `2.0`, `0x2`, empty, repeated keys, `true` all 400; coerce restored: fails. Q0's own assertions still pass unchanged |
| L5 removeQueued read | the read inside the FIFO is returned, not thrown | a turn survives a refused read and its terminal is `completed` (throw restored: fails) |
| L6 accurate failure code | `preparationFailureCode` records `input_artifact_unavailable`, `stored_data_invalid` or `egress_unavailable` by cause; other errors take the generic truthful terminal | M2 case reads the recorded code (everything mapped to a missing input: fails) |
| L7 `attempt()` fails between turns | **Residual, not fixed.** With no allocated attempt no owner exists to write a record; the outer catch cannot append and completing the old run is a no-op. The session shows its last completed run with the item pending. Named in the README | none |
| L8 save during preparation | `sideChatSave` uses `active.queue ?? active.preparing` | a spy on `runs.append` sees both Save calls go through the attempt FIFO; the note exists once (fallback: fails) |
| L9 counts | rewritten above with the suites named | n/a |

Behavior changes a reader should know: an unreadable stored log now surfaces as the typed
`stored_data_invalid` (HTTP 503) where it used to be a raw log error (also 503); `progressVersion=02`
and similar spellings that the Q1 round accepted are now 400; side-chat Send onto a restricted
queue is 409 where it was 503.

## Review round 2

Focused re-review of the fix commits found no Critical or High issue and judged the dispatch
path sound. Fixes are in the round-2 production commit and `queue-v3-round2.test.ts` (6 cases,
new; the suites to rerun are `queue-v3-*` and `agent`).

| Finding | Fix | Test and mutation result |
| --- | --- | --- |
| M1 image staging order unpinned | none needed in code (the order is already staging, then `prepare()`, then the synchronous check); pinned by tests | leave and a deposed fence while a queued turn blocks on its image attachment (a FIFO replaces the staged file): zero requests, no prompt marker, zero reads of the queued artifact, zero head delta for the fence. Image block moved between the check and `agent.prompt`: fails (the case times out instead of asserting, since the blocked writer waits for a reader; it still fails) |
| M2 verify at the top, owner truth after a failure | a synchronous `verify()` is restored at the top of `prepare()`. `PrepareTurn` is now `{ prepare, verify }`; after a failed preparation `execute` re-runs the owner check, and a lost owner (stop, close, leave, a deposed fence) is **not** recorded as `input_artifact_unavailable`: it falls to the ordinary cancelled or failed terminal. README and the M3 row above corrected | a missing blob whose read is held while the session is left: failed terminal `agent_failed`, zero `error` events (classification by the abort flag only: fails). Top check removed: both image cases fail (the artifact read starts) |
| L1 `closed` and identity clauses | stated as defense in depth in the code and README: `close()` aborts every turn first, and no reachable state replaces `active` or `active.attempt` while a turn owns them. No test can reach them without a second owner | none (named) |
| L2 delete and the receipt lookup | session removal reads only the `agent.policy` event with a SQL type filter, so a stored queue that cannot be projected no longer blocks deletion; the side-chat Send receipt lookup uses `readLog`. The receipt lookup is unreachable with an unreadable log (the session check before it fails first), so it has no distinguishing test | deleting a late-expanded session succeeds and removes all rows (whole-log read restored: fails) |
| L3 `Object.hasOwn` | both `in` checks replaced | not distinguishable through the public API (an own code such as `toString` cannot be produced); defensive |
| L4 hand-off L2 row | corrected above; README side-chat section says Send during preparation is 409 `session_busy` | HTTP case: 409 `{code:'session_busy'}` |
| L5 abort signal in replay | `replay()` takes the signal and passes it to both history reads | stop during a held replay settles within 1.5 s with the read still held (signal removed: fails) |

## Defaults used

The ten defaults are in the plan. The ones a reviewer should look at first: (1) the restriction
applies only while the latest snapshot is v3 *and* still holds an unconsumed item; (2) it is
checked inside the FIFO and before the side-chat duplicate check; (4) a stop during preparation
records its intervention on the preparation attempt; (5) the failure code is
`input_artifact_unavailable`; (6) an unreadable event log at selection time becomes a preparation
failure instead of being swallowed; (9) progress2 clients against a pre-Q1 node are unsupported
and fail closed. No `OPEN_QUESTIONS.md` entry concerned this slice.

## Residuals

- Normal native production is still v1: no queue artifactization, an oversized legacy inline
  entry stays in an immutable v1 snapshot and progress1 still returns its full text (the named
  compatibility residual); progress2 shows the bounded preview instead.
- Hold windows: a session left or trashed during preparation ends with the generic failed
  terminal, not a cancellation. A crash between the prompt commit and the provider call keeps
  the documented uncertain dispatch window; restart never resumes inference.
- Q07 does not seed a foreign-session reference (the log refuses it by trigger and
  same-session metadata); the equivalent store check is exercised through the three metadata-row
  variants. Wrong media type cannot be seeded for the same reason.
- The whole prompt (read, scrub, replay) is still buffered; no streaming claim.
- Stuck head (review M1): a broken v3 artifact head fails every later turn that reaches it and
  cannot be removed until Q2 (removal is refused). The failed state is truthful and explained in
  the UI; the stored input is never skipped or changed.
- Late secret expansion (review M2): reads refuse content-free with `stored_data_invalid`, so
  progress, result and an idle stop are unavailable until the registry no longer expands the
  item; stop of an active turn still works. No truncation of executable text.
- Between turns, a failed attempt allocation leaves no log record (review L7).
- Web: the Remove button stays clickable on a restricted queue and answers with the explanation
  after the 409 rather than being disabled up front.
- No independent review, no hosted CI, no full local suites yet.

## What Q2 needs

- Q2 must also remove the stuck-head and late-expansion residuals' root cause where it can: a v3
  producer that normalizes retained items lets the person remove a broken head.

- Replace `v1Items` / `blocksV1Producer` with v3-producing add/remove: normalize retained
  oversized legacy entries to artifact descriptors, write blobs outside SQLite with abort, home
  and attempt checks around each await, then one atomic `appendNow({eventVersion: 3})`.
  Delete the Q1 restriction and its 409 route mapping/tests (Q21) in the same round.
- Add the Q22 pairing test (old POST 202, progress1 406, progress2 valid, result and stop usable).
- The `queuedTurn()` verification and the preparation FIFO need no change; the consumer already
  reads `ExecutableQueueItem`s.
- Side-chat Send onto a v3 queue should then be accepted again.
