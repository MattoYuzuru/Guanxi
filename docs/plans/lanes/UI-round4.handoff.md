# UI round 4 hand-off

**Status:** implemented, locally validated (focused component tests, affected browser specs and UI
gates under the shared heavy lock; no hosted CI, no live model) · **Updated:** 2026-10-24 (second review round) ·
**Branch:** `claude/ui-round4` from main `dd079680` · **Source of truth:** owner feedback
2026-10-23 (`Guanxi-lanes/prompts/ui-r4-refs/owner-feedback-2026-10-23.ru.md`, references `1.png`, `2.png`)

## What changed

| Step | Commits | Content |
| --- | --- | --- |
| Round 3 carried in | merges `276740b0` (F2), `c5747d1d` (F1), `9f09b442` | F2's six commits (trace at turn, useId, plan heading, segmented widths, side chat Composer, Models cards) and F1's three commits merged; the manifest conflict was resolved by regenerating it. F1's uncommitted WIP (phone overflow as one labelled column, `VisibleLabels`) was copied, read, finished and committed as `9f09b442`; the F1 clone was not touched |
| A. One session view | `abb2711a`, `05a5e43d` | A chat from the sidebar (`sessionNavigationPath`, kind `chat`) opens `/chat/<id>` or `/projects/<p>/chats/<id>`: the full-width timeline on the native session's geometry, without the legacy chat list or a permanent context column. One borderless **Panels and layout** icon menu in the header (the `1.png` pattern: icon rows, check marks, inline switch) opens side panels (Context, Plan, Artifacts, Browser, Sub-agents, Terminal, Processes, Environment, Changes, Files) as one rounded pane beside the timeline, remembered per browser. `/workspace/...` stays: its toolbar row is gone; the same header menu carries panel visibility, add block, compact density (switch), save scope and named layouts (radio rows), save, save as (name dialog), move and reset. Pane headers are two named icons (move, hide); the chat block has no second header; the Context block shows the real context panel; the "dock lanes" sentence is gone; the built-in layout named "developer" displays as "Default layout". Menu gains `MenuCheckboxItem` and `MenuRadioGroup`/`MenuRadioItem`; the icon registry gains panel and layout glyphs |
| A. Developer/Visual | `a3ea6f69`, docs `25654924` | The last Developer distinction in the UI, the Developer mode switch gating the component catalog (D-137), is removed: Settings has a Design system section with the catalog link; the catalog chunk still loads only on its route. Recorded as superseded by owner feedback 2026-10-23 in COMPONENTS_AND_CATALOG, LAYOUT_AND_SCREENS, REQUIREMENTS F7/F8 and the ADR-0036 status |
| B. Session header | `05a5e43d`, `0a30a5bd` | The title takes only the room left and truncates with an ellipsis; the model is a mono chip that drops its name first (icon only under 520 px, still named); the context is an icon and an emphasised value whose long wording is a design tooltip, and it toggles the Context panel. Actions (panels, chat info, trace, new) are borderless icon buttons with design tooltips. The header sits above the timeline and panels, so an open panel never covers it |
| C. Models | `0a30a5bd` | The drum carousel is replaced by `ModelGrid`: equal, opaque, unscaled cards for installed models and every catalog page, no arrows, dots or roledescription. Fact values use the heading weight and tabular numerals; the fit verdict keeps its colour. The header's hardware facts are icon status items with emphasised values (labels and details in popovers) |
| D. Text diet | `0a30a5bd`, `8e24f781` | A completed answer has no visible status badge, "KV cache" caption or "completed, stop reason" line (announced for screen readers; status, stop reason and cache are in the message details popover); failed, cancelled and empty turns keep their callouts. The context hint is screen-reader text. Popover fact values carry the weight. Unused locale keys removed |
| Review fixes | `abbb4b56`, `5f2e529d`, `146e1c85` | See "Independent verification" |

## Commands and results (all local, this Mac)

Heavy runs used `agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600` with
`GUANXI_WEB_PORT=5281 GUANXI_API_PORT=4381 GUANXI_DATA_DIR=~/.guanxi-lanes/ui-r4-data`; receipts are
under `~/.local/state/agent-dev/<id>/`.

