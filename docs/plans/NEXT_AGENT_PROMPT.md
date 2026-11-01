# Next agent prompt — verify wave 10 delivery, then P1 shared SDK

**Status:** local slice complete; exact hosted gate must pass before the next implementation · **Updated:** 2026-11-01

Read [AGENTS](../../AGENTS.md), [NAVIGATION](../NAVIGATION.md), [WORKFLOW](WORKFLOW.md),
[CI protocol](../operations/ci.md), [PHASE_STATUS](PHASE_STATUS.md) and the
[2026-11-01 owner decisions](../decisions/2026-11-01-owner-decisions.md).

## Resolve actual state

The owner explicitly authorized merging PR #5/#6 and publishing `v0.1.0-alpha.1` (D-234).
PR #5 merged as `a23730cb`, after exact-head `ci:finish` confirmed af254dae / full run41324115509.
PR #6 is now based on main; product/desktop/CLI/server versions are aligned for the alpha.
Verify its fresh current-head full gate and merge before pushing the authorized version tag.
Run 41338610542 at `71087caf` passed the alpha package and 13 other tasks but failed the
prewarm browser fixture. A paused-clock repair passed separate source/trace review and 2/2
focused cases; required font/project notices are now staged by a separately reviewed
collector (10 new / 28 regression tests). Both are integrated; see
[prewarm evidence](lanes/prewarm-gate.handoff.md) and
[notice evidence](lanes/release-licenses.handoff.md). The failed run cannot certify these
changes. Require one fresh full gate on their combined candidate; no unchanged-job retry or
local native GUI/Keychain repro is needed.
The tag pipeline must pass all 15 checks and verify its same-run package before publication.
Do not mistake a PR build for a published release. Record the actual release URL/assets,
commit/tree/digests and final CI identities in its evidence. Q-249/Q-250 are closed; do not
ask for the same merge/publication permission again. Developer ID/notarization is deferred.

The owner authorizes native multiagents and only this Mac for local tests. Use isolated
worktrees and the common agent-dev heavy lock; no other hosts, live models, cloud billing or
`~/.guanxi` in tests. Preserve archive clones and retained user data. D-220's earlier Sonnet
allocation does not prescribe this session's workers.

## Finish the current slice

P1 startup is implemented and independently reviewed: [handoff](lanes/P1-trusted-boot.handoff.md),
33 new + 41 inherited tests passed, plus server/CLI types. Keep its portable SDK/slot,
MCP/skills and full-trust limitations explicit; do not reimplement completed boot work.

Finish [U2 package plan](lanes/U2-package-ci.plan.md) and
[operations](../operations/desktop-packages.md). The isolated mounted DMG/ZIP smoke passed at `a57a42ac`
(`check-ixv3t383`, 11.9 seconds), after fresh build `check-hp7o65g5`. The missing test-only
mock-Keychain flags were fixed and independently reviewed; production encryption stays on.
All known diagnostic fixtures were stopped; no Keychain reset/deletion occurred. No further
local GUI repro is needed for unchanged source. Earlier CDP-readiness theories were not
established causes. Preserve the exact build-time source/digest and mocked-Keychain boundary.
Clean only proven-owned temporary processes and detach only the task volume.

The accepted per-version pipeline is implemented and independently reviewed: see the
[release handoff](lanes/DMG-versioned-release.handoff.md). D-234 authorizes this first alpha. Use
full current-candidate checks, same-run verified package bytes, draft→attach→publish ordering,
least-privilege tokens and conflict-safe retries. Separate author/reviewer checks have passed.
Inspect PR #6's latest clean HEAD and complete
its full hosted `ci:finish`; if pending, failed or stale, stay on delivery and fix that exact
condition. Once it passes, continue the bounded P1 shared SDK slice below. Do not re-run
unchanged local envelopes merely to add test counts.

## Subsequent local priorities

After the slice passes, plan a bounded P1 portable shared SDK/context bridge and management
surface; U3 authenticated local binding/accounts with D-225 grant migration; WG2 durable
project-linked read-only GitHub sync; then browser host/Bridge and dictation capture/provider
integration. Accepted decisions do not mean implementation is complete. X1 repo-map/FTS already
runs; embeddings stay off and stale-root removal needs immutable-session-policy care.

D-231 accepts MattoYuzuru/Guanxi for initial Issue reads; live write target/credentials are
still missing. D-229 calls for a general browser including localhost, not a two-site product
restriction; keep per-site grants/stop and user-mediated login, not covert profile extraction.
D-227 accepts local whisper.cpp discovery/reuse plus cloud/path presets; installed tools are
not measured STT quality. Prompt length/vocabulary is not audio ground truth. Use the
[public corpus selection](evidence/public-corpus-2026-11-01.md) as candidates, not validated tasks
or an unseen holdout; preserve owner labels and actual audio/B3 as pending evidence.

Update PHASE_STATUS with new/regression evidence and exact reviewed/hosted revisions, then
rewrite this prompt for the next unfinished slice. No broad stage is closed by a narrow pass.
