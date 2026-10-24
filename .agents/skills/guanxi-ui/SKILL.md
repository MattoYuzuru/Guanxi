---
name: guanxi-ui
description: Build or change Guanxi user interface with the design system — web and desktop screens, blocks, plugin UI, themes, tokens or components. Use whenever a .tsx or .css file under packages/web, packages/ui or a plugin's UI is edited, a component or token is added, a layout or block is changed, or a UI review is requested.
---

# Guanxi UI

You are building UI that many agents change in parallel. Consistency comes from one design
system and checks that fail, not from taste. Read before writing JSX:

- `docs/design/PRINCIPLES.md` — seventeen principles, each with how to tell it is broken.
- `docs/design/FOUNDATIONS.md` — tokens: colour (palette swaps are token-only, D-201), type
  (IBM Plex), spacing, radius, elevation, glass, motion, icons (the `Icon` registry), density,
  graphics tiers.
- `docs/design/research/2026-10-23-redesign.md` — the D-200–D-207 direction: white panes on the
  chrome, icon status items, no Retry or visible polling, one interface, the composer layout.
- `docs/design/LAYOUT_AND_SCREENS.md` — zones, blocks, modes, screens, the state vocabulary.
- `docs/design/COMPONENTS_AND_CATALOG.md` — component levels, catalog, approvals, gates.
- `docs/design/BRAND.md` — logo rules, voice and tone, copy rules.

## Status of the tooling

The token pipeline, `@guanxi/ui`, the catalog and the `ui:check` gates are built in roadmap
stage DS1. Before DS1 lands, follow the same rules by hand and say so in your hand-off; after it
lands, the commands below are mandatory.

## Decision ladder

1. **Find** an existing component in the catalog (Settings → Design system → Components, Storybook,
   or `packages/ui/catalog/manifest.json`) before writing anything:
   `node .agents/skills/guanxi-ui/scripts/find-component.mjs "<need>"`.
2. **Reuse** an approved component as is.
3. **Extend** an existing component with a variant (this makes an approved component `stale`
   until the owner re-approves).
4. **Compose** a pattern from primitives.
5. **Create** a new component only when nothing above fits: scaffold its folder with stories per
   state, docs and a `review.json` set to `draft`
   (`node .agents/skills/guanxi-ui/scripts/new-component.mjs <id> --level pattern --states a,b`). Never restyle a primitive's colour or type
   through `className` in a feature.

## Rules

- **Tokens only.** Semantic utilities and variables (`bg-surface`, `text-muted`,
  `border-control`, `gap-2`); no palette classes, hex values, arbitrary values or raw durations.
  If no token fits, stop and propose one in the hand-off; do not invent it.
- **Glass only on floating layers** (menus, popovers, toasts, dialogs); reading surfaces, panes
  and the composer stay opaque; the sidebar and status strip sit directly on the chrome; never
  glass on glass.
- **Icons over prose** (D-202): status as `StatusItem`, actions as `IconButton` with a name and a
  tooltip; values carry the weight; no decorative middle dots.
- **Live data** (D-203): no Retry/Refresh buttons and no "updated N s ago" captions; use
  `useAsync` (quiet revalidation, automatic recovery, structural sharing) or `useAutoRecover`.
- **States.** Cover default, hover, focus-visible, active, disabled, loading, empty, error,
  offline, unknown and estimated where they apply; each declared state has a story.
- **Provenance.** Every number shows its source and age; unknown renders as unknown, never `0`.
- **Content.** Locale keys only (English source, curated Russian); follow BRAND voice and tone;
  mono face only for machine values.
- **Motion.** Motion tokens only; nothing moves under reduced motion; streaming text never
  animates; status never relies on motion alone.
- **Accessibility.** A name for every control, keyboard path (including moving blocks without
  dragging), focus return, `aria-live` for streaming and status, 24 px minimum targets.
- **Layout.** Blocks are slot contributions; never move another plugin's block; the navigation's
  four core entries always exist.
- **Imports.** Only from `@guanxi/ui`; never from its internals, `@base-ui/react`, `lucide-react`
  or `motion` directly. Name icons through `Icon` (`<Icon name="inbox" />`).

## Verify

1. During iteration, run `npm run ui:check`, focused component tests and affected stories.
   Full browser/catalog gates run on the final ready PR per `docs/operations/ci.md`; do not
   repeat them locally after each edit. A heavy local reproduction uses the shared lock.
2. Update visual snapshots only inside the pinned Playwright Docker image (`npm run ui:snapshots`).
3. Never edit generated token output; never set `approved` — only the owner approves, in the
   app, with a signed record.
4. The ESLint suppression file must not grow.
5. In component tests, settle an asynchronous mocked failure with `await act(async () =>
   { /* render or interaction */ })` before sending synthetic focus/online recovery events.
   Visible error DOM alone does not prove passive recovery listeners are installed. Keep
   exact request/error assertions; do not hide ordering races with retries or longer timeouts.

## Hand-off

List the components you touched, their status changes (for example `approved → stale`), new
draft components, and the catalog link of each changed story so the owner can approve or request
changes. Run the review checklist in `docs/design/COMPONENTS_AND_CATALOG.md` §7.
