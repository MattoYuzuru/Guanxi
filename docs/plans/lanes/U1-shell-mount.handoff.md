# U1 mounted product shell — handoff

**Status:** bounded host composition implemented; focused sandbox checks passed; actual browser,
axe, responsive and full gates remain root/reviewer-owned. This is not a full U1, MS1 or production
claim.
**Date:** 2026-10-22 · **Branch:** `codex/u1-shell-mount` · **Base:** `b1046a30` · **Commits:**
`9a1aaa26` implementation, `761f01e3` tests, this handoff commit. No push, merge, rebase,
`PHASE_STATUS` or `NEXT_AGENT_PROMPT` edit.

## Delivered behavior

- `App.tsx` now gates on health as before, then mounts one `RuntimeProvider` and one
  `MountedShell` around the existing route switch. The legacy duplicate `TopBar` is removed; the
  product shell is the only top-level chrome.
- `MountedShell` composes the existing public `AppShellChrome`, `ShellSidebar`, `ShellStatus`,
  `ShellPalette` and `useShellController`. It supplies the four fixed links (New, Projects,
  Models, Settings), the session/plugin sidebar, the status facts, the palette and the sidebar
  geometry callbacks.
- Secondary routes remain reachable through the existing palette: workspace, chat, quick runs,
  recipes, attachments, inspector, developer components, sessions and models. The four core links
  are the only fixed navigation links.
- The quick theme control moved into the persistent status strip with the existing localized
  theme labels and accessible name. Settings and language remain reachable through the fixed
  Settings link and the palette theme commands.
- `ShellStatus` reads the one sampled `useRuntimeProjection()` and keeps machine source/time,
  stale state and explicit unknown quota/keep-awake/power/inbox values. `RuntimeStatus` and
  `OllamaHealthNotice` remain mounted outside route content, so their state and Retry paths
  survive navigation.
- The workspace lazy import is unchanged. `MountedShell` imports no workspace/layout engine or
  catalog module. The developer catalog remains code-split inside its existing route.
- `ShellSidebar` is the only host owner of `SidebarSlot`. The slot wrapper is marked
  `data-slot="sidebar-slot"`. `ChatPage` keeps its independent conversation list but no longer
  renders a second `SidebarSlot`.
- `AppShellChrome` keeps the sidebar and main mounted through move/rail/hide/show. Route content
  stays mounted; hiding returns focus to Show and showing returns focus into the sidebar.
- Shell preferences keep the existing key and meaning (`side`, `visibility`, `pinned`). Corrupt or
  denied storage falls back to defaults; failed writes are ignored. Preference writes do not
  navigate.
- `Ctrl/Meta+K` remains one controller listener, one palette toggle and one executed command. The
  palette remains the accessible path to hidden/secondary navigation.
- `ShellSidebar` now marks the owning core destination as `aria-current` on nested legacy routes
  (`/models/:name`, `/settings/developer/components`, `/projects/*`, `/agent/*`).
- New locale keys are English source plus curated Russian: `shell.sidebar.show` and
  `shell.sidebar.label`. No other user-facing literal was added.

## New / inherited tests

**New: 17 cases.**

- `packages/web/test/component/mounted-shell.test.tsx`: 7 cases — one shell/slot count, plugin entry
  count, one runtime region, route content identity through move/rail/hide/show, four single-push
  core actions, one Ctrl/Meta+K handler and one palette action, lazy Workspace boundary, health
  failure/Retry and corrupt/denied storage.
- `packages/web/test/browser/shell-mount.spec.ts`: 9 mocked actual-App-route Chromium cases —
  chat/workspace/non-chat mounting and counts, per-link single push, move/rail/hide/show identity
  and reload geometry, palette keyboard/focus/route behavior, health loading/failure/Retry,
  corrupt storage, denied storage, and EN/RU 320 px reduced-motion overflow. These were authored
  and discovered with `--list`; they were **not executed** in this sandbox.
- `packages/web/test/component/shell-sidebar.test.tsx`: 1 added case for current-destination
  semantics on nested legacy routes.

**Inherited regression envelope:** the final focused component/unit run was **64 passed / 64
across 11 files**. Eight of those cases are the new component cases above; **56 inherited cases**
passed unchanged in the same run, including shell controller/sidebar/status/palette, kernel slot,
project chat and localization/copy inventory. Earlier focused runs were superseded and are not
added again.

The browser fixtures and existing browser tests were adapted where the actual shell changed the
flow, without deleting or skipping assertions:

- `fixtures/chat-api.ts` and strict mocks now answer `/api/sessions/page` so the real shell session
  read does not create unrelated false alerts.
- `kernel-slot.spec.ts` still proves plugin appearance/update/unload and focus handoff; the next
  focus target is now the host slot's Refresh sessions control, and the independent `+ New` chat
  list link remains visible.
- `runtime-bar.spec.ts` and `resource-conflict.spec.ts` navigate back to Chat through the real
  palette instead of the removed Chat top-bar link.
- `runtime-health.spec.ts` asserts the four fixed links and the localized shell instead of the
  removed Chat link.
- `localization.spec.ts`, `chat-terminal-reload.spec.ts` and `flows-axe.spec.ts` add the session
  page fixture so the new shell read is not counted as a forbidden effect or a second alert.

