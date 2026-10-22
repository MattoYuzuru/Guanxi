# Workspace state composition and three-component readiness proposal

**Status: root-accepted implementation plan,2026-10-22.** Only the explicit scope below is authorized.
Reference source is clean main `f8c65df460c1df9e37cdc5661cf6e730b4032ec5`, observed before
and after this audit in `/Users/yuzuru/Projects/Guanxi`. This follows
`u1-extra-primitives-readiness-20261022.md`; it does not modify or release the frozen
Menu/IconButton/Tooltip author checkout. No source, review status, owner approval/key,
manifest, snapshot or dependency changed. Zero runtime checks were run.

Applied repository AGENTS/WORKFLOW/lanes and guanxi-ui/design requirements. In particular,
the accepted state vocabulary requires loading skeleton geometry, meaningful actionable
empty states, and errors with what failed, source, time, next action and copyable details.
No design requirement is waived here. Runtime remains local Mac/Node26 with root as owner;
later checks use common agent-dev state/heavy lock, assigned isolated ports/data, quiet
source and stop-on-first-failure. No remote, model, provider or owner-data scope is added.

## Observed behavior

`Workspace.tsx:105–131` loads kernel readiness, node account context (unless an account was
supplied), two mode lists concurrently, resolves the layout locally, then reads geometry.
Its catch discards the exception and sets a boolean. `activateDocument():168–197` can fail
persisting activation, resolving compatibility or loading geometry. `save():198–232` can
fail local snapshot/scope construction, layout PUT, geometry PUT after a successful layout
PUT, or winner geometry GET. Both use the same boolean saveError. They discard the actual
exception and use a retry closure. Thus the current UI cannot recover a truthful failing
step, observation timestamp or safe technical summary from that boolean.

Actual request routes are `GET /api/layouts/context`, `GET/PUT /api/layouts` and
`GET/PUT /api/layouts/geometry` (`contract/src/api.ts:122`). `ApiRequestError` exposes HTTP
status and a validated contract code, but no request path. `ApiShapeError` exposes a path
and issues. Generic messages, payload details and Zod issues can contain private values;
they must not be printed into this new disclosure. In particular, the generic current
“node could not complete” title is not established when a local snapshot/resolve step fails.

WorkspaceChrome's current state branch always renders EmptyState, and its pane description
branch does likewise. Loading, load error and save error therefore share the wrong pattern.
The sole real actionable empty-workspace branch (`Workspace.tsx:408`) says “Add a block” but
calls show() on the first existing block. It does not create a block, and becomes a no-op
if the valid layout has zero blocks (`layouts.ts` permits an empty record). A concrete plan
must repair this label/effect mismatch rather than add a decorative button.

The built-in pane copy describes unconnected services/observations, not a fetched empty
collection: Terminal and Browser explicitly say their drafts do not execute/navigate;
Files is not connected, telemetry is unavailable, and the other attached session surfaces
are not yet provided by this shell. The plugin placeholder explains unavailable/safe-mode
content. Plain supporting text is justified for these capability/boundary explanations.
It must not be generalized to a real populated-or-empty artifact/session collection later.

## Existing ErrorState: usable API, readiness still required

`error-state.tsx` is a **draft pattern**, approval null. It already supplies role=alert,
decorative icon, title, machine source, locale-formatted time from required occurredAt,
optional native details/summary, selectable preformatted details, a copy button and a polite
copy-result region. It accepts an action node. Copy uses navigator.clipboard.writeText and
handles rejection with the localized “select the text instead” fallback. Story states are
default, with-details and retrying; their action is a static Button without a retry callback.
The declared retrying state uses Button.loading. Source semantics do not establish actual
clipboard success/failure, action effect, keyboard disclosure, announcement or target/focus
readiness. No dedicated ErrorState tests were found in the scoped UI tests.

The six committed light/dark images (three pattern states) were opened. They show the title,
source/time, disclosure, retry control and expanded details without an obvious defect in
those pixels. This is historical visual inspection only, not high-contrast, forced-colours,
locale, responsive, clipboard or browser verification. Existing generic catalog/axe checks
and root's earlier G13–G16 receipt remain inherited evidence at their actual pin.

## Concrete additive behavior

### Preserve kind=state and existing callers

Keep kind, title, error boolean and action.label/onClick accepted with their current types.
Add optional `loading: boolean`, `failure: { source, observedAt, details }`, and optional
action busy/disabled/loadingLabel fields. Do not replace the public discriminant or require
metadata from previously valid callers. A loading call is exclusive of failure/error/action;
the implementation plan should encode new valid combinations additively, without excluding
the existing old union arm.

