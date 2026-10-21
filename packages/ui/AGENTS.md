# @guanxi/ui — instructions for agents

**Status:** implemented on lane DS1-b (components, catalog, approvals, G10–G16); tokens, fonts and
G1–G7 come from lane DS1-a · **Updated:** 2026-10-20

Load the [`guanxi-ui` skill](../../.agents/skills/guanxi-ui/SKILL.md) first. The design rules live
in [`docs/design/`](../../docs/design/README.md); this file only says where things are and which
commands prove a change.

## Layout

| Path | What |
| --- | --- |
| `src/components/<id>/` | one folder per component: `<id>.tsx`, `<id>.css`, `<id>.stories.tsx` (one story per declared state), `<id>.docs.md`, `<id>.review.json`, `index.ts` |
| `src/index.ts` | the only public entry; features and plugins import from `@guanxi/ui` and nothing deeper |
| `src/story-kit/` | portable CSF 3 types, `msg()` for message keys in story args, `machine()` for untranslated machine values, `localizedRender()` for custom renders |
| `src/i18n/` | English source, curated Russian and the +40% pseudo-locale for `ui.`, `story.` and `catalog.` keys |
| `src/styles/base.css`, `src/styles/tailwind-reference.css` | shared component styles; the Tailwind reference (with `generated/theme.css`) that component CSS uses for `@apply` |
| `tokens/`, `generated/`, `fonts/`, `gates/*.mjs` | DS1-a's token sources, generated CSS/TS, local Plex and the G1–G7/G17 runner; regenerate with `npm run tokens:build` |
| `catalog/` | the in-app catalog (renderer, regime frames, review panel, T2 iframe sample), `manifest.json` (generated), `approval/` (signed review records), `approval-keys.json` (trusted public keys), `snapshots/` (G13 baselines) |
| `catalog/harness/` | the static page the browser gates render stories in |
| `gates/catalog/`, `gates/extensions/catalog.gate.ts` | G10–G16, their seeded violations, `run.ts` (catalog runner with self-test) and the registration DS1-a's runner loads |
| `.storybook/` | Storybook 10 over the same story files |

## Rules that are easy to miss

- Style with generated tokens only (`var(--color-…)`, `--spacing-…`, `--control-height`,
  `--layer-…`, `--focus-ring-…`, `--motion-…`, `--material-…`); no literal colours, spacing,
  sizes, layers or durations (G4–G7). A value no token expresses (`100%`, a transition list, a
  multiple of a size) comes from a Tailwind utility through `@apply`, after
  `@reference '…/styles/tailwind-reference.css'`. Glass only on floating layers; strong glass is
  `data-elevation="3"`.
- Fades use `--motion-fade-*`; spatial motion uses `--motion-duration-*` and
  `--motion-distance-*`, which are 0 under reduced motion, so no per-component reduced-motion
  rule is needed.
- Every user-facing string is a message key; story args use `msg('story.…')`.
- Declare states in the docs front matter; the stories' `name`s must be exactly those states.
- Floating layers mount through `usePortalContainer()` so they inherit the theme of their frame.
- Never set `"status": "approved"` and never write `approval`. Only the owner approves, in the app;
  the node signs the record with the owner key from the macOS keychain. Agents may write `draft`
  and `review` records and change requests.
- Never edit `catalog/approval-keys.json`; a key-set change on a branch fails G12 unless a key
  already trusted on `main` signs it.
- Baselines are written only inside the pinned Playwright image (`npm run ui:snapshots`); never
  update them on the host. A baseline change makes an approved component `stale`.

## Commands

```bash
npm run ui:manifest          # regenerate catalog/manifest.json after any component change
npm run ui:check             # DS1-a's runner: G1–G7, G10–G12, G15 and G17 (one seed per gate)
npm run ui:check:browser     # same runner, browser gates: G13 (in Docker), G14, G15-clipping, G16, G17
npm run ui:catalog:selftest  # catalog runner: every seed of every catalog gate, fast and browser
npm run ui:snapshots         # rewrite G13 baselines in the pinned image
npm run ui:storybook         # Storybook dev server on GUANXI_WEB_PORT
npm test --workspace @guanxi/ui
```

Run the browser gates and Storybook builds through the shared lock
(`agent-dev run --cwd "$PWD" --node 26 --resource heavy -- …`). `GUANXI_UI_G13=skip` reports G13
as skipped (never as passed) where the pinned image is unavailable.

## Adding a component

1. `node .agents/skills/guanxi-ui/scripts/find-component.mjs "<need>"` — reuse or extend first.
2. `node .agents/skills/guanxi-ui/scripts/new-component.mjs <id> --level pattern --states a,b`.
3. Implement, write the docs (G10 rejects `TODO`), add message keys in `src/i18n/messages.ts`.
4. `npm run ui:manifest`, `npm run ui:check`, `npm run ui:check:browser`, and new G13
   baselines with `npm run ui:snapshots`.
5. Hand off with the component as a new `draft` and its catalog link
   (`/settings/developer/components?component=<id>`).
