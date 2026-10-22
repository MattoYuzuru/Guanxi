# U1-a completion — signed layout replication

**Status:** bounded replication continuation independently reviewed; local gates passed;
ready for integrator review. The full U1 stage remains unfinished.
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

**New:** 13 Node integration cases in `layout-replication.test.ts`, plus 1 Chromium case for
node-owned account discovery. Existing cases are not counted as new tests.

Assertions cover both replicas' exact winner, recovered copy count/content, state hash,
activation, mode isolation, causal replay, HLC-versus-document ordering, signature tampering,
foreign accounts, atomic operation/clock/projection rollback, protocol upgrade response and
full F1 account-id compatibility. The Chromium case asserts both reads and the save use the
node-supplied account. The fixture performs no live model or external page request.

Targeted checks:

- Layout tests: 13 new integration cases and the 12 existing storage cases form the focused envelope.
- Server and web TypeScript checks pass (direct package checks).
- Workspace Chromium: 1 new + 18 existing cases pass under the heavy lock;
  receipt `check-wjr3stcr`, stable dirty implementation source before commit.

Full `npm test` passed at clean `af6f7fb` before the independent-review fixes, receipt
`check-3l7wso17`, with unchanged source. This is a prior-candidate regression observation;
the final fix-candidate observations follow below.
Receipts are under `/Users/yuzuru/.local/state/agent-dev/`; the pre-existing external skill
symlink prevents reusable source certification. These are local command observations.

## Compatibility and residuals

The v1 schema remains unchanged. An append-only component migration v2 adds a per-scope
activation clock projection; it seeds existing admitted layout activation metadata once,
after federation tables exist, including when a local-only LayoutStore initialized first.
Each admitted layout reads one indexed scope row rather than decoding/re-scrubbing the
signed operation history. Winner metadata and document projection share F1's transaction.
No global migration is added or rewritten. Existing local documents are not
silently reassigned to a federation account or signed; an explicitly scoped save publishes
them. Disabling federation retains existing tables/history; rollback should leave them intact
and use a forward fix. Actual network provisioning/peer scheduling remains host-owned F1
scope; these tests use authenticated injected transport between real independent SQLite stores.
No live fleet, Electron renderer, hardware, screen-reader speech or model inference is claimed.

Root coordinated a separate review of this new implementation; this author was not its
sole reviewer. Fixes are separate commits. Then U1-b and U1-c continue as distinct slices;
this handoff does not mark the entire U1 stage complete.

## Independent review fixes

The separate GPT reviewer confirmed two P2 findings at `af6f7fb`: activation scanned and
re-scrubbed the full signed history on every layout admission; account validation rejected
valid F1 names `constructor` and `prototype`. The fix replaces the scan with the transactional
scalar projection above and permits those names only in the account field, preserving
layout-only identifier restrictions. Three additional Node cases assert zero full-log reads
for 20 local writes and remote admissions, existing-history upgrade after local initialization,
and both reserved account names through context parsing and REST save. The existing rollback
case now asserts activation metadata is unchanged after a rejected projection.
Focused verification: 13 new integration + 12 existing layout cases pass. The independent
reviewer re-reviewed `e5f8e0a`, reran 25/25 cases with zero skips, and replayed the external
20-admission and reserved-account probes. Both P2 findings were closed with no remaining
blocker in this bounded continuation. Their report is
`/Users/yuzuru/.local/state/agent-dev/r3-20261021/u1-independent-review.md`.

## Final local gate observations

Heavy gates at clean executable candidate `e5f8e0a`, source unchanged during each check:

- All-workspace `npm run typecheck` and fast `npm run ui:check` passed. Direct Markdown,
  license and lint checks also passed after the documentation-only reconciliation below;
  license check: 661 packages, zero violations.
- `npm run test:web:browser`: 85/85 mocked Chromium cases, receipt `check-s8sgdc4p`.
- `npm run ui:check:browser`: browser gates G13–G16 and their self-tests passed,
  receipt `check-3ods8auq`; no owner approval is inferred.
- `npm run build`: passed, receipt `check-d19q_vgf`.
- `npm test`: passed, receipt `check-3egqamvk`. Server/CLI envelope: 1264 cases,
  1263 pass and one explicit opt-in macOS keychain case skipped; no keychain operation ran.
  Other envelopes: 6 codemod, 89 gate, 107 kernel, 318 web component, 70 UI gate and
  17 UI component cases passed. These counts describe executed regression scope, not progress.

Current main `c09e2be` was merged afterward as `a45f0c7`; the merge changes only four
documentation paths, with no executable source difference from `e5f8e0a`. The subsequent
handoff edit is also documentation only. Documentation checks were rerun after reconciliation;
integrator checks on the final merged main remain root's responsibility. Receipts are local
observations with the external skill-symlink limitation above, not reusable source certificates.

The original acceptance manifest fix is `1004f1a`; implementation is `d743d57`; independent
review fixes are `e5f8e0a`. Next: account/project/device save-scope UI and U1-b shell in the
separate `codex/u1-shell` worktree, alongside root-coordinated U1-c migration batches.
