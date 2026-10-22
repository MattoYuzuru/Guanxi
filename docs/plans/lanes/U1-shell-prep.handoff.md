# U1 shell controls and palette preparation

**Status:** prepared and locally checked in bounded scopes; host composition is not mounted in
`App.tsx`. Independent acceptance, integrated browser/full gates and the remaining U1-b/c
implementation remain open. **Date:** 2026-10-22 · **Branch:** `codex/u1-shell`.

## Behavior prepared

- A sidebar composition retains the four core routes even as a rail, plugin contributions,
  pinned session references, date groups, truthful loading/error/omission/empty states and
  explicit load-more pagination. It stores no session titles or transcripts. Pins beyond the
  currently loaded pages are named as such rather than misrepresented as deleted.
- The palette uses public Dialog/Input/Button, with localized search, a named combobox/list,
  keyboard selection that skips unavailable actions, visible reasons, a quiet result count,
  Escape/focus return and exactly one selected action. Core and legacy routes remain in its
  command controller; actual model names load only after the palette first opens.
- Sessions use the independently reviewed paged metadata and explicit navigation projection
  (`86f1019`); native/chat/Project destinations are never inferred from kind or display IDs.
  Pagination has no client item ceiling, rejects a nonadvancing cursor, cancels superseded
  requests and preserves loaded rows/cursor on next-page failure.
- The status composition includes location, validated experience-mode actions, observed local
  machine profile source/time/confidence, and explicit unknown quota/keep-awake/power/inbox.
  It invents neither counts nor provider implementation details. Stored session run state is
  labelled with its recorded observation rather than described as live process status.
- A presentation-only workspace store publishes mode, readiness, busy/phone state and block
  references. Commands validate the current document and avoid importing the docking engine
  into the palette or app. Hidden/phone block moves have an explanation and are unavailable.
- Reveal commands activate inactive tabs before focusing; an explicit pane-attached callback
  handles retained hosts after hidden-pane restoration. Cancellable focus intents prevent an
  older Hide focus return from overriding a later Reveal. Hosts already under their parent
  are not detached and reattached during a rerender.

These feature compositions are **unmounted preparation**, not a replacement navigation flow.
`AppShellChrome` is not imported or used. Root owns its separate draft readiness/phone fix and
pinned baseline work. No component approval, suppressions or central tracker changes were made.

## Verification so far

- Final focused web component/unit check: **32/32**, zero skips (`check-dmgr7zjl`), split
  **17 new / 15 inherited** (13 localization and two SidebarSlot cases): >200 paged
  sessions with exact order/no duplicates, navigation races/unmount cancellation, retry and
  cursor stability, four core rail links, pin grouping, unknown/error presentation,
  unavailable keyboard actions, search reset, preference corruption/storage failure and
  engine-free command dispatch, explicit fetch failure/retry, observed/stale provenance and
  unknown status without invented counts. The initial 14-case check (`check-ipmohvnu`) is
  retained as earlier evidence, not added again to the final case count.
- Final all-workspace types passed (`check-lkboik0g`) after the pane-attached focus addition
  and final status/controller assertions.
- New focused actual Chromium cases: **4/4**, zero skips (`check-wgdlugii`): modal focus trap,
  initial/reopen input focus, Escape/corner-close return, disabled-action skipping, single
  action, zero serious/critical axe findings after transitions settle, 320px Russian named
  control bounds, and desktop/phone Reveal/Hide/Reveal focus with exact single placement and
  zero invalid/implicit layout writes. These are fixtures; no model or owner data is used.
- The broader affected actual Chromium check passed **25/25**, zero skips
  (`check-04ccvu4z`): **4 new / 21 inherited** workspace cases, preserving existing layout,
  movement, popout, scope and mode coverage.
- Dialog/Input's ten catalog stories passed scoped G14/G15/G16 (`check-2ls4k4uy`); these
  catalog checks are separate from feature acceptance and owner approval.
- Scoped ESLint passed for the shell, workspace facade, locale and affected tests
  (`check-gk_64woj`), without adding suppressions.
- Earlier red browser runs remain diagnostic history, not flakes: they exposed inactive and
  newly attached pane timing, older Hide focus return, and a synchronous focus-guard check.
  Assertions still require actual focus and exact counts. Axe checks await finite enter
  transitions, matching the catalog harness, rather than measuring a partially faded frame.

`check-*` paths are under `/Users/yuzuru/.local/state/agent-dev`. Each command used the shared
`heavy` resource and Node 26 with unchanged source for that run. The external
`.claude/skills/guanxi-ui` symlink makes runner source certificates non-reusable; evidence is
local, scoped observation. Full gates are not implied by these targeted commands.

## Dialog/Input prerequisite

The fast gate initially caught new `font-semibold` uses (now corrected to `font-heading`),
stale manifest usage and draft Dialog/Input product imports. Root authorized an actual
unsigned draft-to-review readiness review under COMPONENTS_AND_CATALOG §4; no approval is
inferred. Review report:
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-dialog-input-readiness-20261022.md`.

The Input invalid story lacked a visible linked error. Separate fix `7479d96` adds localized
EN/RU copy and the association, with **2 new assertions / 0 inherited** passing in
`check-bo9nmzq8`. Root independently reviewed that three-file fix with no blocker and owns
pinned Docker regeneration of the four invalid-theme PNGs in a separate readiness checkout.
Primitive implementations, review records and approval/keychain state are unchanged here.
Review statuses/manifests/snapshots must not be edited concurrently with that root-owned work.
Product use of review components remains a warning; owner approval still gates whole-stage exit.

## Remaining implementation and acceptance

Root's shell geometry component must finish readiness before integration, then browser-test hidden/
rail/moved navigation and the palette/controller across real product routes; avoid duplicate
plugin entries when moving the slot out of the legacy chat sidebar. Preserve lazy catalog and
engine boundaries. The separate complete-search continuation is described in
[U1-search.handoff.md](U1-search.handoff.md); its independent review and mounted acceptance
remain open before claiming all-session search in the product.
Finished-unseen state, full new-session flow, ephemeral side chat with explicit idempotent
Save/Send ownership, reviewed glossary/browser-count integration, other U1-c migrations and zero
suppression exit remain unfinished. No scope is closed by this preparation.
