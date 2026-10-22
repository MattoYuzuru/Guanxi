# U1 Workspace states and three-component readiness handoff

**Status: author implementation complete; independent review and root gates pending.**
Date: 2026-10-22. Checkout: `/Users/yuzuru/Projects/Guanxi-lanes/u1-workspace-states`,
branch `codex/u1-workspace-states`. Accepted scope is the
[locked plan](U1-workspace-states.plan.md), committed before implementation at
`8a001b66d8fc1c456a85f65ea1b0025d2a2d0834`. Its underlying reviewed union is
`c01459586fd73663022ac0bcc18778858394c13f`; this is not a new main validation claim.
The last production/generated-source pin is `7bd4cdc2f62deae1b2e98736ed1581c31591e738`.
The final executable/test pin is `f66e2f38eff5cdaffa5622644d18e095e13c95d0`;
subsequent handoff/plan formatting changes are documentation only.

## Implemented behavior and boundaries

- Textarea Invalid now has an empty value, localized visible required-description message,
  and an explicit label/description relationship. The native Textarea implementation and
  unrelated story copy are unchanged. EmptyState implementation remains unchanged; its
  single meaningful action is asserted through actual pointer and keyboard effects.
- ErrorState preserves its required occurredAt API and default occurrence-time stories.
  Additive timeMeaning selects a localized Observed label when the value is a client
  observation time. Copy feedback is tied to the current details rather than a previous
  failure. Actual browser clipboard success, rejection fallback, keyboard disclosure,
  selectable details and busy Retry non-reentry have direct assertions.
- WorkspaceChrome preserves kind=state/title/error/action callers. Explicit loading has
  one named status, aria-busy, eleven noninteractive toolbar slots and a content rectangle.
  Pane descriptions are supporting paragraphs; actionable empty states use EmptyState;
  structured errors compose exactly one ErrorState. Legacy errors without facts retain
  alert/title/action compatibility and invent no source or time.
- Workspace records the first observed failing step around each actual await/local
  computation, including each concurrent list request separately. Disclosures contain only
  static operation/contract-route facts, one client observation time, classified error kind
  and typed HTTP status/code. Raw error text, payload, issues, private IDs and paths are not
  rendered or copied. Sensitive-sentinel tests cover these boundaries. Aborted/stale loads
  do not replace newer content or create errors; pending retries retain their busy control.
- Save retry retains one document ID for an unconfirmed initial PUT. After a known-successful
  layout PUT, a failed geometry step resumes geometry rather than repeating the PUT.
  Acknowledged winner/activation responses are applied once across geometry retry, preserving
  retained edits and recovery rows. This does not promise exactly-once processing after an
  unobserved network response.
- A workspace with hidden available core blocks offers Show with the actual block name.
  A truly empty document offers Add Chat through the existing addBlock path once core is
  ready; unavailable core is loading, not a fabricated ready empty action.

Generated catalog metadata was rebuilt with the existing tool: source hashes, additive
ErrorState prop, loading state/story and actual CSS variable inventory changed. No lifecycle,
owner approval, signature, usage evidence or snapshot hash was edited. No baseline PNG,
prior Menu/Tooltip/IconButton source, G11/tooling, docking/storage/wire, dependency, token,
suppression or central status file changed. EmptyState is tested without a source repair.

## New assertions and inherited envelope

There are **55 new repository cases** and **42 inherited cases** exercised across the pins
below. This is a union of distinct cases, not a single final 97-case invocation. Repeated
selections, visual cells, captures and gate seeds add no new case credit.

| Cohort | New | Inherited | Actual successful evidence |
| --- | ---: | ---: | --- |
| UI readiness plus existing input/components/catalog | 6 | 19 | 25/25, check-6l161nzt at e0e3e9ae; final readiness 6/6 check-6ah9pk21 at ac14306f |
| Safe-failure unit and actual Workspace component boundaries | 7 | 0 | 7/7, check-ez3qn40g at dcf4b81b |
| Native fields, empty/error controls, clipboard, resize, forced colors and localized regimes | 30 | 0 | 30/30, check-e23weruh at e1e7afc0; stronger matrix 24/24 check-20af848s at 7117da40; stronger forced-color case 1/1 check-rm4xc8of at f66e2f38 |
| Workspace real browser failure/retry/loading/empty behavior and existing host flows | 12 | 23 | 34/34 (11 new + 23 inherited), check-avt2iwvz at e0e3e9ae; added activation recovery 1/1 check-ri8ijp73 at c60e6f37; final loading 2/2 check-sbypkwv4 at 7bd4cdc2 |

