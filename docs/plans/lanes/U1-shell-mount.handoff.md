# U1 mounted product shell — handoff

**Status:** bounded host composition implemented; independent-review endpoint and contrast P2
repairs implemented; focused sandbox checks passed; actual browser, axe, responsive and full
gates remain root/reviewer-owned. This is not a full U1, MS1 or production claim.
**Date:** 2026-10-22 · **Branch:** `codex/u1-shell-mount` · **Base:** `b1046a30` · **Commits:**
`9a1aaa26` implementation, `761f01e3` tests, `20f0331f` original handoff, `bfef83cd` root
repair authorization, `a4aaa6f6` endpoint red test, `dd22feb6` endpoint fix, `ed60bc3f`
contrast red test, `304bfa28` contrast fix, this handoff commit. No push, merge, rebase,
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

## Independent-review repair round (2026-10-22)

**Scope:** the two independent P2 findings in
`reviews/codex-u1-product-shell-20261022.md` that the root plan authorized as endpoint-fixture
and contrast repairs. The review's draft-primitive/G11 finding (`IconButton`, `Menu`, `Tooltip`
closure) is not touched: no primitive source, review record, status, signature, snapshot or gate
policy changed. No full U1/MS1 conclusion follows.

### Commits and exact changes

- `a4aaa6f6` `test(web): require empty shell sessions in mounted cases` — red test first.
  `shell-mount.spec.ts` now names the intended empty session text and requires zero session
  alerts in all nine mounted browser cases, including the EN/RU 320 px cases and after reload.
  `mounted-shell.test.tsx` does the same in its real-App chat case. With the old wrong mock this
  failed (observed below), so the wrong route can no longer pass on unrelated assertions.
- `dd22feb6` `fix(web): mock the canonical session page route` — replaced every added fixture
  branch for `/api/sessions/page` with the contract value `SESSION_ROUTES.page()`
  (`/api/sessions/list/page`): `fixtures/chat-api.ts`, `shell-mount.spec.ts`,
  `mounted-shell.test.tsx`, and the adapted `chat-terminal-reload`, `flows-axe`, `localization`,
  `resource-conflict`, `runtime-bar` and `runtime-health` files. Init-script callbacks receive
  the constant as a serialized argument because they cannot import in the browser context; the
  Node-side route handlers import it directly. No forbidden-effect, alert, request-count,
  lifecycle or runtime assertion was relaxed.
- `ed60bc3f` `test(web): require zero new-session contrast diagnostics` — removed the
  `KNOWN_CACHE_BAR` two-node exception from `flows-axe.spec.ts`. The complete new-session flow
  (empty chat screen plus created dialog/composer) now requires zero serious/critical axe
  findings. Added a proportional discriminator: the inactive hit row must have computed
  `opacity: 1` and a different computed text colour from the active miss row. Both seeded
  unnamed-button controls (Settings and new-session) are retained unchanged.
- `304bfa28` `fix(web): use secondary text for inactive cache rows` — one production line in
  `ContextPanel.tsx`: `!active && 'opacity-45'` became `!active && 'text-secondary'` (the
  existing semantic text token). Active rows keep primary text and the arrow; labels, durations
  and active/inactive meaning are unchanged. No new token, raw colour/duration, ignore,
  suppression, viewport workaround or hidden node.

**Shared edits, explicitly recorded:** `packages/web/src/features/context/ContextPanel.tsx` is a
shared production file and `packages/web/test/browser/flows-axe.spec.ts` is the shared G14 flow
gate; both were changed only under the root-authorized repair section. No other shared path
changed.

### New vs inherited

- Repository case identities added/removed/skipped by this repair: **0 / 0 / 0**. The nine
  `shell-mount` browser cases and seven `mounted-shell` component cases remain the original
  slice's new cases with strengthened assertions; the eighth new component case is in
  `shell-sidebar.test.tsx`, untouched. `flows-axe` is inherited regression scope.
- Focused component result: **11/11 passed, zero skips** — 7 new `mounted-shell` cases plus 4
  inherited `context-checkpoint` cases.
- Browser cases discovered but not executed: 9 new `shell-mount` + 4 inherited `flows-axe`.
  The adapted legacy subset is inherited envelope, not additional new credit.

### Checks run (sandbox, Node 26.9.0, `nice -n 10`)

| Check | Result |
| --- | --- |
| `npx vitest run test/component/mounted-shell.test.tsx` before the mock fix | **1 failed / 6 passed**: the sidebar rendered `Sessions could not be refreshed. Try again.` instead of the empty text. This is the red evidence for `a4aaa6f6`. |
| Same component file after `dd22feb6` | **7/7 passed**, zero skips |
| `npx vitest run test/component/mounted-shell.test.tsx test/component/context-checkpoint.test.tsx` after the contrast fix | **11/11 passed**, zero skips |
| `npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |
| Scoped `tsc` over `mounted-shell.test.tsx` and `shell-mount.spec.ts` with DOM, bundler resolution, `vite/client` and Node types | exit 0 |
| `npx eslint` over the changed source, fixture and test files (10 files) | exit 0 |
| `npx playwright test test/browser/shell-mount.spec.ts test/browser/flows-axe.spec.ts --list` | 13 tests in 2 files (9 + 4), no execution |
| `git diff --check` | clean |

### Explicitly not run

No actual Chromium execution, no axe scan, no `npm test`, no full
`npm run test:web:browser`, no `npm run build`, no full workspace typecheck, no `ui:check` or
`ui:check:browser`, no Storybook/visual snapshot, and no shared-lock/`agent-dev` command. The
new empty-session assertions, the zero-diagnostic flow result and the computed-style contrast
discriminator are therefore **authored tests, not observed browser evidence**; root/independent
Sol must run the actual affected/new browser subset, including the seven adapted legacy files
from the review (`kernel-slot`, `runtime-bar`, `runtime-health`, `resource-conflict`,
`localization`, `chat-terminal-reload`, `flows-axe`). No screen-reader, real-device, live model,
provider, network, container or production validity is claimed.

### Original review failures addressed

The reviewer observed the adapted 18-case legacy subset at 11 pass / 7 fail. This repair targets
the path-mismatch failures: duplicate/extra session alerts in `chat-terminal-reload` and
`localization`, `kernel-slot` expecting the empty list but receiving the refresh error, and the
`localization` forbidden-effect count seeing two `GET /api/sessions/list/page`; the seventh,
`flows-axe` G14, was the two-node cache-bar contrast matcher. The earlier 8/8 component and 9/9
browser new-case results were not re-labelled as this round's evidence. The review's remaining
draft-primitive/G11 finding and its external counterexample are untouched and remain separate
work.

### Boundaries unchanged

No server, contract, wire, DB, migration, dependency, license, privacy, owner-data, secret,
signing-key, approval, review-record, snapshot, catalog-manifest, G11/tooling or central status
change. No source status was promoted, no `approved` record written, no owner key used, and no
push/merge to `main`. The existing warnings stay explicit: `AppShellChrome`, `Button`, `Dialog`
and `Input` are unsigned `review`; `IconButton`, `Menu` and `Tooltip` remain `draft` inside the
shell with approval null, so a stage/release exit is still blocked. Root owns the actual browser/
axe recheck, final gate decision and status fold-in. Draft warning/blocker status is unchanged.
