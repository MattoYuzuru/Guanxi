# U1 transitive primitive readiness — bounded plan

**Status:** root-authorized implementation plan · **Updated:** 2026-10-22
**Checkout/base:** standalone `u1-primitive-readiness`, branch
`codex/u1-primitive-readiness`, clean `bfef83cda9bffdcef788a59966833371c5e7e978`.
Root accepted this scope after the outside transitive-readiness audit. This plan is committed
before implementation; it neither promotes components nor closes U1 or MS1.

## Outcome and existing behavior

Add maintainable actual-browser assertions for the existing public Menu, IconButton and
Tooltip, including the separate Tooltip composition in Dialog's default close control.
Reuse the existing Vite/Playwright fixture pattern, public `@guanxi/ui` components, locale
messages and semantic regime attributes. Existing catalog/G13–G16 results at main `1b6f495`
are inherited observations, not substitutes for missing interaction assertions.

The audit found a concrete draft-doc discrepancy: Menu claims disabled items are skipped,
while installed Base UI allows focus on disabled items and prevents activation. Root chooses
to preserve that supported behavior if actual browser observation confirms it, and to correct
the docs explicitly. Inspect accepted requirements for any contrary specific obligation.
Do not impose custom focus behavior to make the old claim appear true.

## Owned changes and exclusions

- Add one small browser fixture and one focused spec under `packages/web/test/browser/`;
  use the existing browser configuration and existing token CSS rather than a second runner.
- Reconcile `packages/ui/src/components/menu/menu.docs.md` after the observation. The three
  primitive directories may change only for a demonstrated defect or necessary evidence.
- Record exact assertions, observations, counts, receipts, residuals and reviewer handoff in
  this lane's handoff. Root owns central status and any later unsigned status transitions.
- No component review/status/approval record, manifest status, snapshots, tokens, suppression,
  dependency, wire/schema, application shell, G11/tooling or other lane source changes.
- No duplicate full npm/browser/catalog run. Root owns later union/full gates and pinned
  snapshot production. No new infrastructure or broad primitive refactor.

## Assertion matrix

| Boundary | Required direct assertions |
| --- | --- |
| Uncontrolled Menu | ArrowDown/ArrowUp/Home/End/typeahead focus path; disabled item can receive focus, is aria-disabled and never activates on Enter/Space or pointer; enabled action exactly once; Escape removes popup and restores trigger focus. |
| IconButton | Accessible name and hidden glyph; enabled pointer/keyboard activation exactly once; disabled activation zero; `pressed` semantics/name persist; real `sm` target at least 24×24; actual pointer-active style differs from rest without inventing toggle state. |
| Tooltip compositions | Pointer and keyboard open through IconButton and Dialog close control; exactly one matching tooltip, matching text and actual accessible relationship; Escape removes tooltip without moving focus or invoking/closing its host control. |
| Forced colors | Actual browser forced-colors media active; focused trigger has a visible system-color outline; highlighted Menu item has distinguishable foreground/background; Tooltip boundary remains visible. |
| Regimes | Light/dark × compact/comfortable × glass/tinted/solid, Russian and pseudo text; actual open Menu/Tooltip remain in a phone viewport, with readable/unclipped content and target geometry; reduced transparency produces opaque floating material. |
| Motion and isolation | Reduced motion enabled; popups settle without remaining spatial motion; fixture dispatch counters expose forbidden activation, and no external/provider request is needed. |

Use observed focus and explicit counts instead of visibility-only proofs. Static controlled
open stories do not prove uncontrolled close/focus return. Existing state screenshots remain
unchanged: the test fixture exposes actual interaction states rather than adding unapproved
baselines. Capture test-run images for bounded visual inspection without accepting snapshots.

## Execution, evidence and failure handling

Local Mac Node26.9.0, root runtime owner, ports `5203/4403`,
`GUANXI_DATA_DIR=$PWD/.lane-data`; own offline install already passed `check-4su4i885` and
contract resolves inside this clone. All commands use workstation-dev, shared
`/Users/yuzuru/.local/state/agent-dev`, `--node 26 --resource heavy --lock-timeout 3600`.
One check per invocation; source is quiet throughout queued/running checks; stop at failure.

1. Commit the fixture/spec, then run the focused new browser file through
   `npm run test:web:browser -- -- <file>` or the workspace's equivalent direct Playwright
   command from `packages/web`. Observe and fix test assumptions separately; production
   changes require an actual demonstrated defect and a separate commit.
2. After the docs reconciliation, run the affected browser file at the final source pin,
   scoped UI/web TypeScript and ESLint, and scoped Markdown. Run fast UI gates only if
   their current mounted draft policy permits meaningful execution; retain any existing
   G11 blocker rather than weakening it. Root owns integration of the independent G11 fix.
3. Inspect captured images for representative regimes and report every uninspected regime
   or platform as a limitation. Never call a high-contrast theme OS forced-colors evidence.
4. Separate newly authored repository cases from inherited envelope and prior catalog
   observations. Retain failed commands with exact pins and causes.
5. Freeze a clean final pin and give root/independent `encoding_review2` the exact diff,
   claimed assertions, receipts and residuals. The author does not independently review it.

No SSH, model/provider, owner data, owner key/signature, push, shared checkout write or global
runtime change. Unsupported external skill symlink prevents reusable source certificates;
report direct pinned outcomes and unchanged source instead.

## Risks, compatibility and rollback

Keyboard/Tooltip timing can expose unsupported test assumptions; wait on actual state instead
of arbitrary sleeps. Portals must inherit the requested regime. Browser-emulated forced colors
does not prove physical screen-reader speech, touch hardware or every platform. The fixture
must use real public wrappers, not duplicated implementations or mocked interaction engines.
No data or public API migration is needed. Roll back this slice by reverting its focused test
and docs commits; keep statuses/approvals and existing snapshots intact. A newly discovered
source defect outside the three primitive folders is reported to root before expansion.
