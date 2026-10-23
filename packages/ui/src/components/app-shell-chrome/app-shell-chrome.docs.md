---
id: app-shell-chrome
level: pattern
states: [default, rail, hidden, right, phone, loading, error, offline, unknown]
tokens: [layout-container-2xs, spacing-4, spacing-8, spacing-48, color-background-primary, color-text-primary, font-family-sans, font-text-size, font-line-height-ui]
since: 0.1.0
---

# AppShellChrome

## Purpose

Fixes the three persistent parts of the app shell: a glass status strip, a glass navigation
sidebar that can be moved, collapsed or hidden, and an opaque main reading surface. The host
supplies all navigation, status and workspace content through controlled props.

## When to use

- A product screen that needs the persistent navigation, status strip and command-palette entry
  around session, project or settings content.
- Any layout where the user controls the sidebar side and whether it is expanded, a rail or
  hidden, while the main content must stay mounted.

## When not to use

- A workspace whose panes are docked or floated: use `WorkspaceLayout` with `WorkspaceChrome`.
- A dialog, sheet or settings form that does not own the shell landmarks.
- A place where the host cannot supply translated labels, navigation content and a truthful
  status node.

## Anatomy and variants

`AppShellChrome` renders a status strip, then a row containing the sidebar and `<main>`. `side`
selects whether the sidebar precedes or follows the main element in the DOM; it is not a CSS
reorder. `visibility` selects the expanded 18 rem sidebar, the 48 px rail or the hidden state.
Both visible widths include the sidebar's 1 px glass border, so the glass edge never adds width
outside the shell. The sidebar header owns a menu with Move, Collapse/Expand and Hide actions.
The status strip always owns the Palette action and, while the sidebar is hidden, the Show action.

The host owns the sidebar node in every visibility. This pattern supplies the rail geometry but
does not invent rail cards, model state or status items; the host should render compact rail
content when `visibility` is `rail`.

## States

- `default` — left, expanded sidebar with host navigation and an opaque main surface.
- `rail` — left, 48 px, with host-provided compact content.
- `hidden` — the sidebar stays mounted with `hidden` and `inert`; Show and Palette remain in the
  always-visible status strip.
- `right` — the same expanded shell with the sidebar after main in the DOM and visually.
- `phone` — at the 639 px workspace breakpoint, measured on the shell itself, the strip is one
  row: a navigation toggle, the breadcrumb, one overflow control (`labels.more`) that holds the
  status actions, and the search icon without keycaps. The navigation is a drawer: closed by
  default, opened over a scrim with the page inert, closed by Escape, the scrim or a followed link,
  with focus returned to the toggle. A drawer is never a rail: a function `sidebar` receives
  `{ rail: false }`. Keycaps are also hidden on any coarse pointer. Host content remains
  responsible for staying within its own width.
- `loading` — the status strip announces loading and the main surface is `aria-busy`; the
  fixture declares no run status and renders no transcript.
- `offline` — a visible not-connected status and one sentence about unavailable live data; it
  offers no plugin-enable or retry advice because the fixture observed no such recovery.
- `error`, `unknown` — an explicit error and the generic unknown state; unknown stays unknown
  and is distinct from the connection-loss story. These are stories of truthful host content,
  not internal component states and not invented runtime facts.

## Accessibility

- The status strip and its Show and Palette actions are never hidden with the sidebar. Hiding a
  focused sidebar moves focus to the persistent Show button; showing it again returns focus into
  the sidebar.
- Sidebar and main are stable keyed elements: collapsing, hiding or moving the sidebar preserves
  their React and DOM state. A hidden sidebar also carries `inert`, so focus cannot enter it.
- `side` changes the actual DOM and focus order, not only a visual order property.
- The sidebar is a labelled complementary landmark; its menu trigger is a native named button
  with a tooltip. Menu items are keyboard reachable with the existing Menu primitive. Status
  actions are native Buttons, so their normal keyboard activation is preserved.
- The status strip and sidebar use the shared glass material; the main surface is opaque. Text
  and control contrast come from the catalogued primitives and generated tokens.
- Geometry uses CSS, plus one ResizeObserver on the shell itself for the narrow flow (not a
  viewport listener). Resizing never resets the controlled side or visibility; a drawer closes
  when the shell becomes wide.
- The phone drawer moves focus into the sidebar when it opens, makes the strip and main inert,
  and returns focus to its toggle when it closes. The overflow popover is named by `labels.more`
  and stays mounted while closed, so the status items keep their state.

## Content and i18n

`sidebarLabel`, `labels.show`, `labels.collapse`, `labels.expand`, `labels.hide`,
`labels.moveLeft`, `labels.moveRight` and `labels.palette` are required translated strings
supplied by the localized host. The component renders no product copy of its own. The stories
resolve all seven control labels through `story.appShell.*` message keys and the sidebar name
through the existing `story.workspace.blocks` key, in English, curated Russian and the
pseudo-locale; they do not claim host usage or owner approval. The loading and offline fixture
copy resolves through `story.appShell.hostLoading`, `hostLoadingBody`, `hostOffline` and
`hostOfflineBody`. Those stories claim no run status, transcript, plugin enablement, retry
action or provider provenance.

## Motion

The pattern adds no motion. The menu and focus states inherit the existing primitives and their
reduced-motion tokens; nothing in the shell loops or animates layout.

## Do / Don't

- Do keep the sidebar and main mounted through collapse and hide.
- Do render host-provided rail content; do not fill the rail with invented model or status data.
- Do keep the main reading surface opaque and glass limited to the sidebar and status.
- Don't use this pattern as a docking engine or move another plugin's blocks.
- Don't replace the status Show and Palette actions with conditional shell rendering.
- Don't add a viewport listener for the phone flow; the shell measures itself against the existing
  639 px breakpoint (`APP_SHELL_NARROW_MAX`), the single source for the narrow layout.
