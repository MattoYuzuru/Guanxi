# ADR-0025: Bench stage and the A/B gate for harness changes

**Status:** accepted as a mandatory stage (owner decisions D-109, D-110; grading clarified by D-119); proposed design ·
**Date:** 2026-10-19

## Context

The owner wants every change to prompts, tools, compaction, routing and plugins validated by
recurring benchmarks and A/B tests, built from real repositories: roll a repository back to
before a merged PR (or a series of PRs), let the agent implement it, then compare with the
real change. The harness should stay light and mainly orient the agent.

Lane 6 findings:

- The owner's method is the SWE-bench methodology (base commit, hidden FAIL_TO_PASS and
  PASS_TO_PASS tests in Docker). Mining (SWE-rebench V2), environment building (RepoLaunch,
  MIT, about 78% build success; SWE-smith) and feature-level tasks (FeatBench, FeatureBench)
  already exist.
- **Harbor** (Apache-2.0, v0.24.0) runs tasks, agents (Claude Code, Codex, OpenCode,
  mini-swe-agent, ACP agents) and environments (docker, apple_container, ssh, k8s), with
  regrading and LLM/agent judges. SWE-bench Pro V2, SWE-rebench and Terminal-Bench ship in
  Harbor format.
- SWE-bench Verified is contaminated and about 30% of SWE-bench Pro public tasks are broken;
  use fresh monthly windows and private tasks.
- Two configurations disagree on 10–20% of tasks even at equal scores; 100–150 tasks × 3
  seeds detect 5–8 points, not 2–3. About 54% of harness-evolution gains in one study were
  overfitting.
- Minimal harnesses are close: bash-only mini-swe-agent trails the best scaffolds by 2–3
  points on frontier models while costing far less; weaker (local) models benefit more from
  tools, planning and context management. Repository overviews in AGENTS.md raised cost by
  more than 20% without improving success in one study; policies in instructions do help.

## Decision

1. **Runner**: Harbor as an external Python process managed as a Guanxi run on the fleet;
   Guanxi joins as an ACP agent or a Harbor `BaseAgent` through `guanxi agent exec --json`.
2. **Arms**: `guanxi@<harness_version>` under test, **mini-swe-agent as the permanent control**,
   optionally Claude Code or Codex as subscription references.
3. **Task sources and splits**: fresh SWE-rebench / SWE-bench-Live windows; feature and epic
   tasks; a private registry (`guanxi-bench-tasks`, Harbor format) mined from the owner's
   repositories and from Guanxi sessions. Splits: `dev` (visible to the evolution proposer),
   `val` (gate), `sealed holdout` (fresh monthly, opened only at release), `regression`
   (tasks with pass^5 = 1), `canary` (impossible tasks and planted hacks).
4. **Task validation**: oracle passes 3/3, no-op fails, flakiness × 5, narrow tests, owner
   review of broken tasks.
5. **Locked protocol**: agent phase offline except the model endpoint; verifier in a clean
   container; fixed resource profile recorded with each trial (CPU, memory with headroom,
   timeouts); trials preempted by interactive work are marked `infra_tainted` and re-run.
6. **Grading layers**: hidden tests (gate) → static checks → cheap pairwise LLM judge
   (DeepSeek Flash or local) → agent-as-a-judge only on disagreements → owner calibration.
   Hidden tests are the pass/fail gate (D-119). Diff review against the merged PR and a
   plan-level judge ("what the agent says it did" vs "what the PR did", including
   optimisations) are always scored and reported, and act as guardrails: a candidate may not
   show a significant drop in either. They never pass a task on their own, so valid
   alternative designs are not punished.
7. **Statistics**: paired design (same tasks, seeds, model, infra, interleaved scheduling);
   per-task success averaged over seeds; 95% bootstrap CI clustered by task; McNemar or
   sign-flip p; Holm correction for several arms or metrics; always-valid CIs when peeking;
   list of flipped tasks in every report.
8. **Decision rules** (thresholds are protected surfaces):
   - simplifications (remove a tool, shorten a prompt, disable a plugin) pass on
     non-inferiority: CI lower bound > −5 points on the full A/B (the margin matches what
     100–150 tasks × 3 seeds can resolve), confirmed on the holdout;
   - additions pass on superiority (CI lower bound > 0) or non-inferiority plus ≥15% cost or
     time saving;
   - guardrails: cost +10% max, no rise in infra errors, no new regression failures at pass^3,
     zero canary hacks;
   - results stratified by model class (frontier subscription, cheap API, local); no
     significant regression allowed in any stratum.
9. **Cadence**: smoke on every harness/plugin PR (20–30 tasks, K=1); nightly regression on
   local models (50 tasks, free); full A/B (100–150 tasks, K=3) every two weeks or when a
   batch of candidates is ready; monthly holdout and corpus rotation; monthly judge calibration on 20–30 owner-labelled trials.
10. **First experiments** (orientation series): O0 task only → O1 orientation block
    (≤300 tokens: cwd, roots, OS/arch/shell, date/TZ, access mode, network policy, key tool
    versions, host resources and active leases, limits, path to AGENTS.md) → O2 + build/test
    commands → O3 + AGENTS.md content → O4 + structural index on demand; TOOLS-1 bash-only
    vs bash + edit/search tools per model stratum. Then the **WL series** for the work ledger
    (ADR-0032): `none / todo / todo + recite / ledger / ledger + sync`, with status accuracy,
    update latency and false-"done" rate as extra metrics and a "bad plan" canary.
11. **Budgets**: per-experiment cap per arm (equal for both arms), per-trial step and cost
    limits, daily token limits per provider; balances read through ADR-0017. Lane 6 estimate
    at 2026-10-19 DeepSeek prices: smoke ≈ $6, full A/B (600 trials) ≈ $70 on Flash or
    $120–265 on V4-Pro. With a biweekly full A/B on Flash, about 20 smokes and free nightly
    local runs, the monthly spend is about $170–200; the budget (D-150) is $200.
12. **Placement**: amd64 task images on the Fedora PC (native Docker; WSL2 Docker when it runs
    Windows) or the Fedora laptop (native Docker); local model inference and the local judge on the PC's RTX 3060 or
    the MacBook when it has headroom (D-185, D-189); own TypeScript repositories may run
    natively on arm64. The VPS is a relay only.

## Consequences

Guanxi gains an objective brake on scaffolding growth and a gate for self-evolution
(ADR-0024). Benchmark content with canary markers or GPL tasks must never be committed to the
public repository; results may be published as aggregates.

## Validation

Noise floor measured first (one arm × 5 seeds); a planted 10-point regression is detected at
the configured power; a reward-hacking canary is caught; the stats module reproduces Inspect
AI reducers on a fixture.

## Evidence

Lane 6 §§1–9, lane 5 §5 ([research](../research/README.md)); Miller, "Adding error bars to
evals" (2024); Agent-as-a-Judge (Zhuge et al., 2024); SWE-bench and SWE-rebench papers.
