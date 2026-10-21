# U1-a completion — signed layout replication

**Status:** implementation ready for independent review; full gates in progress.
**Date:** 2026-10-22 · **Branch:** `codex/u1-completion` · **Base:** `0523f9b`, main
`1067a04` merged as `f8cc73b`. No central status edits, push or merge into main.

## Acceptance review and delivered behavior

A reviewer separate from the original U1-a author replayed the existing storage/boundary/slot
and workspace browser assertions: 21 Node and 18 Chromium cases passed at `f8cc73b`
(`check-l0c3u_0w`, `check-p8q05ocy`). Those tests proved local layout behavior; they did not
prove replication. The original implementation's real-delivery gap is addressed here:

- Strict signed F1 layout operations, keyed by scope/id and bound to the author's account.
- The existing F1 channel/routes transfer layouts between independent node stores. Admission,
  HLC update, layout projection, loser recovery and activation commit or roll back together.
- Portable document LWW follows rev, timestamp and device, rather than F1's generic HLC.
  Named-layout activation is deterministic under the signed configuration order.
- Replays do not duplicate recovery. Mode, named copies and local geometry survive restart;
  inbound configuration never changes another device's window geometry.
- Protocol 1.1 exposes the new value. Older-minor peers receive an explicit upgrade error for
  layout-bearing history; causal dependencies are never silently omitted.
- The browser discovers the configured account from the node before resolving/saving layouts.
  Local-only mode retains its storage behavior. Foreign account access is rejected.

No visual component implementation or review record changed. Existing `workspace-chrome`
remains `review`; no owner approval is inferred. U1-b shell, U1-c migration and U2 Electron
checks remain unfinished. The next separate UI slices must include scope selection, shell
navigation/status/palette/new-session/side-chats/glossary and migration to zero suppressions.

Acceptance also found the original catalog manifest omitted all 16 committed workspace-chrome
snapshot hashes. The generator refresh is a separate fix; original PNGs and component source
are unchanged. The first fast UI check failed G10 for that stale manifest, rather than passing
on the original candidate. The correction and subsequent rerun must be included in acceptance.

## New / regression evidence

**New:** 10 Node integration cases in `layout-replication.test.ts`, plus 1 Chromium case for
node-owned account discovery. Existing cases are not counted as new tests.

Assertions cover both replicas' exact winner, recovered copy count/content, state hash,
activation, mode isolation, causal replay, HLC-versus-document ordering, signature tampering,
foreign accounts, atomic operation/clock/projection rollback, protocol upgrade response and
full F1 account-id compatibility. The Chromium case asserts both reads and the save use the
node-supplied account. The fixture performs no live model or external page request.

Targeted checks so far:

- Layout tests: 10 new integration cases and the 12 existing storage cases form the focused envelope.
- Server and web TypeScript checks pass (direct package checks).
- Workspace Chromium: 1 new + 18 existing cases pass under the heavy lock;
  receipt `check-wjr3stcr`, stable dirty implementation source before commit.

Full regression, UI gates/build and independent review results will be appended after execution.
Receipts are under `/Users/yuzuru/.local/state/agent-dev/`; the pre-existing external skill
symlink prevents reusable source certification. These are local command observations.

## Compatibility and residuals

No schema/table/global migration rewrite is introduced. Existing local documents are not
silently reassigned to a federation account or signed; an explicitly scoped save publishes
them. Disabling federation retains existing tables/history; rollback should leave them intact
and use a forward fix. Actual network provisioning/peer scheduling remains host-owned F1
scope; these tests use authenticated injected transport between real independent SQLite stores.
No live fleet, Electron renderer, hardware, screen-reader speech or model inference is claimed.

Root coordinates a separate review of this new implementation; this author cannot be its
sole reviewer. Fixes must be separate commits. Then U1-b and U1-c continue as distinct slices;
this handoff does not mark the entire U1 stage complete.
