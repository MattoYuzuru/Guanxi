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
- `phone` — the 639 px workspace breakpoint stacks status, sidebar and main in the host's
  DOM/focus order (a right sidebar follows main) and removes the fixed column widths; the phone
  story renders a narrow, tokenised frame. Host content remains responsible for staying within
  its own width.
- `loading`, `error`, `offline`, `unknown` — host content states shown in the status and main
  areas. They are stories of truthful host content, not internal component states and not
  invented runtime facts.

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
- Geometry uses CSS only. No viewport listener or JavaScript ceiling resets controlled state on
  resize.

## Content and i18n

`sidebarLabel`, `labels.show`, `labels.collapse`, `labels.expand`, `labels.hide`,
`labels.moveLeft`, `labels.moveRight` and `labels.palette` are required translated strings
supplied by the localized host. The component renders no product copy of its own. Stories use
synthetic English or existing story message keys and do not claim host usage or owner approval.

## Motion

The pattern adds no motion. The menu and focus states inherit the existing primitives and their
reduced-motion tokens; nothing in the shell loops or animates layout.

## Do / Don't

- Do keep the sidebar and main mounted through collapse and hide.
- Do render host-provided rail content; do not fill the rail with invented model or status data.
- Do keep the main reading surface opaque and glass limited to the sidebar and status.
- Don't use this pattern as a docking engine or move another plugin's blocks.
- Don't replace the status Show and Palette actions with conditional shell rendering.
- Don't add a JavaScript width listener for the phone flow; the existing 639 px breakpoint is
  the single source for the narrow layout.
