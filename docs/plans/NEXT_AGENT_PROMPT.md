# Next agent prompt — finish wave 10 package delivery verification

**Status:** active slice, mounted GUI smoke/hosted integration pending · **Updated:** 2026-11-01

Read [AGENTS](../../AGENTS.md), [NAVIGATION](../NAVIGATION.md), [WORKFLOW](WORKFLOW.md),
[CI protocol](../operations/ci.md), [PHASE_STATUS](PHASE_STATUS.md) and the
[2026-11-01 owner decisions](../decisions/2026-11-01-owner-decisions.md).

## Resolve actual state

`main` remains `1be1b6de` (wave 8). PR #5 / `lead/wave9` is open at `af254dae`; full run
41324115509 passed and `ci:finish` returned success (tested `e7ef300a`, base `1be1b6de`).
Wave 10 / `lead/wave10` is stacked above it. Inspect live PR/head/base/CI state; never infer
merge from a published PR. Q-249 still requires merge/publication authority; Q-250 is the
first version. D-233 has answered cadence: DMG on each versioned release, CI artifacts for PRs.
No tag/release has been created. Developer ID/notarization is deferred; Q-247/Q-248 are closed.

The owner authorizes native multiagents and only this Mac for local tests. Use isolated
worktrees and the common agent-dev heavy lock; no other hosts, live models, cloud billing or
`~/.guanxi` in tests. Preserve archive clones and retained user data. D-220's earlier Sonnet
allocation does not prescribe this session's workers.

## Finish the current slice

P1 startup is implemented and independently reviewed: [handoff](lanes/P1-trusted-boot.handoff.md),
33 new + 41 inherited tests passed, plus server/CLI types. Keep its portable SDK/slot,
MCP/skills and full-trust limitations explicit; do not reimplement completed boot work.

Finish [U2 package plan](lanes/U2-package-ci.plan.md) and
[operations](../operations/desktop-packages.md). The build succeeds; the mounted GUI verifier
needs its final pass. Direct Electron launches omitted Playwright's mock-Keychain flags,
causing macOS prompts during cookie initialization. The owner reported the prompts; all
diagnostic fixtures were stopped, with no Keychain reset/deletion. A test-process-only fix
adds `--use-mock-keychain` and `--password-store=basic`; production encryption stays enabled.
Earlier CDP-readiness theories were not established as root causes. Independently review
isolation before one bounded local recheck; preserve mount, CSP, resource, Node-isolation and
service-lifetime assertions. Do not attest stale outputs: build-time source/digests must match.
Clean only proven-owned temporary processes and detach only the task volume.

The accepted per-version pipeline is implemented and independently reviewed: see the
[release handoff](lanes/DMG-versioned-release.handoff.md). Do not execute a public release. Use
full current-candidate checks, same-run verified package bytes, draft→attach→publish ordering,
least-privilege tokens and conflict-safe retries. Independent author/reviewer and final full
hosted `ci:finish` remain required. Keep this prompt on the current slice until they pass.

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
