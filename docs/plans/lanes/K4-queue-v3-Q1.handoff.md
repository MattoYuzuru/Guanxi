# K4 queue v3 Q1 handoff

**Status:** Q1 implemented by its author; scoped checks below pass. No independent review has
been done and no hosted CI has run. Q2 is not started. Date: 2026-11-01.

- Worktree: `/Users/yuzuru/Projects/Guanxi/.claude/worktrees/agent-a7420ea54d5e47359`
- Branch: `lane/k4-queue-q1`, from `lead/wave8` `2b8cf843`. Ports 5242/4442, data `.lane-data`.
- Plan: [`K4-queue-v3-Q1.plan.md`](K4-queue-v3-Q1.plan.md) (scope, files, defaults used).
  Parent: [`K4-queue-v3.plan.md`](K4-queue-v3.plan.md); Q0: [`K4-queue-v3.handoff.md`](K4-queue-v3.handoff.md).
- Commits: `b2f9d198` plan; `3e1499df` server reader/progress/restriction/preparation;
  `7a19666a` web + CLI + tests; the docs/handoff commit is HEAD.

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
| Q08 | stop during a held read: sealed mutations, one intervention before one cancelled terminal, nothing dispatched; leave during a held read: failed truth, nothing dispatched; deposed home: zero commits and dispatches | reopen mutations early: fails; stop ignores the preparing FIFO: fails; owner rechecks made no-ops: leave case fails |
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
with the lane ports and data dir.

| Command | Result |
| --- | --- |
| `queue-v3-reader`, `agent`, `input-artifacts`, `crash`, `review`, `side-chat`, `lifecycle`, `tool-errors`, `port-wiring` (native-agent) | 112 tests, 112 pass, 0 skipped |
| `packages/cli/test/agent-exec.test.ts` | 7 pass |
| `vitest run test/component/native-agent.test.tsx` | 34 pass |
| `agent-dev ... --resource heavy` `test:browser`: `native-agent`, `native-session-timeline`, `side-chat`, `phone-shell` specs | 20 passed, receipt `check-10c53y89` |
| `npx tsc --noEmit -p` contract, server, cli, web | exit 0 each |
| `npx eslint` over all changed TS/TSX, `npx stylelint` on the CSS | no output |
| `npm run ui:check` | no failing gate |

Not run: full `npm test`, the full browser gate, build, `lint:md`/link checks for the whole
tree, Storybook, the session-log files that Q0 owns (nothing in that code changed), and any
hosted CI. The external `guanxi-ui` symlink makes agent-dev receipts non-reusable.

## Counts

- **New:** server 20 (7 of them the Q07 variants), CLI 3, web component 5 cases (3 tests).
- **Changed expectation:** `agent.test.ts` "legacy progress ..." now asserts the newest snapshot
  defines the queue (Q0 had refused any v3 snapshot as an interim guard; the "never resurrect
  the older v1 queue" property is kept). CLI, component and browser fixtures were moved to the
  progress2 body; no assertion was weakened.
- **Regression envelope:** the other 92 native-agent cases above, 4 CLI, 29 web component and the
  20 browser cases (counted once each).

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
- Web: the Remove button stays clickable on a restricted queue and answers with the explanation
  after the 409 rather than being disabled up front.
- No independent review, no hosted CI, no full local suites yet.

## What Q2 needs

- Replace `v1Items` / `blocksV1Producer` with v3-producing add/remove: normalize retained
  oversized legacy entries to artifact descriptors, write blobs outside SQLite with abort, home
  and attempt checks around each await, then one atomic `appendNow({eventVersion: 3})`.
  Delete the Q1 restriction and its 409 route mapping/tests (Q21) in the same round.
- Add the Q22 pairing test (old POST 202, progress1 406, progress2 valid, result and stop usable).
- The `queuedTurn()` verification and the preparation FIFO need no change; the consumer already
  reads `ExecutableQueueItem`s.
- Side-chat Send onto a v3 queue should then be accepted again.