Rendering order: explicit loading → local skeleton; error plus failure → one ErrorState;
legacy error without facts → the existing alert/title/action compatibility presentation,
with no fabricated source/time; non-error with a real action → EmptyState; non-error with
no action → plain supporting text. Keep exactly one alert for structured errors (remove the
outer duplicate role). New product call sites always supply complete failure facts. The
legacy fallback preserves public compatibility but does not become evidence of a complete
error pattern; document that limitation and assert it supplies no invented metadata.

Add a minimal optional ErrorState time meaning, e.g. `timeMeaning: 'occurred' | 'observed'`
with the existing meaning as default. Workspace passes observed and a translated “Observed”
time label. Keep occurredAt compatible as the rendering API argument, explicitly document
that observed mode renders a client observation time. Do not describe Date.now() in a client
catch as a server failure timestamp. Existing ErrorState stories keep their deterministic
occurrence-time default, so this additive mode need not alter their six baselines.

### Loading skeleton without a new catalog component

Implement the loading composition locally in WorkspaceChrome and its CSS, using existing
layout, control-height, panel-padding, spacing, border and opaque surface tokens. Reserve
the same workspace extent, wrapping toolbar band and flexing content region used after
hydration; use aria-hidden, noninteractive geometry blocks plus one named loading status
and aria-busy. No fake buttons, percentages, model activity, timers, pulse/shimmer or new
Skeleton API/token infrastructure. Scope shape to what is known before data arrives: the
toolbar structure and remaining content rectangle. A saved Dockview grid, selected mode
list labels and pane arrangement are not yet known; do not draw a fabricated final grid or
claim their pixel-exact geometry is known. If an already loaded workspace is being retried,
keep its known retained content and mark the affected region busy rather than remounting
the engine solely to display a guessed layout.

Use the same existing responsive container rules, not a second layout engine. Browser
assertions should compare the known container/content extent before/after hydration, reserve
control-height for the toolbar, verify no overflow at phone width and verify the skeleton
has no focusable descendants or continuing animations under reduced motion. Toolbar wrapping
can legitimately vary with server-supplied names; report that limitation instead of claiming
zero layout shift for unknown text. This honors known final geometry without inventing it.

### Capture actual failures once, where observed

Replace booleans with in-memory failure records (truthiness preserves guards), captured at
the first observed failing step. A small workspace-local helper may accept a static operation
identifier and request method/ROUTES path around each actual await/local computation.
For the concurrent list GETs, wrap each promise independently; a shared mutable “current
phase” variable would misattribute a rejection. Distinguish kernel-ready, local resolve/
snapshot, layout request, and geometry request. Do not label every failure a node outage.
Retain abort/selection epoch guards so canceled or stale operations never create errors.

Record `observedAt = new Date().toISOString()` once in that catch, not on render or locale
change. Source is the actual static failing operation plus method/contract route when it
was a request; local steps have their own machine operation name. No host URL, query string,
account/project/device/layout identifier or request body is needed. Safe disclosure is an
allowlist of operation, method/path, observation time, recognized error kind, HTTP status
and validated code when available. Unknown facts are explicitly absent/unknown. Never copy
raw error.message, stack, response body, payload.details, schema issue values, layout text,
workspace path or secrets. This is formatting observed diagnostics, not logging private
workspace content. Tests inject sensitive sentinel values and assert they appear nowhere
in rendered or copied details.

Each new failure title describes the operation actually observed. If layout persistence
succeeded and geometry later failed, say that geometry could not be saved/restored; do not
claim the whole layout PUT failed. On retry, guard reentry and expose the busy state. Clear
the record on success or replace it with a new observed record on a new failure; changing
locale must not change the timestamp. Copy feedback must refer to the current details,
not retain “Copied” for a later failure's different text.

Retry must not create another Save-as ID after a known-successful layout PUT followed by a
geometry failure. Retain that operation's response/context in its retry closure and resume
the failed geometry step. For a failed/unconfirmed initial PUT, reuse the operation's stable
document ID and existing conflict/recovery policy; do not invent exactly-once guarantees
after a lost response. Make this small explicit part of host scope rather than blindly
re-running save(true), which currently allocates a new ID. Root should lock this boundary
before coding; no storage/wire changes or transaction redesign are proposed.

### Supporting text and meaningful empty action

Render pane descriptions as a token-styled paragraph inside the existing labelled pane,
before actual children/draft; preserve translated boundary copy and retained Textarea.
Do not give informational text a false alert/live role. Preserve unavailable/safe-mode
counts and wording unless a source-supported correction is separately necessary. Do not add
fake “Enable” callbacks where this shell has no such operation.