| Command | Head | Result | Receipt |
| --- | --- | --- | --- |
| `npm run test:browser --workspace @guanxi/web -- session-view models-cards workspace unseen-sessions shell-session-search chat-first-stream context-checkpoint project-chat catalog-pagination catalog-variant-install model-evidence flows-axe chat-retention phone-shell` (`.spec.ts` each) | `146e1c85`, clean | 71/71 pass | `check-7wkrf4d0` |
| same runner: `native-agent new-session native-session-timeline side-chat phone-shell controls-geometry shell-palette notifications runtime-bar runtime-health resource-conflict chat-retention chat-terminal-reload chat-failure-gate prewarm hugging-face-discovery add-from-ollama catalog-facets-compare capability-override` | `5f2e529d` | 89/89 pass | `check-0x7kcn9d` |
| same runner: `component-catalog flows-axe shell-mount kernel-slot localization` | `5f2e529d` | 28/28 pass | `check-kvkgcykc` |
| `npm run ui:check:browser` (G1–G17 incl. G13 visual, G14 axe) with `--docker` | `5f2e529d` | pass, exit 0 | `check-6rcx5d8m` |
| `npx --workspace @guanxi/web playwright test context-checkpoint session-view --repeat-each 3` | `146e1c85` working tree = committed | 18/18 | `check-kx5xzitk` |
| `npm exec --workspace @guanxi/web -- vitest run` 20 focused files (session-navigation, workspace-state, turn-projection, context-limits, catalog-pagination, model-card, catalog-capacity, provider-context, localized-copy-inventory, shell-sidebar, shell-unseen, shell-controller, mounted-shell, shell-status, project-chat, chat-streaming, chat-quiet-refresh, context-checkpoint, no-middle-dots, no-retry-copy, no-native-select) | `146e1c85` | 95/95 | local |
| `npm exec --workspace @guanxi/ui -- vitest run` redesign-controls, app-shell-chrome, workspace-state-readiness, components, catalog | `5f2e529d` | 46/46 | local |
| `npm run typecheck --workspace @guanxi/web`, `--workspace @guanxi/ui`, `npm run lint` (js, css, suppressions), `npm run lint:md`, `npm run ui:check` | `146e1c85` | pass (lint:js: the 4 warnings main already has) | local |

Not run: root `npm test`, the full `test:web:browser`, `npm run build`, hosted CI. Once, early in
the slice, the whole web vitest set (76 files, 731/732 then fixed) ran locally, which D-213 does
not ask for. Mutation check observed: pointing `sessionNavigationPath` back at `/workspace` fails 2
of the 4 session-navigation unit cases. The browser assertions fail against main by construction
(main routes chats to `/workspace`, renders the toolbar buttons, the carousel's arrows and scaled
cards, and the visible "completed" caption); that was reasoned, not re-run on main.

## Assertions for the claimed properties

- Sidebar chat lands on the timeline, no workspace, no layout text buttons, no Developer/Visual:
  `session-view.spec.ts` case 1; `session-navigation.test.ts`; `workspace-state.test.tsx` (no
  toolbar, actions through context).
- Header title, model and context never overlap at 360 and 1280 px, the title is ellipsised:
  `session-view.spec.ts` (bounding boxes pairwise and inside the header).
- Header actions are borderless icons with design tooltips, no native `title`: `session-view.spec.ts`.
- Panels menu by keyboard, panels beside the timeline, focus return, header never covered at 1024
  and 800 px, phone sheet with focus inside and an inert page: `session-view.spec.ts`.
- Free arrangement on the menu, hidden session block recoverable: `workspace.spec.ts` (35 cases).
- Models grid: equal, opaque, unscaled cards, several per row at 1440 px, no carousel controls,
  heavier values, three verdict colours: `models-cards.spec.ts` at 1440, 600 and 390 px.
- Completed answers print no status or cache text: `turn-projection.test.tsx`, `chat-first-stream.spec.ts`.
- Menu rows carry `aria-checked`, the drawn switch and check are hidden: `redesign-controls.test.tsx`.

## G13 baselines changed (pinned image, reviewed one by one)

`icon/set-*` (new glyphs), `menu/checkable-*` (new story), `status-item/open-*` (heavier values),
`workspace-chrome/default-*`, `draft-*`, `placeholder-*`, `loading-*` (icon pane actions, no
toolbar row in the skeleton). Components touched: Menu (new rows and story), Icon (glyphs),
WorkspaceChrome (pane header, chromeless, skeleton), Popover (fact weight), and from F1
IconButton, StatusItem and AppShellChrome (labelled overflow). All stay `review`; none is approved.

## Screenshots

`/Users/yuzuru/Projects/Guanxi-lanes/ui-r4/.lane-shots/` (untracked; real lane server, one thread's
messages injected): `r4-{session,layoutMenu,panelsOpen,newSession,models,workspaceMenu}-{desktop,phone}-{light,dark}.png`
(desktop 1440×900, phone 390×844) and `before-{session,chatRoute,workspace,models}-*.png` taken at
the start of the slice. The harness is `.lane-shots/shoot.mjs`.

My reading of them against the feedback: the session is now one calm full-width timeline with
icons in the header; the menu matches `1.png`; Models no longer shrinks or fades cards and its
values read first. Still not what the owner asked: see below.

## Independent verification