## Checks run

Node 26.9.0; `@guanxi/contract` resolved to
`/Users/yuzuru/Projects/Guanxi-lanes/u1-shell-mount/packages/contract/src/index.ts`.

| Command (scoped; `nice -n 10`, Node 26 PATH) | Result |
| --- | --- |
| `npx tsc --noEmit -p packages/web/tsconfig.json` | PASS, exit 0 |
| `npx tsc --noEmit ...` over the three new test/fixture files | PASS, exit 0 |
| `npx eslint` over the changed source, test, fixture and inventory files | PASS, exit 0 |
| `npx vitest run` over the 11 focused component/unit files | PASS, **64/64**, zero skips |
| `npx vitest run test/unit/shell-preferences.test.ts` | PASS, **3/3** inherited |
| `npx playwright test test/browser/shell-mount.spec.ts --list` | 9 tests discovered; not run |
| `git diff --check` | clean, exit 0 |

No `agent-dev` receipt exists: this sandbox did not take the shared heavy lock.

## Explicitly not run

No full `npm test`, `npm run test:web:browser`, actual Chromium execution of the new browser tests,
`npm run ui:check`, `npm run ui:check:browser`, Storybook, visual snapshots, `npm run build`,
full workspace typecheck, or shared-lock/heavy command was run here. The actual 320 px layout, real
Workspace/Dockview mount, axe result, focus trap, reload and reduced-motion behavior are therefore
**authored assertions, not observed browser evidence**. No screen-reader speech, live model,
provider, network, container or production validity is claimed.

## Component review warnings

The host imports only public `@guanxi/ui` components. The following used records are unsigned
`review`, with `approval: null` and signature absent; product use is a handoff warning under
`COMPONENTS_AND_CATALOG.md` §4 and blocks a stage/release exit until the owner signs:

| Component | Record | Catalog |
| --- | --- | --- |
| `AppShellChrome` | `review` | `/settings/developer/components?component=app-shell-chrome` |
| `Button` | `review` | `/settings/developer/components?component=button` |
| `Dialog` | `review` | `/settings/developer/components?component=dialog` |
| `Input` | `review` | `/settings/developer/components?component=input` |

`IconButton` and `Menu` are `draft` primitives used inside `AppShellChrome`, not imported by the
host. No review record, approval, signature, primitive source, catalog snapshot, token, generated
asset or suppression policy was changed. No `approved` status was written, and no owner key or
confirmation was used.

## Exact changed paths

Implementation commit `9a1aaa26`:

- `packages/web/src/App.tsx` — health gate plus single RuntimeProvider/MountedShell/route switch.
- `packages/web/src/features/shell/MountedShell.tsx` — new host composition.
- `packages/web/src/features/shell/ShellSidebar.tsx` — nested-route `aria-current`.
- `packages/web/src/features/shell/messages.ts` — two EN/RU keys.
- `packages/web/src/features/shell/useShellController.ts` — expose the existing theme setter.
- `packages/web/src/features/chat/ChatPage.tsx` — remove the second SidebarSlot; keep the list.
- `packages/web/src/kernel/SidebarSlot.tsx` — stable `data-slot="sidebar-slot"` marker.
- `packages/web/scripts/localized-copy-inventory.mjs` — remove the now-stale App.tsx brand
  exception; the guard is tighter, not weaker.

Test commit `761f01e3`:

- new `packages/web/test/component/mounted-shell.test.tsx`;
- new `packages/web/test/browser/shell-mount.spec.ts`;
- new `packages/web/test/browser/fixtures/shell-navigation.ts`;
- `packages/web/test/component/shell-sidebar.test.tsx`;
- adapted `packages/web/test/browser/fixtures/chat-api.ts`, `kernel-slot.spec.ts`,
  `runtime-bar.spec.ts`, `resource-conflict.spec.ts`, `runtime-health.spec.ts`,
  `localization.spec.ts`, `chat-terminal-reload.spec.ts`, `flows-axe.spec.ts`.

This handoff commit changes only `docs/plans/lanes/U1-shell-mount.handoff.md`.

## Residual risk and next unfinished scope

- Actual Chromium/axe, 320 px EN/RU, reduced-motion, focus-trap/Escape, Workspace/Dockview and
  reload geometry remain unexecuted. The browser spec is a candidate for root execution, not green
  evidence.
- The phone shell stacks the expanded sidebar above main. Real route content can start below the
  fold; `connections.spec` still requires its section to be in the viewport. Root should run the
  full browser gate and decide whether that interaction needs adaptation without weakening it.
- The real shell session read now runs on every mounted route. Strict test mocks that still fall
  back to 500 may render a local session error in the sidebar even when their own assertion is
  unrelated; root should watch for duplicate-alert or layout side effects in the full browser gate.
- The quick theme action is new host placement in the status strip; its 320 px wrapping and contrast
  are not browser-measured here.
- The shell remains composed of unsigned `review` components; no stage/release exit or owner
  approval is claimed.
- Independent review is reserved. Findings must be fixed later in separate commits on this branch.
- Full new-session design, finished-unseen, ephemeral side chat, remaining literal CSS/U1-c
  migration, signed approvals and the U1/MS1 stage exits remain separate work. Root owns main,
  central statuses and all final gates.
