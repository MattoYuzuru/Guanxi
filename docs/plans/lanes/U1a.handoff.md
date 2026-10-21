# U1-a workspace layout engine and modes

**Status:** locally validated; integrator review pending · **Date:** 2026-10-21

Branch `lane/u1a-workspace`. Initial base `494c8b0`; merged main at `80f7245` in
`c701111`, including DS1-c (`a07d3d7`), F1, R2 and K5. No push.

## Delivered

`/workspace/:threadId?` hosts the existing chat, dock lanes and composer. The optional
`project` query scopes layouts; `safe=1` suppresses plugin renderers. Existing routes remain
for U1-c. U1-b owns navigation, status strip, command palette, new session, side chats and glossary.

- Dockview core/react exactly `8.6.1`, MIT, imported only within `WorkspaceLayout/`.
  Enterprise is explicitly denied even if installed metadata falsely claims MIT.
- Keyed `workspace.block` contributions, `BlockContribution`, eleven built-in panes including
  Chat, truthful unavailable states and renderer teardown on plugin unload. T0/T1 renderer refs
  register through `registerBlockPane`; T2 MCP App hosting awaits P1.
- Locked dock zones, center split grid, single-group floating/popout windows and the same-origin
  `/workspace-popout.html` build entry. Unsupported detached edge splits are rejected; center tab
  merges are supported. React-owned pane hosts retain drafts and DOM identity across movement.
- Move menu, `requestBlockMove(instanceId?)` command entry and Alt+Shift+M; F6/Shift+F6 zone
  cycling; localized live announcements, focus restoration, reduced-motion previews and phone tabs.
- Strict Zod `guanxi.layout/1`, node REST/client, component-owned `layout_migrations` ledger v1,
  named layouts and active layouts per scope/mode, resolution, deterministic LWW and deduplicated
  Recovered layout copies.
  Normal saves supply the base clock; divergent equal clocks return 409 atomically.
- Float/popout geometry is keyed by full scope, layout and actual device, outside replicated
  documents. Right/bottom anchors normalize to left/top. Saved popouts restore docked until
  explicitly reopened through a user gesture; saved bounds are then consumed.
- Developer/Visual presets retain separate layouts. Density changes tokens and leaves block
  membership, order and split structure intact. Phone projection uses priority-ordered tabs.

Additional shells whose default zone was unspecified use Left in Developer and Left/Bottom in
Visual; the prescribed Chat/Changes/Context/Plan/Processes/Environment/Files/Terminal and Visual
artifact/browser defaults remain in the golden. No open product decision was closed.

## Exit-gate evidence

**New:** 15 Node cases (12 layout cases, 2 boundary/license cases, 1 keyed-slot case) and
18 Chromium cases. Eight new catalog states have sixteen light/dark baseline images.

**Regression envelope:** full `npm test`, `test:web:browser`, `ui:check:browser`, build and
all four required direct gates; executed results follow below. Browser evidence is mocked local
Chromium, not live runtime or production validation.

| Property | Assertion |
| --- | --- |
| Free engine and adapter isolation | Boundary test scans all production source imports, checks exact MIT pins, absence of enterprise in lockfile and actual license-gate rejection of a synthetic enterprise package. |
| Locked zones and keyboard movement | Home/ArrowDown/Enter choose Block/Destination; Tab/Enter confirms. Exact live-region text, destination membership, locked-group counts and F6 focus assertions fail on violations. |
| Retained Terminal/Browser | Draft value and original DOM expando survive dock move, float, same-origin popout and return; closed backdrop count is zero. |
| 30-block restore | Explicit 30-pane count and positive engine-ready-through-two-frames time below 2000 ms. Measured 38.6 ms in the full browser run. |
| Layout precedence and modes | Golden device/project/account/built-in resolution; committed Developer/Visual placement golden; actual browser mode return, node restart and named-copy retention. |
| LWW recovery | Both delivery orders and repeated replay retain exactly one recovered copy containing distinct losing content; second browser save operates on a different-block server winner. |
| Component migration | Failed DDL rolls back ledger/tables; a deterministic competing-initializer interleaving succeeds once; future version rejects without writes. A nonempty synthetic setting and global migration/version state survive. |
| Geometry and compatibility | Full-scope/device isolation, actual floating widths/active tab after mode return, right/bottom drag bounds, saved popout reopen bounds and future-major named fallback. |
| Phone, themes, densities, motion | 390 px: exact priority order, roving keys, disabled Move, no engine/overflow. Both rendered theme colors and density token values; unchanged placement/tree. Actual drag preview has no transition or active animation. |
| Lifecycle and failure | Retry on node failure; plugin renderer unload and safe-mode placeholder counts; move/cancel/hide focus; in-place Russian tab titles; Reset → Save revision → reload; native popup shortcuts after a tab merge/original-pane return. |
| Session bridge | Existing chat center and exactly one dock lane immediately before its composer. |

## Executed checks

Commands use `GUANXI_WEB_PORT=5199`, `GUANXI_API_PORT=4399`,
`GUANXI_DATA_DIR="$PWD/.lane-data"`, Node 26 and sequential `agent-dev` heavy locking.
`npm ci` ran first and again after the main merge.

