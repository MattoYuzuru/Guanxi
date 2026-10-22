# U1 mounted product shell — bounded implementation plan

**Status:** root-authorized engineering slice · **Updated:** 2026-10-22
**Base:** `f2ffcd0cc5b8733aebd8a93597606527d2d3415b`
**Branch:** `codex/u1-shell-mount`; standalone clone, dependencies installed locally.

## Outcome and accepted scope

Mount the prepared shell on actual product routes, using public `AppShellChrome`, existing
ShellSidebar, ShellStatus, ShellPalette and useShellController. ROADMAP U1, REQ-F3/F6/F7 and
D-131 supply the target; no new architecture or owner approval is inferred. This finishes
host composition only. Full new-session design, finished-unseen, ephemeral side chat,
remaining literal CSS, signed approvals and U1/MS1 exits remain separate work.

The current public components are unsigned `review`, not draft. Under
COMPONENTS_AND_CATALOG section4 their ordinary product use is a handoff warning; stage/release
exit remains blocked. Do not change any review record, signature, primitive source or catalog
snapshot to mount this shell. No owner key or confirmation is needed for this reversible slice.

## Boundaries and ownership

- Own App.tsx, a small host under features/shell if useful, minimal ChatPage SidebarSlot
  ownership changes, locale keys, and proportionate mounted tests. Preserve existing routes,
  URL parameters, health Retry, runtime ownership and ErrorBoundaries.
- Read the actual current interfaces rather than introducing parallel controllers. One
  RuntimeProvider owns one polling loop; useRuntimeProjection supplies sampled facts.
  Keep the workspace and developer catalog lazy. No server, wire or DB changes.
- AppShellChrome already owns the main landmark. Avoid nested main landmarks. Moving,
  collapsing or hiding navigation must preserve mounted route state. Exactly one host owns
  SidebarSlot; ChatPage keeps its independent conversation list.
- Four fixed navigation entries remain present. Other existing routes remain reachable via
  the existing palette. Preserve accessible theme, language/settings and runtime Retry paths.
  Do not retain a duplicate legacy TopBar merely to satisfy obsolete selectors.
- Preferences retain existing keys/meaning. Corrupt or denied storage cannot prevent startup.
  No new token, raw colour/duration, suppression allowance or hardcoded user-facing copy.

## Observable acceptance

1. Actual App routes mount the shell after health succeeds, including chat, workspace and a
   non-chat route. Each core navigation action changes location exactly once. A contributed
   sidebar entry occurs exactly once; route-owned content and subscriptions are not duplicated.
2. Move/rail/hide/show keep route content and its in-flight state mounted. Stored geometry
   survives reload; corrupt/denied storage degrades safely. Keyboard/palette can reveal hidden
   navigation and restore focus. Ctrl/Meta+K has one effective handler and one executed action.
3. Use the existing complete metadata-search behavior, late-response cancellation, explicit
   destinations and refresh-before-pagination rules; preserve truthful loading/error/unknown
   states. Runtime facts keep source/time/staleness; never infer quota, power or inbox values.
4. Workspace commands use the attached document; unavailable/busy/phone/hidden commands keep
   reasons. Changing mode preserves the other layout. No eager layout engine on unrelated routes.
5. EN/RU at320px and desktop, reduced motion, focus trap/Escape return, no page horizontal
   overflow, and no serious/critical axe finding after mounted transitions. Do not claim real
   screen-reader speech from axe. Health failure and Retry remain usable before shell mount.

New mounted assertions must target the real App route, not only the existing standalone palette
fixture. Use explicit counts, request counts or stable content identity for uniqueness/remount
claims. Strengthen obsolete navigation fixtures to exercise the replacement path; never delete,
skip or loosen a behavioral assertion to get green. Do not add sleeps/retries to hide races.

## Verification, compatibility and handoff

Author writes focused mounted component and mocked browser tests, runs scoped web tsc and
safe static checks only in the DSH sandbox. Root/reviewer own actual browser/component and full
gates through workstation-dev. No nested sandbox/container/model/provider/SSH/owner data.
Use Node26.9, lane ports5202/4402, GUANXI_DATA_DIR=$PWD/.lane-data. Shared heavy resource is
`/Users/yuzuru/.local/state/agent-dev`, runtime owner root. Do not run shared checks directly
or edit a checkout while its checks are queued/running.

Independent Sol review checks actual mounted flows and discriminating assertions. Fix findings
in separate commits. Root runs complete web browser, fast/catalog UI, types, build, lint and
aggregate integration gates on stable pins. Author handoff separates new/envelope and unrun
checks, exact commits, review-component warnings and residuals. Only the root updates PHASE
and NEXT. No push or merge to main from this lane.

No migration/dependency/license copy is needed. Rollback removes the host composition and
keeps existing preferences readable. Shared source outside owned paths needs root review.
