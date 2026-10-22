# Project work ledger (WG1-a)

**Status:** implemented internal library core, not wired into plugins, routes, contract or web.
Project mode is **not** a default (D-173). This package is the project-mode core next to the
relay run-mode ledger; the relay is unchanged.

Sources: [ADR-0032](../../../../docs/decisions/0032-work-ledger-board-and-tracker-sync.md),
ROADMAP `WG1`, owner decisions D-171–D-176. The intended eventual home is `packages/work`;
WG1-a keeps the files under `packages/server/src/work` to avoid a package extraction in this
slice.

## Model

`types.ts` defines immutable plan revisions and append-only evidence:

```ts
PlanRevision { projectId, revision, createdAt, author, items }
ItemSpec { id, title, acceptance, dependsOn, estimateMinutes, ownerRole, protectedPaths }
```

`acceptance` is the executable definition of done. `null` means no command can close the item;
only a human decision can. `ownerRole` is `lead`, `executor`, `reviewer` or `null`.

`EvidenceEvent` is a discriminated union. Every event has `itemId`, `at` (ISO-8601 or epoch
milliseconds) and `source` (`agent`, `executor`, `lead`, `user`, `judge`, `harness`, or another
non-empty producer label). Event types:

| Event | Meaning |
| --- | --- |
| `proposed` | an agent proposes a new item (D-172); it carries its `ItemSpec` |
| `accepted` / `rejected` | lead or user decision on a proposal |
| `claimed` / `released` | executor pulls or releases an item |
| `verification_requested` | an agent says done; never completes the item |
| `acceptance_result` | command result: `passed`, `commit`, `cleanCheckout`, `command` |
| `commit_accepted` | a commit is accepted as evidence |
| `judge_verdict` | `pass`, `fail` or `escalate` |
| `human_decision` | `done`, `reopen` or `cancel` |

Events are consumed in append order. Timestamps describe provenance; they do not reorder
evidence.

## Derived status

`deriveStatuses(plan, events)` is pure. It returns a `Map<itemId, { status, reason, evidence }>`
with additive `warnings`, `items` and `orders` properties; map values keep exactly the three
documented fields. `items` is the graph order: plan items first, then proposals in proposal
order. `orders` is the stable creation order parallel to `items`; rejected proposals leave gaps.

Rules, in precedence order:

1. `done` only when (a) the latest `acceptance_result` passed in a clean checkout, its commit
   also has a `commit_accepted` event (either order), and no later failing acceptance or
   `reopen` exists; or (b) the latest human decision is `done`. An item with
   `acceptance === null` can only be completed by (b). A bare `verification_requested` stays
   `verification_requested`.
2. `failed` when the latest acceptance failed after a claim, or the judge reported `fail`, and
   no later passing evidence exists. A later passing acceptance or a judge `pass` clears the
   failure; another claim does not.
3. `canceled` when the latest human decision is `cancel`. `reopen` is a barrier: it clears
   terminal status, the claim and prior acceptance, commit-acceptance and judge evidence,
   returning the item to the dependency-based state. After `cancel`, only `reopen` is accepted
   by the store.
4. Otherwise `blocked` when any dependency is not `done`, then
   `verification_requested`, `in_progress` when claimed and not released, else `ready`.
5. A proposed item that is not in the plan is `proposed` until `accepted`; `rejected` removes
   it from the graph. Accepted proposals behave like plan items, including dependency gating.

Events for ids that were never planned or proposed are ignored and listed in
`warnings`; derivation never throws for them. A duplicate proposal for an existing or already
proposed id is also reported as a warning and ignored.

## Store

`WorkStore(path, clock)` opens a **separate** SQLite file, by convention
`<dataDir>/work.sqlite`. It sets WAL, foreign keys and a busy timeout, and owns the independent
`wg1_migrations` table (version 1). It never touches R1/K2/R2 tables.

- `addRevision({ projectId, author, items })` validates unique item ids, dependencies that
  exist in the same revision, and acyclic dependencies. A cycle is rejected with its path, for
  example `dependency_cycle: dependency cycle: a -> b -> a`. Revision numbers are previous + 1
  and are assigned by the store.
