# U1 integration handoff

**Status:** integrated candidate; all eight local gates pass at the pinned source. Not merged to
`main`, no owner approval, U1/MS1 exits remain open.
**Date:** 2026-10-22/23 · **Checkout:** `/Users/yuzuru/Projects/Guanxi-lanes/u1-workspace-states`,
branch `codex/u1-workspace-states` · **Last source/test commit:**
`0bedb6a1c2935f6b288b16d9c0cffc265e8b2d08` (this handoff is docs only on top of it).
Runtime: local Mac, Node 26.9.0, ports 5205/4405, checkout `.lane-data`, shared
`agent-dev` heavy lock, state `/Users/yuzuru/.local/state/agent-dev`.

## What is on the branch

Base `1776389c` (reviewed workspace states, 97 cases) plus, in order:

1. `e5b0a900` test(ui): the 12 pinned baselines (Textarea invalid x4; WorkspaceChrome
   empty/placeholder/error modified x2 each, loading new x2). `npm run ui:snapshots` runs G13 inside
   `mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e...` (pinned in
   `packages/ui/gates/catalog/browser/gates.ts`); the image was already local. The interrupted
   uncommitted PNGs were discarded and regenerated: byte-identical to them, only these 12 files
   changed, and a second G13 comparison run passed (`check-xtj0m724` produce, `check-bim3vc9u`
   compare). Opened loading-light, error-dark, empty-light, textarea invalid-dark-hc: skeleton,
   error with source and observed time, empty with one action and invalid description all render.
2. `fbc89119` chore(ui): manifest regenerated; only those snapshot hashes changed.
3. `017b4906` docs(ui): unsigned `draft` to `review` for six components, approval null, no key,
   signature or `approved`: Textarea, EmptyState, ErrorState (workspace-state review, no findings)
   and IconButton, Menu, Tooltip (primitive-readiness review, P2 fixed and rechecked). Manifest
   regenerated. Still draft, not reachable from product code, no evidence: Badge, Checkbox, Popover,
   ProvenanceLabel, Select, StatusPill, Switch, Tabs, Toast.
4. `3f5404f6` merge of `codex/u1-glossary` `cb6a191c` (no conflicts); `c44e4e99` merge of main
   `069eeb24` (no conflicts, no `package.json` change, no lock regeneration needed).
5. `15edfe64` test(ui): red then green, see below.
6. `b350d6e8` fix(web) and `0bedb6a1` test(web): browser gate repairs, see below.

## Gates

| Gate | Result | Receipt |
| --- | --- | --- |
| typecheck, lint:md, check:licenses, ui:check | pass (0 md errors, 675 packages, 0 not allowed, G1-G12 and G15) | direct runs, repeated after fixes |
| `npm test` at `0bedb6a1` | pass: codemods 6, gates 102, core 1633 (2 Linux-only skips), kernel 107, web 370 in 45 files, ui 91 + vitest 49 in 7 files, bench 137 | `check-terr51yy` |
| `npm run test:web:browser` | pass 172/172, 3.0 min, after repairs at `0bedb6a1` | `check-yqz86nsk` |
| `npm run ui:check:browser` | pass: G13, G14, G15-clipping, G16 and their G17 seeds | `check-nid7f2pv` |
| `npm run build` | pass | `check-flxgz7wo` |

The `agent-dev` log masks the digit 1 inside numbers (for example `[REDACTED]633`); counts above
are reconstructed from those lines. Receipts report `source_verifiable=false` because of the
inherited external `.claude/skills/guanxi-ui` symlink: direct pinned observations, not certificates.
The browser total was 163/172 before the repairs, at an earlier pin; the final run is the full 172.

## Reds and their corrections (none weakened, no skips)

- `npm test` `check-04wgwbdb`: X1 `indexing/service.test.ts` timed out in a 20 s fixture wait while
  the machine load average was about 11 (another lane's Playwright ran outside the lock). It passes
  alone in 2.7 s (`check-tool706_`) and in every later full run. Treated as load, not a regression;
  no timeout was changed. The test is outside this lane.
- `npm test` `check-d2h_gibh`: five catalog-gate tests asserted that the real checkout still has the
  drafts that item 3 promoted. `15edfe64` overlays draft records in scratch fixtures
  (`mounted-shell-drafts`, and the `transitive-helper-alias` seed, the technique of `0d58cde7`), so
  the same assertions (three drafts named at `MountedShell.tsx`, reviewed-wrapper warning, seed
  fails for the right reason) hold independent of the real records. The real checkout now asserts
  every fast gate passes and the closure stays attributed at its recorded statuses. `ui:test` 49/49.
- `test:web:browser` `check-t7p1h_6b`, 9 failures. The same 9 fail at the assembled union
  `c0145958` (before this lane) and pass on main `069eeb24` (bisect clone, outside Git). The product
  shell mount handoff had flagged that the full browser gate was never run on it.
  - 7 cases (chat-retention x2, project-chat, quick-runs, prewarm, model-evidence, capability-override):
    at 390 px and 200% text the document was 459 px wide. The old `<main>` was `overflow-y-auto`
    and scrolled that content in place; the shell's phone flow scrolls the document. `b350d6e8` makes
    the MountedShell content wrapper `min-w-0 overflow-x-auto`. The shell primitive is untouched.
  - recipes: the no-run-action regex matched `run` in the new runtime retry button. `0bedb6a1` now
    excludes only `runtime`; a real Run or Execute button still fails it.
  - connections: the stacked phone navigation pushes the section below the fold after resize.
    `0bedb6a1` scrolls it into view and keeps the in-viewport and no-overflow assertions, adding a
    check that the section box lies inside 390 px.

## New / regression envelope

- New in this integration: 1 repository case (G11 recorded-closure attribution) plus the
  `mounted-shell-drafts` fixture; one case rewritten onto a scratch overlay; two cases adapted.
  Baselines are not cases. No new cases for the 12 PNGs beyond the existing G13 matrix.
- Inherited, unchanged credit: workspace states 55 new + 42 inherited (review `97/97`), glossary
  1 new component case plus an extended search case (14/14 in its lane), U1 shell and primitive
  readiness cases. Full-gate totals above are the regression envelope, not new credit.

## Lifecycle disposition

`review` is warning-level for slices and blocks a release or stage exit (D-138). G11 now lists
the reviewed closure (button, app-shell-chrome, icon-button, menu, tooltip, dialog, input,
workspace-chrome, textarea, empty-state, error-state) as warnings. Nothing is `approved`; the
owner's signed approval (DS2, Secure Enclave) is required for each.

## Residual risk

- Owner signatures for all `review` components; U1, MS1 and stage exits stay open.
- Not built here: new-session screen, finished-unseen state, ephemeral side chat (the browser
  and component evidence for side chat and glossary term rendering counts remains separate).
- CSS suppressions and legacy 200%-zoom reflow remain: legacy headers still scroll inside the
  host area at phone width and large text, as on main; the shell phone flow stacks the full
  sidebar above route content (user scrolls past it), which is a product decision for the owner.
- Chromium only; forced colors and phone sizes are emulations; no physical assistive technology.
- The X1 indexing test has a fixed 20 s wait and is load-sensitive.

## Next

The integrator merges this branch into `main` (no `package.json` change), reruns gates on `main`,
and folds this file into `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md`. The bisect clone was
removed after use.
