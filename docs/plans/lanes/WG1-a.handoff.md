# WG1-a work ledger core — hand-off

**Status:** implemented library core; WG1 remains in progress. **Date:** 2026-10-22.
**Branch:** `codex/wg1a-work-ledger-core` (standalone clone, no push). No relay, plugin,
route, contract, web or status-file changes. `project` mode is not a default.

## Delivered boundary

- `types.ts`: immutable `PlanRevision`, `ItemSpec`, ten-member `EvidenceEvent` union,
  `DerivedStatus`, capacity/strip/query types, shape guards and a typed `WorkError`.
- `status.ts`: pure `deriveStatuses`, `nextReady` and `workView`. Evidence is consumed in
  append order; `reopen` is a barrier; unknown ids become `warnings`. Done requires a clean
  passing acceptance plus an accepted commit, or a human `done`; a bare
  `verification_requested` never closes an item.
- `store.ts`: separate `work.sqlite`, WAL/FKs, independent `wg1_migrations` v1, immutable
  JSON plan revisions with `(project_id, revision)` PK, append-only events with autoincrement
  `seq`, activation with default `off`, and `shouldActivateProject` (two executors, linked
  tracker or opened backlog). `addRevision` rejects duplicates, missing dependencies and
  cycles with the path; `appendEvent` rejects events after `canceled` except `reopen`.
- `strip.ts`: bounded context strip with injected counter and conservative
  `utf8ByteCounter`; fixed truncation order (blocking, next title/line, current title,
  acceptance, header) and ellipsis per truncated field. Header is raw-cut only when even an
  ellipsis cannot fit.
- `query.ts`: stable full-graph paging with an id + stable creation-order cursor (positional
  fallback); rejected proposals leave gaps instead of shifting pages; status filter mismatch
  is rejected; no hidden limit when `limit` is omitted.
- `export.ts`: pure Markdown projection for `.guanxi/work/*.md`, including summary, items,
  acceptance, dependencies, evidence and warnings. It never writes files.
- `README.md`: model, derivation precedence, store, activation, WIP, strip priorities,
  counter conservatism, query cursor and export semantics.

## Commands and results

- `nice -n 10 node --test packages/server/test/work/*.test.ts` → **39 tests, 39 pass,
  0 fail**, exit 0.
