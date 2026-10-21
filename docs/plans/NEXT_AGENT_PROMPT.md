# Next agent prompt — run integration gates and merge one reviewed candidate

**Status:** ready · **Updated:** 2026-10-21

Read [AGENTS](../../AGENTS.md), [WORKFLOW](WORKFLOW.md), [lanes/README](lanes/README.md)
and [PHASE_STATUS](PHASE_STATUS.md). The [coordination audit](evidence/coordination-2026-10-21.md)
pins the inspected commits and separates implementation, verification and merge state.

Do not restart old prompts merely because a lane file says “running”. Check live processes,
HEAD, dirty state and the latest handoff first. Heavy checks share the `agent-dev` resource
`heavy`; runtime target is this Mac. Use Node 26 and each checkout's own dependencies/ports.

Current bounded recovery queue:

1. **K4 follow-up 2:** `codex/k4f2-review-fixes` at `baeac3c` in
   `Guanxi-lanes/coord-k4f2`. Independent review closed deletion, whole-maintenance-pass and
   synchronous-transaction findings. The 38 targeted tests and server typecheck pass. Read
   its appended K4F2 handoff, check any original cross-family/platform scope still open, run
   the full integrator gates and merge only after they pass.
2. **DS2:** `codex/ds2-review-fixes` at `785b814` in `Guanxi-lanes/coord-ds2`. Independent
   review closed unsupported-platform and actual production-policy wiring findings. The 47
   scoped tests, production/test Swift builds and server typecheck pass. Run full integrator
   gates; keep actual owner-present hardware signing and installed-helper custody unverified.
   Do not approve a component or create/migrate a real owner key in ordinary tests.
3. **X1:** `codex/x1-parent-read-boundary` at `647c5d0` in `Guanxi-lanes/coord-x1`. The
   fingerprint boundary repair and merge-conflict resolution are independently reviewed.
   Published main is included; the combined indexing/kernel boot gate passes (60 pass,
   1 Linux-only skip), all-workspace typecheck and licenses pass. Run the repaired indexing
   envelope on Linux within the existing authorized runtime scope, then the required full
   integrator gates. Preserve the original X1 residuals; no live model or broad host probing.
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