`sde-agent:implementation-reviewer` (read-only) reviewed `9f09b442..25654924`: one P1, three P2,
nine P3. Fixed in `abbb4b56`: a session block hidden from its dock tab took the menu away (now a
menu row, and the workspace bar shows the menu whenever the session block is off screen); a
failed Save as left its name for the next Save; a chat open in its free arrangement counted as
unseen; the phone sheet had no focus handling (now focus moves in and the page is inert); P3s
(missing Context block, trigger document on open, storage failure, CSS scoping, fit basis in each
hardware popover, dead key and prop). `5f2e529d` fixed a duplicate row name seen in the
screenshots; `146e1c85` fixed the phone checkpoint focus found by `context-checkpoint.spec.ts`
after the inert change. Not changed: the panel close returns focus to the composer, not the
opener (accepted); the fallback bar can flash while a chat loads inside the free arrangement.

## Second review round (coordinator, 2026-10-24)

An independent review of `dd079680..b3c77813` found no blockers; each should-fix item is its own
commit with a test that failed before the fix (the browser cases ran first against `785896e6`,
receipts `check-rp4h4a3j` and `check-yqqj9h4i`).

| Item | Commit | Test that failed before |
| --- | --- | --- |
| 5 the session re-rendered on every runtime poll | `785896e6` | `shell-runtime-render` "an open chat session (`/chat/<id>`) renders nothing for such a poll" (8 vs 5 renders) |
| 2 arrow keys in the sheet's switcher lost focus | `007dd33f` | `session-view` "arrow keys in the sheet panel switcher keep focus" |
| 1 closing the last sheet panel focused `<body>` | `93f2ebb6` | `session-view` "closing the last panel of a phone sheet returns focus to the composer" |
| 3 the sheet was not modal; 640–719 px overlay uncontained | `1518b51d` | `session-view` "a narrow session's panel is a modal sheet that contains focus" at 390 and 680 px |
| 4 stored panels reopened as a focus-taking sheet | `6cb867dc` | `session-view` "stored panels never reopen as a sheet on a phone…", unit `session-panels` |
| 6 renaming a layout in place was lost | `c2718b66` | `workspace-state` "renames the active layout in place", `workspace.spec` rename dialog |
| 7 model cards used native `title` | `76a71ef6` | `model-card` "explains facts through design popovers" (6 title attributes before) |
| model/context shown twice | `6f7efa85` | `session-view` header case: the model is absent from the header, once in the composer |
| nits | `07b54695` | `provider-context` ('unknown' word, no cache dot at 0 tokens), `session-view` (constant control name), `workspace.spec` (back to the timeline) |

**Decision recorded:** the model is shown once, in the composer footer (D-207); the session header
keeps only the context gauge, which also opens the Context panel. A narrow session (pane under
720 px, measured on the pane) shows panels as a modal full-screen sheet on the document body
(`role=dialog`, `aria-modal`, the app root inert, Tab wrapping, Escape closes, focus returns to
the composer); 720–1023 px keeps the narrower side pane.

Commands at `07b54695` (clean): 32 affected browser specs, 102/102 (`check-62bvqpcx`) and 80/80
(`check-50fayu3m`); 24 focused web vitest files, 128/128; `npm run ui:check`, `npm run lint`,
web typecheck, `lint:md` pass. `ui:check:browser` was not re-run: no `@guanxi/ui` source changed
after `5f2e529d` (only the generated manifest's usage counts).

## Residual risk and what is still not what the owner asked

- The free arrangement's built-in layout still shows all eleven blocks at once; it is no longer the
  default view, but "Arrange panels freely" or the palette's "Session workspace" still opens it.
- Side panels other than Context are honest placeholders ("No terminal service is attached"):
  there is no terminal, browser, artifact or sub-agent service behind them yet.
- The legacy chat page remains: `/chat` without an id is the old create form with its chat list,
  the message view, Context panel and tool cards keep their legacy look and long sentences.
- A new chat with no session events is not in the shell's Sessions list, and the thread view no
  longer has its own chat list; it is reachable from `/chat`.
- Memory shows no value on this Mac because the node reports `availableMemoryBytes: null`
  (server work); the strip does not invent one.
- `embla-carousel-react` is now unused in `packages/web/package.json`; removing it changes the lock.
- Dropping a dragged tab onto the chat card's content shows no drop target (only on its padding);
  this predates round 4 and is not fixed.
- The composer's model readout has no tooltip; a very long model id is truncated there (its full
  name is read by screen readers).
- Axe flags Base UI's focus guards around any open non-modal menu (`aria-hidden-focus`); the new
  axe check scans the menu itself.
- A layout the owner saved earlier in the free arrangement still applies there.
- Owner requests outside this round, unmet: the fleet map (D-209, next), provider models and the
  OpenAI/DeepSeek keys in the picker (D-208), the system prompt, palette approval, Max graphics
  polish, Touch ID, and the new-session screen with a real connection (the lane data dir has none,
  so `r4-newSession-*` shows the "no model connection" state).

## Next

The fleet map (D-209) on StatusItem and Icon: the session's devices as a bounded graph, as the
owner described. Not started.
