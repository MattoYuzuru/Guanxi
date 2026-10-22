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

- `nice -n 10 node --test packages/server/test/work/*.test.ts` → **31 tests, 31 pass,
  0 fail**, exit 0.
- `nice -n 10 npx tsc --noEmit -p packages/server` → exit 0, no diagnostics.
- `npx markdownlint-cli2 packages/server/src/work/README.md docs/plans/lanes/WG1-a.handoff.md`
  → **0 errors** (2 files).
- `git diff --check` → clean. No dependency or third-party source added.

## New / regression envelope

**New:** 31 tests in three files. Status tests cover planted false done (verification only,
failing acceptance, dirty pass, missing commit acceptance, later failure, reopen, null
acceptance, judge failure), dependency gating, claim/release, cancel, proposals, warnings and
`nextReady`. Store tests cover WAL/FK/migration reopen, sequential immutable revisions, cycle
and missing-dependency rejection, append-only events and paging, cancel/reopen enforcement,
default-off activation and activation rules. Strip/query/export tests include a 500-case
seeded plan/view property with long Unicode fields and both counters, exact paging across new
events, proposal graph visibility, and Markdown content.

**Regression:** no existing source or test file was modified, so the existing suites were not
rerun; the full server `tsc` project includes every package source and test and passed. No
`npm test`, browser, live server, model, network or owner data was used. Existing relay,
connections and federation behavior is untouched. This is targeted unit evidence, not a
product integration gate.

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
