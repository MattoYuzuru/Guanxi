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
| `src/styles/token-stub.css` | **temporary** semantic token values from FOUNDATIONS; delete it when DS1-a's generated tokens are on main |
| `catalog/` | the in-app catalog (renderer, regime frames, review panel, T2 iframe sample), `manifest.json` (generated), `approval/` (signed review records), `approval-keys.json` (trusted public keys), `snapshots/` (G13 baselines) |
| `catalog/harness/` | the static page the browser gates render stories in |
| `gates/catalog/` | G10–G16, their seeded violations and `run.ts` (interim runner until DS1-a's registry) |
| `.storybook/` | Storybook 10 over the same story files |

## Rules that are easy to miss

- Style with semantic custom properties only (`var(--color-…)`, `--space-…`, `--density-…`,
  `--motion-…`); no literal colours, spacing, sizes or durations. Glass only on floating layers.
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
npm run ui:catalog:check     # G10, G11, G12, G15 (static); add --selftest to prove the seeds fail
npm run ui:check:browser     # G13 (in Docker), G14, G15 clipping, G16
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
4. `npm run ui:manifest`, `npm run ui:catalog:check`, `npm run ui:check:browser`, and new G13
   baselines with `npm run ui:snapshots`.
5. Hand off with the component as a new `draft` and its catalog link
   (`/settings/developer/components?component=<id>`).