For zero visible blocks with existing hidden blocks, show one EmptyState action labelled
“Show {block}” (English/Russian locale key) which reveals a deterministic actual hidden
block through existing show(). Prefer an available built-in block, not an unavailable
plugin placeholder. For a genuinely zero-block document, one action “Add Chat” calls
existing addBlock('guanxi.core/chat') after the known core contribution is ready. The same
action may be used when no hidden block can be meaningfully restored. Assert an actual
visible pane/changed state, not only a click count. Do not introduce a no-op action while
core contributions are still unavailable: that is loading/error, not a ready empty state.
Other future real collections still require their own meaningful creation/attachment action.

## Ownership, evidence and baseline lock

Use a fresh isolated author clone from root's then-approved combined pin. The original
primitive checkout remains frozen for its reviewer. Root assigns a single owner for
WorkspaceChrome/Workspace/messages during this bounded slice, so DSH host/G11 and Menu/
Tooltip author files cannot conflict. Expected owned source is the three folders textarea,
empty-state and error-state; WorkspaceChrome TSX/CSS/docs/stories; Workspace.tsx, its locale
messages and an optional small local safe-failure helper; proportional UI and browser tests/
fixtures; handoff. Public contract routes, persistence schemas, docking adapter, other shell
source, tokens, dependencies, suppressions and central status files are out of scope.

Three-component readiness must be explicit:

| Component | Direct closure needed before any unsigned review |
| --- | --- |
| Textarea | Visible localized Invalid-story message and description ID, native editing/newlines/controlled value, disabled/readOnly boundaries, real focus/resizing/forced colours and regime bounds, as scoped in the prior audit. |
| EmptyState | Exact sentence/action count, hidden decorative icon, real pointer/keyboard action effect, regime/localized bounds; product empty action must restore/add real content. No passive variant is needed for pane descriptions. |
| ErrorState | Exact one alert, real source/time meaning and valid time element, disclosure keyboard state, exact safe clipboard payload and success/rejection status, meaningful Retry effect/busy nonreentry, target/focus/forced colours, locale/narrow-layout overflow. |

Use a fixed browser clock for exact timestamp assertions; separately prove it changes only
after a new failure. Inject failures at each real endpoint/phase and demonstrate source
attribution, including geometry failure after successful save, rejected local snapshot and
aborted/stale load. Existing node-unavailable test only checks alert count/Retry visibility;
extend it to actual recovery rather than credit visibility as Retry behavior. Preserve the
existing DOM/draft-retention, conflict/recovery, mode/density, safe-mode/plugin-placeholder,
keyboard-focus and same-origin popout envelope. New passing tests are not yet authored or
counted by this proposal; report actual new/envelope totals at execution time.

The default intent is **no baseline updates except Textarea Invalid** if its story gains
the required visible error. Existing ErrorState defaults should remain unchanged. There is
however a concrete scope conflict to resolve before implementation: new WorkspaceChrome
loading is a new declared state and guanxi-ui requires its story/captures; changing empty,
placeholder and structured-error story composition may change those existing pixels. Root
must either authorize the precise additional WorkspaceChrome loading images and genuinely
changed empty/placeholder/error images, or explicitly defer the corresponding feature to a
separate slice. Do not evade state coverage, preserve a misleading story just to pass G13,
or pretend only Textarea changed. Do not update unrelated images. All permitted baseline
production uses the pinned Docker producer under root authorization, followed by visual
inspection. Host-run temporary captures may support diagnosis but are never baselines.

Readiness/source fixes require separate red/fix commits where a defect is demonstrated,
then independent reviewer closure. Only afterward may root separately move these three
draft entries to unsigned review; approval remains null. Adding ErrorState introduces a
sixth draft in the prospective Workspace closure until its readiness is actually closed.
Fresh real G11 must prove no draft remains after the composed transitions, while synthetic
draft-child enforcement tests remain discriminating. No promotion merely to green G11.

## Checks, completion and rollback

Author runs changed-source UI/web/fixture types, focused unit/component assertions, bounded
real browser state/clipboard/keyboard/regime controls and scoped lint/Markdown on quiet exact
pins via shared heavy. Root coordinates clipboard browser permissions and deterministic API
fixtures; no live node/provider or owner data is necessary. Do not duplicate full suites in
the author lane. Keep invalid, failure, copy and retry counterexamples in tests; never relax
G11, contrast, timestamp/source, count or snapshot checks to make the change pass.

