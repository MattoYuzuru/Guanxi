# U1-a implementation plan

**Status:** in progress · **Date:** 2026-10-21

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
