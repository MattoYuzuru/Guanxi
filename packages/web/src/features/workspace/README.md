# Workspace layout (U1-a)

**Status:** implemented; local verification pending · **Updated:** 2026-10-21

`/workspace/:threadId?` hosts the existing chat and composer as the centre block. An optional
`project` query scopes its layouts. Legacy routes remain available for U1-c. `safe=1` suppresses
plugin pane renderers. Terminal and Browser are explicitly labelled, non-executing drafts;
process attribution, filesystem and telemetry shells explain what is unavailable.

## Boundaries

- Only `WorkspaceLayout/` imports Dockview. It translates a strict Guanxi split tree and block
  groups to the free MIT engine, locks dock-zone groups, reparents existing pane hosts and
  captures window geometry separately. No enterprise APIs or dependency are used.
- The browser kernel owns the keyed `workspace.block` slot. `BlockContribution` lives in the
  kernel package. Built-in contributions use `guanxi.core/<block>` identities. T0/T1 plugins
  register opaque renderer refs through `registerBlockPane(ctx, ref, component)`; registration
  is reverted on unload. Missing contributions/renderers become placeholders without deleting
  the saved block map. T2 MCP App hosting belongs to P1; its panes remain unavailable here.
- `guanxi.layout/1`, REST paths and both response shapes are exported by `@guanxi/contract`.
  The node lazily initializes the component's additive SQLite schema through
  `layout_migrations` version 1. Global migrations and K4's reserved slots remain untouched.
  Older code can leave these tables intact; no down migration is required.

## Documents and interaction

Resolution is exact for mode/device class: device override (project-specific, then account
wide), project, account, built-in. Named inactive copies never win resolution. Developer and
Visual keep separate documents in memory; Save persists to the node. Density changes tokens
without changing the engine state. On phones (under the small breakpoint), there is no engine:
priority-ordered vertical tabs project the same blocks.

The block menu and workspace command entry open the same move dialog; Alt+Shift+M opens it for
the active block. F6/Shift+F6 cycle nonempty zones. Successful moves update a polite live region.
Popup blocking leaves the pane docked and announces a recovery action. Saved popouts initially
restore docked because opening windows requires a user gesture. Use Move → Popout to reopen.
The popout page is a blank same-origin Vite/build entry; Electron sandbox integration awaits U2.

Conflicts compare `(rev, updatedAt, updatedBy.device)` in that order. A successful sequential
save supplies its base clock and creates no recovery. Concurrent or replicated conflicts retain
exactly one copy per losing content digest named `Recovered layout`; replay does not duplicate
it. Different content with exactly equal clocks is rejected with HTTP 409. Params accept
boolean/finite numeric configuration and opaque resource/secret references, never free text or
executable objects. Geometry is absent from replicated documents.

## Verification scope

The 30-block engine restore budget is 2000 ms in deterministic local Chromium. Browser tests
mock node/model APIs and never run models, shell commands or external pages. Node tests cover
validation, resolution, replication, restart and the import/licence boundary. These do not
prove live terminal processes, real embedded browser sessions, screen-reader output or Electron
renderer behavior. See the lane handoff for executed results and remaining checks.