Root then runs the actual combined eight gates: typecheck, npm test, web browser gate,
UI browser/catalog gate with pinned G13 production/comparison as authorized, build, Markdown/
links, licenses and JS lint. Fast UI must also close existing ratchet/G11 blockers in the
composed source, with sourceHash regeneration through the tool rather than manual fields.
Record actual clean pins, commands, receipts, new/envelope/skip counts and image inspection.
No inherited root result proves this later changed source. Independent review must include
source/time honesty, safe details negative cases, callback effects, API compatibility, three
component readiness, baseline allowlist and unchanged owner approval.

Rollback is focused commits in reverse order: unsigned transitions first, then source/
tests/story/baseline/manifest changes as one consistent slice. Do not undo separately reviewed
Menu/Tooltip/G11 work, owner-signed records, shared data, contract history or existing layout
documents. Residual limits include browser-emulated accessibility/preferences rather than
physical AT, unknown server mutation outcome after a lost response, and unknowable saved
grid geometry before hydration. This proposal closes no U1/MS1/release/owner approval gate.


## Root authorization and execution contract

Root accepts this engineering plan including truthful client observation-time semantics,
per-await source attribution, known-successful layout/geometry retry boundary, stable Save-as
ID for an unconfirmed initial PUT, and truthful Show-hidden/Add-Chat empty actions. These are
reversible corrections within accepted U1 behavior; no new owner product decision is needed.
No exactly-once network or unknown-grid geometry claim is authorized.

Checkout `/Users/yuzuru/Projects/Guanxi-lanes/u1-workspace-states`, branch
`codex/u1-workspace-states`, base union `c01459586fd73663022ac0bcc18778858394c13f` from main4bb2fb90
plus mountedhostae691c23, G1177bf2e0f and primitivea502aed8, merged without manual resolution.
G11 and primitive repairs have independent closure; host's final actual flows4 passes while
its remaining N4/fastUI recheck is finishing separately. Root owns integration, main and
central docs; this union is an author base, not a new validated main checkpoint.

Root authorizes pinned-Docker baseline production/visual inspection ONLY for:

- `packages/ui/catalog/snapshots/textarea/invalid-{light,dark,light-hc,dark-hc}.png`
- `packages/ui/catalog/snapshots/workspace-chrome/{empty,placeholder,error,loading}-{light,dark}.png`

The new loading story is required, and the existing empty story must actually demonstrate
an actionable empty state instead of a pane description. Preserve default/draft/toolbar/
mover/phone and all unrelated baseline bytes. Preserve ErrorState's existing occurred-time
six images; the additive observed label is exercised in real fixture captures. Do not broadly
rename unaffected Textarea story copy. If a necessary source change alters any additional
baseline, report its exact discriminating cause to root before expanding this allowlist.
Author may capture diagnostic browser images but does not produce/accept baselines; root
owns the pinned Docker producer after a clean source handoff, with independent inspection.
No owner key, signature, approved status or approval-field mutation is allowed.

Author owns the three component folders, WorkspaceChrome TSX/CSS/docs/stories, public
ErrorState prop reexports if necessary, workspace-local failure helper/Workspace.tsx and locale
keys, focused unit/component/browser fixtures and tests, generated manifest via its tool,
and this lane handoff. Do not change docking/storage/wire/other shell/G11/deps/suppression/
tokens or prior primitive source. Existing story states/legacy API stay supported. Statuses
remain draft until root separately transitions only after real evidence and independent
closure. The sixth reachable draft ErrorState is intentional pending that closure.

Use Node26.9, own npmci (root first), ports5205/4405/data.lane-data. Runtime owner root on
this Mac; shared `/Users/yuzuru/.local/state/agent-dev` resourceheavy, all checks through
`/Users/yuzuru/.local/bin/agent-dev`, source and runner frozen while queued/running. Read
project AGENTS/NAV/WORKFLOW/lanes, guanxi-ui and five design docs, personalAGENTS and resolved
workstation-dev skill. Relevant frontend/SDE/SRE plugins/skills are available. NoSSH/provider/
model/ownerdata/paid/key/push or central-status edits. Source external skill symlink prevents
portable certification; report actual clean pins/receipts instead.

Commit red assertions before demonstrated source fixes, then proportional actual controls:
three-component readiness, safe failure sentinels/source/time/retry/concurrency and existing
Workspace retention/conflict/popout envelope. Preserve every prior behavioral assertion;
never use blanket ignore/retry/first-match to manufacture green. No fullroot8/browser/catalog
snapshot suite duplication in author lane. Root and a separate GPT6.1Sol/high reviewer own
final source review, original discriminating rechecks, allowed baseline production and union
full gates. Handoff names new/envelope, old/new pins/failures/fixes, unrun checks, exact images
and residual risks. No U1/MS1/stage/release/owner-approval closure is inferred.