- Plan revisions are stored as JSON with `(project_id, revision)` as primary key. Database
  triggers reject UPDATE, DELETE and a conflicting INSERT OR REPLACE; there is no update
  method, so a revision is immutable.
- Events are JSON payloads with an autoincrement `seq`, append-only through UPDATE, DELETE
  and INSERT OR REPLACE guards.
  `appendEvent(projectId, event)` validates shape, requires a revision, and rejects every event
  after `canceled` except `human_decision: reopen`. An event for an unknown item id is allowed
  so derivation can report a warning.
- `events(projectId, { afterSeq?, limit? })` returns sequence order. No limit means all events;
  there is no hidden cap. `latestRevision(projectId)` returns `null` before the first revision.
- `setMode(projectId, mode, reason)` records activation; `mode(projectId)` returns `off` by
  default and `activation(projectId)` includes the reason.

`shouldActivateProject({ executors, linkedTracker, backlogOpened })` returns `project` for two
or more executors, a linked tracker, or an opened backlog; otherwise `off`. It never returns
`run`. The default remains `off` until the WL-series A/B shows a gain (D-173).

## Pull and WIP

`nextReady(statuses, plan, capacity)` returns ready graph items in plan order, then accepted
proposals. The executor limit is `max(0, min(freeWorktreeLeases, governorPermits) - inProgress)`; no other numeric caps
are applied. Reviewer-owned items additionally consume review capacity.

The item model has no assignee, so reviewer capacity is the aggregate remaining capacity of the
named queues: `sum(max(0, 3 - reviewQueueByPerson[person]))` (D-176). Each reviewer item
consumes one slot. This is the only non-arbitrary per-person interpretation available without
inventing an assignment; an empty queue map therefore exposes no reviewer slots.

## Strip

`buildStrip(view, count = utf8ByteCounter, budget = 300)` produces:

```text
work: <current id> <status>
current: <title>
acceptance: <command>
next: <next id> <title>
blocked: <id> (<title>) <- <dependency ids>
```

`workView(plan, statuses)` selects the first active item, else the first blocked item, else the
first ready item; `next` is the next ready item and `blocking` lists every blocked item with its
unmet dependencies.

Truncation priority, least important first:

1. blocking entries, dropped from the end;
2. next-ready title, then the next line;
3. current title (the id/status header stays);
4. acceptance command (the definition of done outranks a display title);
5. the `work:` header itself, which is truncated to fit.

A truncated field ends with `…`. The postcondition is `count(result) <= budget` for the injected
counter; budget zero returns `''`. When even an ellipsis cannot fit in the minimal header, the
header is cut raw to fit. `count` is injected so a real tokenizer can replace the default later.

`utf8ByteCounter` is a conservative fallback: UTF-8 bytes bound byte-level/BPE tokens for common
tokenizers. It is not an exact token count and is not claimed as one.

## Query and export

`query(statuses, plan, { status?, cursor?, limit? })` is the backend for `work.query`. It pages
the full graph in stable order, including pending and accepted proposals and excluding rejected
ones. The cursor stores the last item id plus its stable graph creation order (with a positional
fallback for plain maps), not an event sequence or a status offset. Appending claims, acceptance
results or judge verdicts does not shift a later page, and rejecting an earlier proposal or the
cursor item leaves an order gap instead of skipping the next item. Changing the status filter
with an existing cursor is rejected. Without `limit` the whole matching graph is returned; there
is no hidden cap.

`exportMarkdown(plan, statuses)` returns the Markdown projection intended for
`.guanxi/work/*.md` (D-174). It contains a status summary, every graph item, acceptance,
dependencies, estimate, owner role, protected paths, reason and evidence, plus warnings. It is a
pure function: it never writes a file or commits anything; the caller decides where the
on-demand projection goes.

## Tests and limits

`packages/server/test/work/` covers planted false-done claims, dependency gating, claims,
cancellation and reopen, proposals, warnings, store validation and migrations, default
activation, WIP derivation, a 500-case seeded strip property with Unicode and both counters,
query paging stability and export content.

Residual work is WG1, not this slice: extract to `packages/work`, share the run-mode relay
ledger, wire the plugin and `work.query` tool, add routes/contract/board UI, run the WL-series
A/B, and build WG2 tracker sync. `project` mode stays off until that evidence exists.
