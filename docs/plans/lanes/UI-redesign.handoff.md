# UI-redesign lane hand-off

**Status:** implemented, locally validated (mocked browser gate, no live model) · **Updated:** 2026-10-23 ·
**Branch:** `claude/ui-redesign` from `631cd5c8` · **Plan:** [UI-redesign.plan.md](UI-redesign.plan.md) ·
**Research:** [2026-10-23 redesign](../../design/research/2026-10-23-redesign.md)

## What changed

| Phase | Commits | Content |
| --- | --- | --- |
| 0 research | `17628ac4` | Research note with sources; OKLCH palette generator (`packages/ui/tokens/palettes/generate.mjs`) solving contrast against chrome and pane; three candidates; draft `palette-preview` catalog component; lane plan |
| 1 foundations | `64c56322` | Porcelain + Cobalt applied by `apply.mjs` to primitive tokens and FOUNDATIONS tables; pane, control and highlight elevation tokens; hairline border; radii 6/8/12/14; five pane contrast pairs; `Icon` registry over Lucide with Guanxi-drawn domain glyphs |
| 2 components | `bd8c3e79` | Every primitive restyled; subtle status fills (contrast-gated), focus halo and inset shadow tokens; new `Kbd`, `SegmentedControl`, `StatusItem`, `Composer`; geometry browser spec |
| 3 shell and screens | `aacbf219`, `f3709e52`, `47cec7af`, `e5100469`, merges `69db07f9`, `c025735e` | Floating-pane shell, icon status strip, customisation popover, light/dark toggle, Developer/Visual split removed (chrome, palette, workspace), runtime bar and Ollama banner folded into the runtime status item; `useAsync` quiet revalidation + automatic recovery + structural sharing; quiet session list; Retry/Refresh removed harness-wide (feature pages through a forked sub-lane); D-207 new session, docked native session and chat composer; per-message details popover; legacy primitives render through the design system; markdown CSS rewritten on tokens; docs and skill updated |
| 4 max graphics | `17cf8711` | Opt-in WebGL field behind the chrome, suppressed under reduced motion/transparency, HC, forced colours, battery saver, GPU off and without WebGL |
| tests | `860b40a3`, `9acd6df9`, `058f5862`, `25583d9f` | New and rewritten component and browser tests (below) |
| review fixes | `1536b773`, `975a0c99`, `212548f5`, `c61184de` | Independent accessibility review findings; browser-spec findings; provider-model display for merge with the K3-chat lane |
| merge and gate fixes | merge `7b411ca4`, `11dcfa90`, `3ccbea13`, `5a913430`, `cc6e05e7`, `4a64990c`, `e260bfc5` | Main merged before hand-off; legacy buttons keep caller utilities; G14 phone geometry, icon labels and scroll regions; legacy-detail gate tests rewritten for the redesigned primitives; decorative middle dots removed harness-wide (145 in 34 files) with a guard test; Retry retired from catalog stories; server inventory tests aligned; icon grid fits the catalog frame |

## Palette (pending owner approval)

| Candidate | Light chrome / pane / accent | Dark chrome / pane / accent |
| --- | --- | --- |
| **Porcelain + Cobalt** (working default) | `#EFF3F8` / `#FFFFFF` / `#285DD2` | `#0D1014` / `#16191D` / `#739DEF` |
| Mist + Indigo | `#F1F2F9` / `#FFFFFF` / `#4D5AC8` | `#0F0F15` / `#18181E` / `#8899EA` |
| Linen + Azure | `#F5F2ED` / `#FFFFFF` / `#0064C1` | `#110F0D` / `#1B1816` / `#63A1E5` |

Swap: `node packages/ui/tokens/palettes/apply.mjs <id> && npm run tokens:build && node packages/ui/tokens/palettes/apply.mjs --measure`, then update the two pinned G3 baselines in `packages/ui/gates/gates.test.mjs`.

## Screenshots

`/Users/yuzuru/Projects/Guanxi-lanes/redesign/.lane-data/screens/` (git-ignored): `new-session-{light,dark}-{desktop,mobile}.png`
(empty session), `active-session-{light,dark}-{desktop,mobile}.png` (docked composer), `status-popover-{light,dark}.png`,
`customise-{light,dark}.png`, `max-graphics-{light,dark}.png`, `models-light.png`, `palette-candidates.png`, and
`before-*.png` for comparison.

## What the tests prove

New (this lane): `packages/ui/test/redesign-controls.test.tsx` (icon names and constant stroke; segmented radio
semantics; StatusItem names, Unknown never 0, badge cap; Composer Enter/Shift+Enter/IME, Send focusable while blocked,
Stop), `packages/ui/test/surface-contrast.test.tsx`, `packages/web/test/component/live-data.test.tsx` (structural
sharing, quiet refresh renders nothing and toggles no flag, backoff and online recovery, appearance defaults),
`packages/web/test/component/max-graphics.test.tsx` (text over the worst field colour, suppression rules),
`packages/web/test/browser/controls-geometry.spec.ts` (switch knob centred in both states and icons centred, both
themes and densities; mutation-checked: shifting the knob or the glyph fails it). `packages/web/test/unit/no-middle-dots.test.ts`
(D-202: no `·` in any web or design-system source file or in either merged locale catalogue; mutation-checked by
reinserting one). Rewritten with explicit absence
counts: shell status/sidebar/unseen/controller/mounted-shell, runtime-health, notifications bell, new-session,
native-agent, workspace-state, and the feature-page tests of the retry sub-lane. Browser specs updated: shell-mount
(incl. three Max graphics cases), new-session, native-agent, workspace, notifications, localization, session search,
unseen sessions, runtime-bar, runtime-health, resource-conflict, chat-first-stream, chat-retention, connections,
kernel-slot, capability-override and the feature specs of the retry sub-lane.