The 24 regime cases each exercise Russian and pseudo localization: 48 cells across four
light/dark/high-contrast themes, two densities and three materials at 320px. They assert
bounds, each field/action target, names, font density, no running animation, no backdrop
filter under reduced transparency, and no serious/critical axe violation. They do not prove
all arbitrary prop combinations. Browser controls also exercise 390px manual resize,
multiline controlled/uncontrolled editing, disabled/readonly behavior and emulated forced
colors. The latter directly checks outline width/style and at least 3:1 contrast using the
actual composited system color and opaque surface, not only a screenshot or nonzero width.

The 12 host cases include four distinct failing endpoint/mode boundaries, desktop and phone
loading, winner geometry, activation geometry/recovery, acknowledged Save-as geometry,
unconfirmed Save-as ID stability, hidden-block reveal and true-zero-block creation. Existing
23 cases retain movement, input/DOM retention, scopes/conflicts, float/popout, locale/focus,
plugins/safe mode, reset, geometry and chat placement assertions. The final file now contains
35 cases; a single final 35-case run was not performed. Production changes after its 34-case
run were the separately tested activation guard, coherent Invalid story, and decorative
loading label typography; no unrelated host flow source changed.

## Types, static controls and execution envelope

All listed author checks used local Mac Node26 through `/Users/yuzuru/.local/bin/agent-dev`,
resource heavy with shared state `/Users/yuzuru/.local/state/agent-dev`, quiet source before
and after, and stop-on-first-failure. Browser ports were 5205/4405 with checkout-local
.lane-data. Own npm ci is root receipt check-z2yiultz. No remote/provider/model/owner-data
access was used. Receipts live under that state directory, e.g.
`check-rm4xc8of/result.json` and its exact `output.log`.

| Check | Successful receipt and pin |
| --- | --- |
| Web production TypeScript | check-dq8i70_w at c60e6f37; later production edits are UI-only |
| UI TypeScript | check-l9yuxn4w at e0e3e9ae; subsequent new test/source imports also covered by final strict cohort |
| Explicit strict new browser fixture/spec, Workspace component test and UI readiness test | check-o3umx6pn at f66e2f38 |
| Scoped ESLint of all changed TS/TSX/CSS source/tests | check-t0wsdzqj at f66e2f38 |
| Scoped G4/G5/G6/G7/G10/G15 plus their G17 seeds | check-wb9lw4l1 at 7bd4cdc2, all selected gates/seeds pass |

These selected gates are not a full ui:check. G11's six reachable draft components remain
pending separate unsigned review dispositions. No gate or seed implementation was changed.
Agent-dev reports clean unchanged source, but source_verifiable=false because the inherited
.claude/skills/guanxi-ui symlink is external. These are actual local outcomes at named pins,
not reusable portable certification. Test counts above come from runner output, not the
wrapper's generic report_patterns=[] zero report count.

An exploratory broader strict browser-test type invocation (check-jumraan_) exposed six
inherited diagnostics: three URL-or-Request accesses in chat-api.ts and three Vite absolute
imports in the old Workspace tests. Four new Testing Library option diagnostics were fixed
separately in a63b1ec6; the explicit new-file strict cohort passes. Do not describe the broader
browser-test type invocation as green. Production web typecheck passes; unrelated legacy
browser typing is unchanged and remains outside this slice.

## Red evidence and corrections

