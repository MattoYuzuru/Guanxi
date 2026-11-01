# Next agent prompt — finish wave 9, then U2 local service lifecycle

**Status:** active continuation · **Updated:** 2026-11-01

Read [AGENTS](../../AGENTS.md), [NAVIGATION](../NAVIGATION.md), [WORKFLOW](WORKFLOW.md),
[CI protocol](../operations/ci.md), [PHASE_STATUS](PHASE_STATUS.md), the
[audit](evidence/audit-2026-11-01.md) and newest owner decisions
([2026-10-31](../decisions/2026-10-31-owner-decisions.md), D-219–D-221).

## Resolve actual state first

Wave 8 is on `main` at `1be1b6de` (PR #4; full hosted gate 41250663100). Wave 9 lives on
`lead/wave9`: documentation reconciliation and K4 queue-v3 Q2. Read the
[Q2 handoff](lanes/K4-queue-v3-Q2.handoff.md) and inspect its PR, HEAD and CI receipt.
If its independent review or final `ci:finish` evidence is missing/failed/stale, stay on Q2,
diagnose that exact condition, fix it and revalidate before beginning another implementation.
Passing local tests alone do not close the slice. Do not infer that a published PR is merged.

The owner currently has only this Mac available for local testing; this session authorizes
native multiagents. D-220's Sonnet-only allocation belonged to the earlier wave 7 session.
Do not launch another harness or access other hosts to recreate that historical allocation.
Give independent authors their own checkout; keep review separate and use the shared heavy-check lock.

Retained local clones are historical: `Guanxi-lanes/integ-trial` has merge-only divergence and
no dependencies; `ledger-ref` is the implemented benchmark reference. Preserve them and their
evidence. Inspect live status again before resuming any old lane. Never use `~/.guanxi` in tests.

## Next bounded implementation after wave 9 validation

Continue **U2 local service lifecycle** on macOS, after inspecting the existing desktop
[README](../../packages/desktop/README.md) and [handoff](lanes/U2-macos.handoff.md).
Implement the next coherent part of launchd/login-item/tray behavior with synthetic local
fixtures: explicit service ownership, non-interactive control, truthful errors and exit codes,
restart/reconnect, and closing the app without cancelling a run. Plan it before editing;
do not bundle all remaining desktop delivery into one slice. Preserve foreign listeners and
owner data, use temporary launchd labels/data in tests and remove only those fixtures.

Signing/notarization, public distribution and update delivery need their own prerequisites.
Q-247/Q-248 and the Apple Developer account gate the relevant release work; they do not
prevent implementing and testing local unsigned lifecycle behavior. Do not silently approve
license exceptions, create owner signatures or publish a DMG. Desktop order remains
macOS → Linux/Fedora → Windows (D-221).

Other remaining MS2 work: U3 Better Auth/resource grants/per-account stores and Q-246 local
owner proof; P1 kernel boot/MCP sandbox wiring; UI residuals and signed component approvals;
WG1 board and `work.query`; WG2 packaging; C1 browser host; V1 owner recordings. The tracker
holds actual partial scope; do not reimplement wave 8 route authorization or queue readers.

## Environment-dependent evidence

MS1 is closed on dated D-214/D-219 fault-run evidence. B3's smoke runner and naive arm are
implemented, but no real smoke/cohort measurement is recorded. The smoke is descriptive;
the full B3 cohort remains an MS2 exit gate. Both require the explicitly scoped Fedora pair
([runbook](../../packages/bench/RELAY_SMOKE.md)); leave them pending while only the Mac is
available. Do not substitute Mac fixture results for that evidence.

Keep `PHASE_STATUS` and this prompt current at the end of the bounded slice. Preserve
historical handoffs and record new / regression evidence separately. Publish the reviewed
candidate and finish its full hosted PR gate under the repository's delivery protocol.