## Gates

All heavy checks ran through `agent-dev run --node 26 --resource heavy` on a clean tree; receipts are under
`~/.local/state/agent-dev/<id>/result.json`.

| Gate | Head | Result | Receipt |
| --- | --- | --- | --- |
| `npm test` | `e260bfc5` | pass (web vitest 683/683, ui vitest, gates, server, kernel, bench) | `check-4k4f10co` |
| `npm run test:web:browser` | `4a64990c` | 239/239 pass | `check-1sfqha6h` |
| `npm run ui:check:browser` (G13 + G14) | `4a64990c` | pass | `check-r7ooc2bj` |
| `npm run build` | `4a64990c` | pass | `check-zdjphd7l` |
| `npm run typecheck`, `lint:md`, `check:licenses`, `lint:js` | `e260bfc5` | pass (lint:js has 4 warnings that already exist on main) | local |
| Named-layout browser case, repeated | `4a64990c` | 30/30 after the menu-open wait (4/20 failed before) | `check-n1b4oo6q` |

`e260bfc5` changes only an exception entry in `packages/web/scripts/localized-copy-inventory.mjs`, so the browser,
G13/G14 and build receipts at `4a64990c` still cover the product code. G13 baselines were regenerated deliberately
in the pinned image (`check-e7slnxd6`, `check-o7zy0q22`, `check-md1le32k`) and reviewed one by one. Changed or added
since the first baseline commit `59684086`: `app-shell-chrome/phone-*` and `error-*` (edge-to-edge phone pane, no
separator), `icon/set-*` and `icon/domain-*` incl. HC (secondary-text labels, grid fits the frame), `error-state/*`
(no separator; `retrying` replaced by `acting`), `provenance-label/*` (no separator), `workspace-chrome/error-*`
(no Retry action).

## Independent verification

`frontend-agent:accessibility-reviewer` reviewed `631cd5c8..17cf8711` (13 findings, no blockers). All were fixed in
`1536b773` except two recorded below as residual. Browser-spec failures found by the first full run were fixed in
`975a0c99`, `25583d9f`, `212548f5`.

## Pending owner approval

- The palette (D-201): Porcelain + Cobalt is the working default; BRAND and FOUNDATIONS mark it pending.
- Component statuses: Icon, Kbd, SegmentedControl, StatusItem, Composer, Popover, Switch, Badge are `review`;
  PalettePreview is `draft`. Every restyled component's G13 baseline changed and needs re-review in the catalog.
- Max graphics look (strength 0.26/0.30, hues).

## Decisions taken by default

Recorded in the plan: failed user actions keep their own verb instead of Retry; the developer-area switch (D-137)
stays; theme toggle sets the explicit opposite and "Follow the system theme" lives in Customise; comfortable density
by default; the workspace still stores per-mode layout documents but uses one; first automatic workspace re-read after
10 s; inspector live stream keeps "Reconnect" (auto-reconnect would reset the timeline).

## Residual risk

- The inspector live-stream "Reconnect" remains (deliberate, above).
- `packages/ui/src/i18n/pseudo.ts` keeps dots as pseudo-locale padding (development only; the guard test allows it).
- The `PalettePreview` story is wider than the 800 px G13 frame and is clipped in its baseline.
- Some targeted browser reruns during development ran outside the lock; every receipt in the table above was taken under it.
- Rail navigation and the palette button use native `title` tooltips, not the design tooltip.
- Max graphics: measured in headless Chromium with software GL, input-to-next-frame p50 5.4 ms static vs 10.0 ms max,
  p95 6.2–6.9 ms vs 13.4–13.6 ms (both under one 60 Hz frame); hardware GPU not measured. The field pauses 600 ms after
  input.
- Phone: the sidebar still stacks above the pane under 640 px (no drawer).
- Device icon is inferred from the platform (`darwin`/`win32` laptop, `linux` server).
- Many feature pages keep legacy layouts; they inherit the tokens and primitives but were not redesigned one by one.
- Merge with `claude/chat-provider-models`: main's K3-chat change is merged; `displayModelSelection` uses the contract's
  `parseChatModelSelection` and shows only the model id. The new-session model picker takes a generic `ModelSuggestion[]`.

## Shared edits

`packages/ui/gates/local-variables.json` (`--available-height` scope for popover and status item), the gate tests
`foundations`, `inset-contrast` and `gates` (rewritten for the redesigned primitives, no assertion dropped), the
server tests `runtime-reconciliation` and `ui-catalog-review` (fixtures), `packages/web/scripts/localized-copy-inventory.mjs`,
`packages/ui/gates/legacy-allowlist.json` and `eslint-suppressions.json` (only shrunk), `packages/web/vite.config.ts`
(Base UI radio in `optimizeDeps`), `.agents/skills/guanxi-ui/SKILL.md`, ADR-0036 status line.

## Next slice

Owner reviews the palette and components in the catalog; then the fleet map (D-209) on StatusItem/Icon, provider
models (D-208) into `ModelSuggestion`, a phone drawer for the sidebar, and the remaining feature pages' layouts.
