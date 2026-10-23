# UI-redesign lane plan

**Status:** accepted plan (owner D-200–D-207) · **Updated:** 2026-10-23 · **Branch:**
`claude/ui-redesign` from `631cd5c8` · **Ports:** web 5235, API 4435, data `.lane-data/`

## Outcome

Guanxi gets a new look and interaction model in one lane: a token palette with a white session
surface and a bluer accent, a custom control set with pixel assertions, a shell of floating
panes with icon status items and anchored popovers, one interface without the Developer/Visual
split, the D-207 composer layout, live data without retry buttons, visible polling or flicker,
and an opt-in "max graphics" tier. Research and palette candidates:
[2026-10-23 redesign research](../../design/research/2026-10-23-redesign.md).

## Non-goals

- The fleet map (D-209) and provider models in chat (D-208): later lanes build them on these
  components; the model picker keeps a generic option interface for D-208.
- New node APIs. Effort and context controls appear only where the node already accepts the
  value; otherwise they are hidden, never faked.
- Approving the palette or any component: the owner approves; components stay `draft`/`review`.

## Phases and commits

| Phase | Content | Exit check |
| --- | --- | --- |
| 0 | Research note, palette generator, three candidates, catalog `palette-preview`, this plan | lint:md, ui:check |
| 1 | Foundations: apply the working palette to primitive tokens and FOUNDATIONS tables, elevation shadow and pane tokens, `data-graphics` root attribute, icon registry over Lucide plus custom domain icons | tokens:build, ui:check, gate tests |
| 2 | Components: restyle every primitive (button, icon button, select/dropdown, checkbox, switch, input, textarea, tabs, menu, popover, tooltip, dialog, toast, badge, status pill); add `Kbd`, `SegmentedControl`, `StatusItem` (icon + value + popover) and `Composer`; alignment assertions (switch knob centred in both states, icon optical centring) | ui tests, ui:check, browser gates |
| 3 | Shell and screens: floating panes; status strip as icons; customisation popover; theme toggle light/dark with system default; sidebar with icons, no refresh/fetched captions; Developer/Visual split removed; new session per D-207; native session with docked composer; chat composer and per-message icon actions; data layer: structural sharing, silent refresh, automatic recovery; retry/refresh buttons removed harness-wide; index.css rewritten; i18n keys en/ru | web tests, browser gate, screenshots |
| 4 | Max graphics: WebGL background behind the chrome, off by default, reduced-motion aware, paused when hidden; input latency measured | browser test, measurement |
| 5 | Independent review (frontend accessibility reviewer), fixes in separate commits, hand-off | all gates |

## Affected areas

- `packages/ui/tokens/**`, `packages/ui/generated/**` (regenerated, never hand-edited),
  `packages/ui/src/components/**`, `packages/ui/src/i18n/messages.ts`, catalog baselines.
- `packages/web/src/features/{shell,health,new-session,native-agent,chat,workspace,…}`,
  `packages/web/src/lib/{useAsync,theme}.ts(x)`, `packages/web/src/index.css`, locale keys.
- `docs/design/*` updated to D-200–D-207; FOUNDATIONS colour tables follow the working palette.

## Decisions taken by default (recorded for the owner)

- Working palette: Porcelain + Cobalt; the other two stay in the generator and the catalog.
- Failed user actions (a model pull, a download) keep their action button labelled with the
  action; only data reloads lose their Retry/Refresh buttons and recover automatically.
- The "developer area" switch for the component catalog (D-137) stays; only the
  Developer/Visual layout split (D-132) is removed. Workspace layouts keep one mode document.
- Theme preference keeps `system` as the stored default; the toggle sets the explicit opposite
  of the resolved theme; "Follow system" is available in the customisation popover.
- The status strip shows unknown values as a muted icon with an "Unknown" popover, never as 0.

## Risks

- Visual baselines (G13) change for every restyled component; each diff is reviewed and listed
  in the hand-off. Baselines are written only in the pinned Playwright image.
- Many component and browser tests assert removed controls (Refresh sessions, Retry,
  Developer/Visual). They are updated deliberately with assertions for the new behaviour
  (automatic recovery, absence counts), never weakened.
- The legacy ratchets (allowlist, ESLint suppressions) may only shrink; rewritten files must
  not add violations.
- WebGL must never affect input latency; the tier stays off by default and is measured.

## Test matrix

| Property | Evidence |
| --- | --- |
| Palette contrast floors | G3 contrast gate, foundations test, generator report |
| Switch knob centred in both states | ui component test with computed geometry plus browser assertion |
| Icon optical centring in icon buttons | browser assertion on bounding boxes |
| No Retry/Refresh/updated captions in the shell | component tests with explicit counts |
| No re-render of unchanged data | unit test on structural sharing; render-count test |
| Developer/Visual split gone | shell tests assert absence; palette has no mode commands |
| Composer centred then docked | browser test with geometry |
| Max graphics off by default, respects reduced motion | browser test |

## Commands

```bash
export GUANXI_WEB_PORT=5235 GUANXI_API_PORT=4435 GUANXI_DATA_DIR="$PWD/.lane-data"
npm run typecheck && npm run lint:md && npm run check:licenses && npm run lint:js
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run test
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run test:web:browser
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run ui:check:browser
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run build
```
