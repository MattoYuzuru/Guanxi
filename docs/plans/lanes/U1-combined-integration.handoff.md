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

## Combined eight-gate result and final privacy follow-up

Combined clean pin `0753630bbb72ff609b09177942837a57b0421316` integrates the independent
inventory repair `ff6768b`, main documentation `a9b54e0` and initial K4 privacy `4818b92`.
All eight root commands passed, source unchanged throughout:

| Command | Receipt |
| --- | --- |
| typecheck | `check-lm2tek8f` |
| npm test | `check-6uve_ot1` |
| web browser | `check-p2rivokw` |
| catalog browser | `check-axxx_5mx` |
| build | `check-hew7hgat` |
| Markdown/links | `check-azrpr3f7` |
| licenses | `check-4_kop2c3` |
| source lint | `check-z671wn2j` |

These are regression envelopes: core 1383, kernel 107, web 353, UI gates 102, codemod 6,
catalog 74, UI 43 and bench 82; zero failures/skips. Actual mocked Chromium is **96/96**.
New tests retain each author's accounting; the coordinator adds zero. The exact original
U1-page privacy probe also passes 2/2 at this pin (`check-lb2e__d0`). This does not validate
later source commits or replace the full U1/MS1 exit.

Independent K4 review then found append-time marker expansion can erase byte-comparison
proof of truncation for a valid short descriptor. Separate `c2ae12f` fixes that ambiguity;
final handoff `13bb0e2` is independently closed with 40/40 selected cases including the
unchanged original reproduction (`check-p106mvgt`). The author broader scope is 19 new /
148 prior repository cases plus three outside probes, 170/170 (`check-02wk2z86`).

Merge `08817bf` brings only this separate privacy follow-up and its docs into the union.
Production merged automatically; the sole conflict was the renamed K4 evidence document,
resolved by retaining both current-main integration history and the full author follow-up.
No generated manifest, component record or approval changed. Root must freeze this final
union, repeat its original page probe/independent integration review and all eight commands,
then check main after integration. The earlier eight green receipts are historical evidence.

### Final source gates and documentation-only correction

At clean `aa87859`, all five executable candidate gates pass: typecheck `check-67l5zt55`,
npm test `check-cev9png3`, browser `check-kpkwvot1`, catalog browser `check-ov_ha1ua`, and
build `check-bid9f75g`. The Markdown command `check-lry6czzi` then fails only on three
coordinator formatting errors: two double blank lines and the missing blank above the K4
privacy follow-up heading. No source behavior or assertion failed in that command.

The separate correction changes only these three Markdown files. Executable trees remain
byte-identical to independently reviewed `aa87859`; root reruns Markdown/links and completes
licenses/source lint at the corrected clean pin. Earlier executable gate receipts retain
their exact source pin; they are not relabelled as checks of a later commit.
