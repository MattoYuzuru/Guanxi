# U1 combined integration candidate

**Status:** independently reviewed parts combined; full integration gates and merge review pending.
**Date:** 2026-10-22. This is a local candidate, not a whole-U1 or MS1 exit.

## Pinned parts

- Layout and signed replication: the earlier reviewed `e5f8e0a` lineage, synchronized with
  current main through native-input integration `53b1e76`.
- Canonical motion and allowance retirement: `4c51efc`, plus independently closed explicit-null
  validation repair `7ca072e` / handoff `f83533b`. The preceding combined `387453b` passed all
  eight root gates, including 87 actual Chromium cases; that does not certify this later union.
- AppShellChrome, Dialog and Input: unsigned readiness `6b72e68`, source and visual review
  closed, fast status/integrity gate `check-_3culzz9` passed. All three remain `review` with
  `approval: null`; only the owner can sign approval.
- Unmounted shell preparation `b79639d` and complete session search `15b962f`: independent
  reviews closed, including the original failed-FIRST-refresh retry reproduction. The search
  author's final browser scope is five cases, not the full product browser gate.

The coordinator resolves only two integration conflicts: the generated catalog manifest is
regenerated from the combined source, and the SessionLog import list retains both the native
v2 input helpers and `sessionExecutionSchema`. App.tsx still has no product shell mounting.
No owner signature, new UI token or additional suppression was introduced by integration.

## Evidence accounting

**New coordinator tests:** zero. Implementation and repair test counts stay with their
individual handoffs; their overlapping selected envelopes must not be added as new tests.
The combined root typecheck, npm test, web browser, catalog browser, build, Markdown/links,
licenses and source-lint gates are pending at this file's commit. The earlier eight passes at
`387453b` are regression evidence only for that earlier union.

Individual sources: [shell preparation](U1-shell-prep.handoff.md),
[session search](U1-search.handoff.md), [shell chrome](U1-shell-chrome.handoff.md), and
[CSS migration](U1c-css.handoff.md). Their independent reports live outside the repository in
the coordinator's sibling reviews directory.

## Remaining work

Full product mounting, new-session and finished-unseen flows, genuine ephemeral side chats,
the remaining 112 CSS suppressions and other migration debt, owner-signed component approval,
live remote replication and U1/MS1 exit gates remain open. The D-135 side-chat backend outline
is proposed; durable NativeAgentPage creation must not be labelled ephemeral.

Source stays frozen while checks run. The external guanxi-ui skill symlink prevents reusable
source certification: results are local observations with explicit clean HEAD and real scope.
Root owns main integration and central status.
