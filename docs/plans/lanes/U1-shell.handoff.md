# U1 shell continuation

**Status:** save-scope UI implemented and targeted checks passed; independent review and
full gates pending. U1-b shell and U1-c migration remain unfinished.
**Date:** 2026-10-22 · **Branch:** `codex/u1-shell` · **Base:** reviewed `e5f8e0a`.
Own Node 26 install; `@guanxi/contract` resolves inside this worktree. Ports 5200/4400,
disposable `.lane-data`, local Mac only. No central status edits, push or main integration.

## Scope controls

The existing WorkspaceChrome toolbar now exposes account default, current project,
current device, and current project on this device as explicit save targets. Project targets
exist only when the workspace belongs to a project. Selecting a target writes nothing;
Save and Save as new apply it. The current pane state survives a scope change, mode documents
remain separate, and geometry saves use the saved scope plus current local device.
The base clock is sent only when editing the same scope/id; copying across scopes must not
claim another scope's edit ancestry. Existing narrower active overrides remain in storage;
the established device/project/account resolution order still applies on reload.

No reviewed component implementation or review record changed; WorkspaceChrome remains
`review`. No new component, tokens, snapshot or suppression was introduced. English/Russian
locale keys were added. Browser mock persistence now keys documents and active selection by
their complete scope, and filters account/project/device like the real endpoint.

## New / regression evidence

**New:** two Chromium cases assert explicit outgoing scopes, no write on target selection,
cross-scope ancestry omission, Save as new identity, scoped geometry writes, retained pane
placement, mode isolation/reload resolution, and exactly two non-project choices.

**Regression envelope:** the previous 19 workspace browser cases passed alongside the two
new cases (21/21), receipt `check-f5z3ckxg`. After adding the fourth exact outgoing-scope
assertion, the two new cases passed again, receipt `check-_3myi1v7`. Both runs used stable
dirty implementation source. Web `tsc`, fast `ui:check` and Markdown checks passed.
These are mocked local browser observations; no model, external page, process or owner data.
Existing external skill symlink prevents reusable source certification of runner receipts.

## Next work

Separate independent review of this scope change, with findings fixed in separate commits.
Root has a disjoint AppShellChrome pattern task; this lane retains host integration, fixed
core navigation, palette and actual data. Status facts must retain source/age/unknown states.
New-session flow, side chats and glossary still require implementation against real node
services. Root coordinates the separate U1-c CSS/token migration. The full U1 exit remains open.