| Command | Result and evidence |
| --- | --- |
| `npm run typecheck` | PASS; `/tmp/u1a-final-types-4.log`, at `7dc0496`. |
| `npm run lint:md` | PASS; `/tmp/u1a-final-markdown-5.log`, including this handoff and review record. |
| `npm run check:licenses` | PASS, 661 packages and zero disallowed; `/tmp/u1a-final-licenses-4.log`. |
| `npm run ui:check` | PASS, including G8/G9 and suppression seeds; `/tmp/u1a-final-ui-4.log`. Expected G11 warning for use of the new review-state pattern. |
| `npm test` | PASS at `7dc0496`; receipt `/Users/yuzuru/.local/state/agent-dev/check-4qfrur1a/result.json`. Full fast-gate/codemod/server/CLI/kernel/web-component/UI envelope; the existing opt-in macOS keychain round-trip is the sole skip. All 15 new Node cases executed. |
| `npm run test:web:browser` | PASS, 83 cases at `3b53422`; receipt `/Users/yuzuru/.local/state/agent-dev/check-jyd1_7ua/result.json`. All 18 new workspace cases executed. Subsequent runtime changes only isolate the node schema; browser source is unchanged. |
| `npm run ui:check:browser` | PASS at `4001a86`; receipt `/Users/yuzuru/.local/state/agent-dev/check-2z6v1sah/result.json`. G13/G14/G15-clipping/G16 and G17 seeds all pass, zero skips or warnings. |
| `npm run build` | PASS at `4001a86`; receipt `/Users/yuzuru/.local/state/agent-dev/check-ec7qjivf/result.json`. Web, server and CLI; emitted `packages/web/dist/workspace-popout.html`. |

Baseline creation was restricted to the eight `workspace-chrome--*` story IDs below and used
`npm run ui:snapshots -- --stories <comma-separated IDs>` under the heavy lock. G13 passed in
`mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e`.
Receipt `/Users/yuzuru/.local/state/agent-dev/check-9o3okbyh/result.json` has child exit 0 and
runner exit 3 / `source_changed: true` because it intentionally created sixteen files; it is
not a verification pass. They were committed in `4001a86` and verified by the clean G13 run.
Visual inspection covered representative light/dark pane, draft, placeholder, error, phone,
toolbar and mover captures; no overlap or clipped controls was observed. No existing baseline changed.

All four heavy verification receipts have child exit 0 and `source_changed: false` (intentional
baseline creation is recorded separately). The existing `.claude/skills/guanxi-ui` external
symlink makes the runner report `source_verifiable: false` and `reusable: false`; these are
local execution records, not reusable attestations. The symlink was not changed.

## Independent verification and fixes

A separate fresh-context, same-family read-only reviewer inspected the complete implementation
and the integrated diff, covering accessibility, validation, replication, licensing and adapter
isolation. It ran no checks and changed no source. Findings and fix mapping are in
[U1a.review](U1a.review.md). The integrator arranges the Claude cross-family review.

## Catalog handoff

New `workspace-chrome` is `review`; no existing reviewed component implementation or review
record changed. Owner review is pending, and G11's review-use warning is intentional.

Catalog route: `/settings/developer/components?component=workspace-chrome`. Story IDs:
`workspace-chrome--default`, `workspace-chrome--empty`, `workspace-chrome--placeholder`,
`workspace-chrome--error`, `workspace-chrome--phone`, `workspace-chrome--draft`,
`workspace-chrome--toolbar`, `workspace-chrome--mover`.

## Residuals and shared edits

- Sandboxed Electron popout criterion 3 remains U2 work. Chromium same-origin behavior is tested.
- Terminal and Browser are labeled non-executing drafts/empty shells. State evidence does not
  claim live PTY or embedded-browser service behavior. Live-region DOM assertions do not prove
  screen-reader speech. No live models or external pages are used by the new tests.
- Browser popout reopen requires a gesture. Detached windows support tabs; their own split grids
  are deliberately rejected because the portable document currently represents a center grid.
- Storage is additive and lazy; no non-fixture database was migrated. No production cutover,
  dual write or backfill is needed. Rollback may disable the route and leave tables intact;
  repair uses a forward fix.
- The build emits Vite’s warning about chunks above 500 kB; build success does not establish
  a bundle-size or end-to-end performance budget.
- Persistence is explicit Save; mode switches retain unsaved layouts in memory. Window geometry
  remains local to the node/device identity, not part of a replicated document.
- Shared edits: contract routes/errors/exports; server mount and component schema; kernel keyed
  slots/exports/README; browser kernel registration and global slot-count assertions; router/App
  and minimal ChatPage bridge; Vite popout input;
  package pins/lock and license gate/notices. Main's DS1-c colors and exact UI aliases were kept
  while resolving merge conflicts. Global migrations and unrelated server tests match
  main; K4 retains reserved slots 32–33.
  No shared planning status files changed.

Next: integrator's Claude review, then U1-b shell using `requestBlockMove` and the adapter's
Guanxi-only handle. U1-c migrates legacy pages independently.
