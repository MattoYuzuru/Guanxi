# Next agent prompt — finish review fixes and integrate one lane

**Status:** ready · **Updated:** 2026-10-21

Read [AGENTS](../../AGENTS.md), [WORKFLOW](WORKFLOW.md), [lanes/README](lanes/README.md)
and [PHASE_STATUS](PHASE_STATUS.md). The [coordination audit](evidence/coordination-2026-10-21.md)
pins the inspected commits and separates implementation, verification and merge state.

Do not restart old prompts merely because a lane file says “running”. Check live processes,
HEAD, dirty state and the latest handoff first. Heavy checks share the `agent-dev` resource
`heavy`; runtime target is this Mac. Use Node 26 and each checkout's own dependencies/ports.

Current bounded recovery queue:

1. **K4 follow-up 2:** `codex/k4f2-review-fixes` in `Guanxi-lanes/coord-k4f2` fixes the
   independently reproduced handover-during-delete race. The old home must leave durable
   deletion intent and R1 rows for the successor. Re-review the fix and its negative control,
   then arrange the lane's cross-family review and integrator gates before merging.
2. **DS2:** `codex/ds2-review-fixes` in `Guanxi-lanes/coord-ds2` contains current main and
   fixes unsupported-platform reporting plus test coverage of the production access-control
   and authentication-context builders. Re-review and run full gates. Keep real owner-present
   hardware signing unverified until its explicit local integration check; do not approve a
   component or run real key migration/bootstrap during ordinary tests.
3. **X1:** `codex/x1-parent-read-boundary` in `Guanxi-lanes/coord-x1` is intended to close the server-side
   unsandboxed fingerprint policy-read path. A post-read containment rejection is insufficient.
   Require an actual read-denial regression and independent review, including Linux/Mac worker
   boundaries in their authorized environments, before integration.
4. **U1-a:** candidate `0523f9b` has local layout/mode behavior and a handoff. Review the
   whole candidate; record cross-node layout replication as absent. U1-b shell and U1-c
   zero-suppression migration remain separate unfinished slices.
5. **B1:** candidate `298a93a` is a partial fixture foundation. Next define and implement the
   per-request K3 billing reservation boundary, immutable 50+30 corpus staging and actual
   Guanxi task executor. No paid/model noise-floor run is authorized by the fixture handoff;
   ADR-0025 is not yet an operational evolution gate.

DS1-a/b/c and F1 are merged. K4/K5/R2 bounded implementations are merged with explicit
residuals; do not reopen their original whole-lane prompts or claim full product readiness.
R3 and F2 are available roadmap successors once their dependency contracts are satisfied.
No phone relay has been deployed (U4, D-187, ADR-0038).

Workers write lane handoffs, never the central status files. The integrator updates this
prompt and PHASE_STATUS after each bounded outcome, retains separate review-fix commits,
and publishes main only after its required gates pass. If a fix/gate remains unresolved,
leave this prompt on that item with the exact blocker and recovery command.
