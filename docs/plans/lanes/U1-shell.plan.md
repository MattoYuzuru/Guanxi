# U1 continuation — scope selection and shell

**Status:** autonomous implementation authorized by the owner · **Date:** 2026-10-22
**Branch:** `codex/u1-shell` · **Base:** independently reviewed replication candidate `e5f8e0a`.
Runtime: current Mac, Node 26, ports 5200/4400, disposable `.lane-data`; own `npm ci` completed.

## Behavior and sequence

The workspace can resolve account/project/device layouts but its save controls cannot choose
those scopes. First expose an explicit save scope using the existing reviewed WorkspaceChrome
toolbar field API. Selecting a scope changes only the next save target, preserves the current
pane state, and never silently promotes a device override to an account default. Save and
Save as new must both honor the selected scope. Mode switches preserve their independent
documents. Geometry remains local, stored under the saved scope and current device.

Next replace the legacy tab header with the accepted sidebar/status strip and searchable
keyboard command palette. New, Projects, Models and Settings remain reachable when the
sidebar is moved, collapsed or hidden. Keep existing routes reachable. New session, side chat
and glossary follow as separate bounded behavior changes against actual node services.
This plan does not shrink the U1-b acceptance scope or mark U1-c migration complete.

## Boundaries and verification

Use public `@guanxi/ui` components and existing reviewed composition APIs without editing
reviewed component implementations. Locale keys have English and curated Russian copy.
No fabricated machine/quota/power facts, no new color literals or suppression growth, no
automatic user-data migration. Legacy routes and storage keys retain compatibility.

Scope assertions must inspect exact outgoing scopes and geometry keys, reject cross-project
selection, verify mode isolation, and prove only explicit Save writes. Browser checks cover
keyboard controls and reload resolution. Shell assertions cover all four entries through the
palette with navigation hidden, focus return/Escape, responsive behavior and reduced motion.
Run proportional targeted checks, then required typecheck, regression, browser, UI browser,
build, lint, documentation and license gates; heavy checks share the workstation lock.
Request separate independent review and commit its fixes separately before handoff. Root owns
main integration and central status files. No owner approval of component records is inferred.