- `nice -n 10 npx tsc --noEmit -p packages/server` → exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/work/README.md docs/plans/lanes/WG1-a.handoff.md`
  → **0 errors** (2 files).
- `git diff --check` → clean. No dependency or third-party source added.

## New / regression envelope

**New:** 39 tests in three files (31 at the first hand-off; 8 added by the independent review
fixes below). Status tests cover planted false done (verification only, failing acceptance,
dirty pass, missing commit acceptance, later failure, reopen, null acceptance, judge failure),
dependency gating, claim/release, cancel, proposals, warnings and `nextReady`. Store tests
cover WAL/FK/migration reopen, sequential immutable revisions, cycle and missing-dependency
rejection, append-only events and paging, cancel/reopen enforcement, default-off activation and
activation rules. Strip/query/export tests include a 500-case seeded plan/view property with
long Unicode fields and both counters, exact paging across new events, proposal graph
visibility, and Markdown content.

**Regression:** at the first hand-off no existing source or test file was modified, so the
existing suites were not rerun; the full server `tsc` project includes every package source and
test and passed. The independent review fixes were limited to the work core and its tests; the
regression envelope is recorded in that section below. No `npm test`, browser, live server,
model, network or owner data was used. Existing relay, connections and federation behavior is
untouched. This is targeted unit evidence, not a product integration gate.

## Verification and residuals

- A separate read-only in-lane review was run against the contract. It found three issues,
  all fixed with regression tests before hand-off: `buildStrip` lacked its default counter,
  the query cursor skipped items when rejected proposals preceded it, and
  `INSERT OR REPLACE` could bypass SQLite immutability triggers. No cross-family review is
  claimed; the integrator still owes the independent GPT 6.1 Sol/high review required by the
  lane rules.
- Extraction to `packages/work` and sharing the vocabulary/code with the relay run-mode ledger
  remain. The relay was deliberately not modified.
- Plugin wiring, `work.query` agent-tool registration, routes/contract, board UI and the
  Markdown file-writing caller remain.
- The WL-series A/B must show a gain before `project` becomes a default. WG1 stays in progress.
- WG2 tracker sync (GitHub Issues/Jira, polling, rate limits) remains out of scope.
- Reviewer WIP ambiguity: `ItemSpec` has no assignee, so reviewer items consume the aggregate
  remaining per-person capacity `sum(max(0, 3 - reviewQueueByPerson[person]))`. This is the
  only non-arbitrary reading without inventing assignment; it needs design confirmation when
  an assignee field or reviewer identity exists.
- Events are project-wide by item id rather than revision-scoped. If a later revision reuses
  an id with different meaning, old evidence applies; a revision-scoped event policy needs a
  decision before multi-revision production use.
- The cursor survives appended evidence. A rejected proposal that was the last cursor item
  falls back to its stored graph position, documented in `query.ts`.

## Next slice

Wire the core into the kernel/plugin boundary without changing its evidence semantics: create
the `packages/work` extraction seam, register `work.query`, expose plan/event/status routes and
contract, then build the board projection. WG1 remains in progress.

## Independent review fixes

Second review round, 2026-10-22. Each finding has its own commit and a regression test. Every
behavioral fix's new test was run against the reverted source and went red before the fix; the
null-acceptance test documents the already-correct rule that a removed command cannot auto-close
an item.

| Finding | Commit | Fix and evidence |
| --- | --- | --- |
| P2-1 acceptance from the wrong command | `dbfce566` | `apply` ignores an `acceptance_result` whose `command` is not the item's current `acceptance`; `baseStatus` also checks it for `done`. Tests cover a wrong passing command, a wrong failing command, and a later revision changing or removing the command. README rule 1 says a revision reopens automatic proof and a null command is human-only. |
| P2-1 source allowlist | `84ffd648` | `parseEvidenceEvent` rejects sources outside `harness:` (acceptance, commit, judge), `user:`/`lead:` (human, accepted, rejected) and `agent:` (proposal, claim, release, verification) with `WorkError` code `invalid_source`. README documents the convention. |
| P2-2 proposal DAG bypass | `9aa41485` | `appendEvent` validates an accepted proposal against plan items plus previously accepted proposals, using the `addRevision` missing-dependency and cycle rules; it rejects with `WorkError` code `invalid_proposal`. Tests cover `x -> y`, `y -> x`, `z -> [z, ghost]`, a self-cycle and valid dependencies. |
| P3-1 fractional capacity | `c29c0ebd` | Executor capacity fields must be non-negative integers; fractional or negative input throws `TypeError` with code `invalid_capacity`. Test uses `1.5`. |
| P3-2 dirty pass clears failure | `8c6ca3ee` | Only a clean passing acceptance sets the pass index; failed then dirty pass stays `failed`. |
| P3-3 surviving mutation | `08757b43` | The dirty-pass fixture now includes `commit_accepted` and asserts not `done`. Removing the `cleanCheckout` check made it fail with `done` instead of `verification_requested`; the check was restored. |
| P3-4 review queue and overrides | `fa94c4ee` | `reviewQueueByPerson` must be a plain object of non-negative integers. README documents the aggregate interpretation (empty map means no reviewer slots) and that a human `done` overrides later failing acceptance until `reopen` or `cancel`. |
| P3-5 strip next id | `2a02fbf2` | When the next title cannot fit and the current title is truncated, the fitter reserves room for `next: <id>`; the line is dropped only if it cannot fit even then. Test uses a 400-character current title. |

**Counts:** 39 tests in three files, 39 pass, 0 fail, exit 0. Eight tests are new (31 → 39);
one existing fixture was strengthened with an accepted commit and no assertion was weakened.
`nice -n 10 npx tsc --noEmit -p packages/server` exits 0 with no diagnostics.
`npx markdownlint-cli2 packages/server/src/work/README.md docs/plans/lanes/WG1-a.handoff.md`
reports 0 errors (2 files). `git diff --check` is clean.

**Regression envelope:** only `packages/server/src/work/{types,status,store,strip}.ts`, the
work `README.md` and `packages/server/test/work/*.test.ts` changed. No relay, plugin, route,
contract, web, schema/migration, dependency or third-party change. No `npm test`, browser, live
server, model, network or owner data was used. This is targeted unit evidence, not a product
integration gate.

**Residuals (no code in this round):**

- `appendEvent` reloads every event and re-derives all statuses on each append, so a long
  ledger pays O(n²) work. Acceptable for the unwired core; replace it with an incremental
  projection before live use.
- Proposal graph order follows the first `proposed` event for an id. If a later revision
  reuses a proposal id, the new spec keeps the old order and old evidence applies; a
  revision-scoped proposal policy is still needed before multi-revision production use.
- The source allowlist intentionally rejects legacy unprefixed labels (`harness`, `lead`,
  `agent`, `executor`). The core is not wired into plugins or routes, so no stored-data
  migration was required in this slice.