| Pin / failed receipt | Observation | Separate correction |
| --- | --- | --- |
| 70ff4867 / check-zibjsw6c, 0/6 | Missing Invalid message, no loading status, state/description misuse, missing observed label | 3ac9a049 UI composition repair; readiness 6/6 check-mt_0ryks |
| 284f370e / check-u2hgou94 | Actual Workspace failure lacked structured ErrorState | d8b6e364 safe per-step failures/retry; 2c29e810 retained retry/unavailable-core guard; 9/9 check-j1c9sqtq |
| d8b6e364 / check-ztso6sqi | Incorrect relative locator selected zero alerts after actual facts succeeded | 2c29e810 exact scoped descendant; no expectation weakened |
| cb71e43a / check-bz4tt37s, 6 pass then 1 fail | Compact typography test assumed 12px, accepted token is 13px | e1e7afc0 test correction; 30/30 |
| a2baf61b / check-yp9lbqrn, 6/7 | Broad fake timers collided with readonly test requestAnimationFrame | dcf4b81b fakes Date only; 7/7 |
| e30a1b68 / check-qpsjnfpn | Loading reserved 8 slots while loaded toolbar has 11 controls | 1f7ed798 known-control skeleton repair |
| 1f7ed798 / check-f_yi6n1f | Exact toolbar height assumed unknown saved density/text wrapping | e0e3e9ae limits assertions to known slots/minima/desktop extent and phone bounds; 34/34 |
| d3d91e90 / check-27ei605y | Geometry retry duplicated an acknowledged activation recovery row | c60e6f37 applies the acknowledged response once; 1/1 |
| 7117da40 / check-q20esh50 | G6 rejects token-only multiplication in skeleton label height | 1cc6d0fb uses normal token typography |
| 1cc6d0fb / check-rnridn3d | G15 sees entity letters in decorative whitespace | 7bd4cdc2 uses a real NBSP expression; six selected gates/seeds green |
| 4b521a68 / check-n9lgcoet | Contrast helper incorrectly required opaque system foreground; actual focus is translucent rgba | f66e2f38 composites observed alpha over asserted opaque surface; same 1/1 case green |

No blanket retries, ignored failures, timeout increases, weakened exit expectations or
snapshot updates were used. The Invalid story coherence correction ac14306f and every-action
target correction 7117da40 are separate visible commits; repeated selections are not new cases.

## Images inspected and root baseline lock

Actual author diagnostic captures are outside the checkout:
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/u1-workspace-states-e1e7afc0/` contains 48 localized
regime captures plus textarea-resize.png, forced-textarea.png and forced-error.png. Eight
contact sheets in that directory cover all 48 cells; all were opened, with an original
pseudo-light-compact-glass image opened to disambiguate viewer scaling. No actual clipping,
invisible meaningful text or focus defect was observed. Contact-sheet assembly used the
existing local browser, check-2fdfjmxw, and is diagnostic preparation rather than test credit.
The actual source for Textarea, EmptyState and ErrorState is unchanged since these captures.

`/Users/yuzuru/Projects/Guanxi-lanes/reviews/u1-workspace-states-e0e3e9ae/` preserves the host
run's seven captures. The three newly inspected images are loading-390.png, loading-1600.png
and actual-layout-context-error.png. Four inherited captures were preserved, not newly
claimed as inspected. Final loading typography has a later passing 2-case control at7bd;
final pinned catalog production and inspection remain root-owned.

Exactly 12 catalog images are authorized for root's pinned Docker producer:

- `packages/ui/catalog/snapshots/textarea/invalid-{light,dark,light-hc,dark-hc}.png` (4).
- `packages/ui/catalog/snapshots/workspace-chrome/{empty,placeholder,error,loading}-{light,dark}.png` (8).

No author baseline production occurred. Preserve the six existing ErrorState occurrence-time
images, Workspace default/draft/toolbar/mover/phone and every unrelated snapshot byte.
Any additional necessary baseline change requires root's exact cause review first.

## Pending independent work and residual risk

Independent source review and discriminating controls belong to the separately assigned
reviewer. Root owns allowed Docker baseline production/inspection, current catalog visual
and accessibility gates, combined fast UI, full browser and full eight repository gates.
None of those full gates or unsigned component transitions is claimed by this author.
All six reachable drafts remain draft, owner approval remains null, and U1/MS1/stages remain
open. Central status and next-agent prompt are root-owned in this parallel lane.

No physical screen reader, hardware input/IME, additional browser engine or live provider
was used. Forced colors and phone sizing are Chromium emulations. Unknown saved grid,
server labels, density, wrapping and phone content height cannot be reserved pixel-exactly
before load; the implemented skeleton reserves only known structure and space. Legacy
error-without-facts callers retain compatibility but do not establish complete provenance.
Lost initial responses retain stable IDs and the existing conflict policy, without an
exactly-once claim. There are no storage/schema changes. Rollback is the owned source/test/
manifest delta relative to8a001b66; preserve root's plan, inherited reviewed union and all
baseline/status/approval records. Source, tests and runner remain quiet for independent
review after the final handoff commit.
