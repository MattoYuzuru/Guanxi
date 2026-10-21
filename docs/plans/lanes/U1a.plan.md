# U1-a implementation plan

**Status:** locally validated · **Date:** 2026-10-21

Implement ADR-0036's workspace adapter, keyed block contributions, node-owned layout
documents, mode defaults, accessible moves and phone projection. U1-b shell/navigation,
U1-c legacy migration and U2 Electron integration remain outside this slice.

- Contract: strict `guanxi.layout/1`, portable split tree and block map, separate device
  geometry, resolution and deterministic whole-document conflict handling.
- Persistence: additive SQLite migration, atomic document/recovery/active-layout writes,
  REST request and response validation, typed web client. Rollback leaves additive tables
  intact; existing sessions are unaffected.
- UI: Dockview 8.6.1 (MIT), exactly pinned, imported only by `WorkspaceLayout`; locked zone
  groups through free APIs, same-origin popout page, retained pane instances, menu/command/
  keyboard movement, live announcements, F6, phone tabs and density tokens.
- Catalog: compose existing primitives in new workspace patterns at `review`; do not edit
  existing component implementations or approval records. Locale keys for all copy.
- Risks: malicious layout JSON, secrets in params, cross-device window coordinates, replayed
  conflicts, popup blocking, focus across windows, engine-version drift and plugin unload.
- Assertions: contract rejection, resolution golden fixtures, mode retention, recovery count
  and replay, restart persistence, local-only geometry, adapter/licence boundaries; Chromium
  keyboard/live text/F6/reduced motion/390 px/themes/densities/retained pane state and 30-pane
  restoration under 2000 ms. Tests mock APIs and perform no model or external network work.
- Checks: typecheck, lint:md, check:licenses, ui:check directly; npm test, browser, UI browser
  and build sequentially under `agent-dev`'s heavy lock with lane ports 5199/4399 and local
  `.lane-data`. Record receipt limitations from the pre-existing external skill symlink.
- Review: commit implementation, then fresh-context whole-diff review of accessibility,
  validation, replication, licensing and adapter isolation, with fixes in separate commits.
  Merge main when DS1-c is there, rerun gates, leave U1a.handoff.md; never push.

## Integration correction: component-owned storage

Main's [F1 evidence](../evidence/F1.md) reserves global migrations 32–33 for K4; the
completed K4 follow-up branch uses 32. The unreleased U1-a draft must not occupy that slot.
Move its unchanged four-table layout schema to a component-owned `layout_migrations` ledger,
version 1, following the independently tracked federation/relay pattern. No live node/data
migration has been run in this lane; tests use temporary or in-memory databases. There is no
production cutover, dual write or backfill. Keep REST and document shapes unchanged.

Initialize lazily on the first valid layout request, under `BEGIN IMMEDIATE`, checking the
ledger again inside the transaction. Retry must be idempotent; collision must roll back both
DDL and ledger; unknown/future versions must fail closed without changing rows. Assert that
main migrations and `user_version` remain unchanged. Restore unrelated legacy migration tests
to main. Re-run storage/regression gates and request an independent review of this correction.
Rollback retains additive tables while the route is disabled; repair uses a forward fix.

## Completion

Implementation, independent review fixes, main integration and required gates are complete.
See [U1a.handoff](U1a.handoff.md) for new/regression evidence, receipts, catalog review and
residuals. The integrator owns the pending Claude cross-family review and merge.
