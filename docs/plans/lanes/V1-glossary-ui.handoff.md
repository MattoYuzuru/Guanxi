# V1 glossary editor UI handoff

**Status:** candidate on `codex/v1-glossary-editor-ui`; built, independently reviewed, review findings fixed. Not
merged, no owner approval. **Date:** 2026-10-23 · **Base:** `64d02458`, then main `449226d3` (notification center)
merged (conflicts only in `router.tsx`, `locale.ts`, `LAYOUT_AND_SCREENS.md` and the generated catalog manifest; both
sides kept). Checkout `/Users/yuzuru/Projects/Guanxi-lanes/v1ui`, ports 5220/4420, Node 26, shared `agent-dev` heavy lock.

## What is built

The voice glossary editor at `/settings/voice/glossary` (`packages/web/src/features/voice`), reached from a Settings
section and from the command palette; the sidebar keeps Settings current. No server change.

- Account-wide and per-project entries, grouped (account first, then projects by name). View filter: everything the
  account owns, or one project (account plus that project, the node's rule), with an inactive switch.
- Create and edit: canonical term, spoken forms (one per line), language, case flag, Russian-ending flag. Validation
  uses the contract schema, so limits cannot drift. Help text shows the D-157 example (`PR-а`) in both locales.
- Deactivate, reactivate, one-click revert (the control's description says what it does; a first revision says that
  reverting deactivates), and a newest-first history that refreshes when the entry's revision moves and lists the
  changed fields.
- Live preview on `apply-preview`: debounced, cancelled, highlighted replacements (offsets mapped and verified
  against the returned text), replacement list, glossary revision hash, entry count, source and age. A result is
  marked stale, and its count is not announced, while text, scope or glossary changed since it was computed.
- `glossary_invalid` and every other node code map to code-free locale messages: no term is ever echoed.
- States: loading skeleton, empty (one sentence, one action), error (source, time, code, Retry), `node_unreachable`
  (last data with age, every network action disabled with a reason), degraded (project list unavailable).
- Keyboard and focus: focus into the form on open, back to the trigger on cancel, to the saved card or the same
  control after a change, to the alert on failure. One persistent polite status node for outcomes and one for the
  preview count. `wrap-anywhere` keeps machine names inside the page at 320 px.
- No new `@guanxi/ui` component, no suppression added. Draft Badge, Checkbox and ProvenanceLabel are not used
  (G11); local `Tag`, `ToggleButton` (reviewed Button, `aria-pressed`) and `Provenance` are feature-internal.

## Gates

| Gate | Result |
| --- | --- |
| typecheck, `npm run lint` (suppression file unchanged), lint:md, check:licenses, `ui:check` | pass |
| `npm test` (`check-7zk_wjor`) | pass: core 2677, web 649 in 59 files, ui 49, kernel, codemods, gates, bench |
| `npm run test:web:browser` | pass 224/224, 4.2 min (`check-6d5pdk3h`; 9 of them new) |
| `npm run ui:check:browser` | pass (`check-zp3js_z3`) |
| `npm run build` | pass (`check-2t4se1m6`) |

## New / regression envelope

- **New:** web component 60 (`voice-glossary.test.tsx`), unit 21 (`voice-glossary-model.test.ts`), browser 9
  (`voice-glossary.spec.ts`); fixtures `test/fixtures/glossary-node.ts` (stateful stand-in node) and
  `test/browser/fixtures/glossary-api.ts`. Mutation spot checks (each turned a named test red): cancel without focus
  return, an echoed term, preview offsets ignoring length change, wrong first-revision hint, no preview refresh after
  a change; removing `wrap-anywhere` fails the 320 px / 200% spec.
- **Envelope:** the full suites above; existing shell, settings, localization and copy-inventory tests ran unchanged.

## Independent review (separate commit `ba05be1e`)

`frontend-agent:accessibility-reviewer`, read-only. No P1. Fixed: preview shown for another scope or glossary
(P2); live region claims unproven and aria-busy suppression (P2); "200% text" test did not scale the px type tokens,
now scaled for real (P2; it exposed an overflow, fixed); brand literals in messages (P2); mutation answer merged into
a changed view and old read snapshots overwriting patches (P2); lingering focus request, lost form draft on view
switch, silent Save, "missing from the list" claim made too early, `glossary_invalid` wording for reactivate and
revert (the mock now also answers 422 there), a write with no answer now names the offline state, a body-less 5xx is
`node_unreachable`, heading levels, inactive Edit description, Russian wording. Not changed: Preview and History stay
enabled offline (they fail visibly), `useProjectChoices` casts the project list like the new-session screen.

## Shared edits (merge-sensitive)

`packages/web/src/lib/router.tsx` (route and path), `App.tsx` (route), `lib/locale.ts` (import and two spreads),
`features/shell/MountedShell.tsx` (breadcrumb), `features/shell/useShellController.ts` (palette entry),
`features/settings/SettingsPage.tsx` (one section), `packages/ui/catalog/manifest.json` (regenerated; regenerate
again after merging), `docs/design/LAYOUT_AND_SCREENS.md` §7, `packages/server/src/voice/README.md` (one sentence).

## Residual risk and missing API pieces

- No search, paging or bulk operations for entries (the node has none); no import, export or learned-candidate
  review (V2); no project-page entry point (P1 Projects); no STT backend or biasing UI.
- Project names come from `GET /api/agent/projects` (native projects); the glossary route accepts any id, so a
  legacy-project id would show as an unknown project. A glossary-aware project list would remove the guess.
- The "overridden in this project" mark is derived on the client from the node's documented rule.
- The mock node is not the production matcher or store: replacement is whole-word with the D-157 shape, the
  `glossary_invalid` rule is a simplified collision check, the hash is its own SHA-256. Real-store behaviour is
  covered by the server's `ms2-glossary-routes` tests, not by these specs.
- Chromium only; no physical assistive technology; the glossary form saving state is not axe-scanned.
- Pre-existing, outside this lane: at 320 px with truly doubled type tokens the shell's runtime details panel
  (Host telemetry list) overflows the route host. Earlier specs scale only the root font size, which hides it.
- Owner signatures for the review components used remain pending; nothing here is `approved`.

## Next

Integrator merges, regenerates the manifest, re-runs the gates and folds this file into `PHASE_STATUS.md`. A
follow-up could add the project-page entry point and, with a node API, entry search.
