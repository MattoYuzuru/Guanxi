# ADR-0032: Work ledger, board projection and external tracker sync

**Status:** accepted direction (owner decisions D-114, D-115); proposed design · **Date:** 2026-10-19
**Extends:** [ADR-0020](0020-relay-executor-handoff-and-judge.md) (run-level ledger) and
[ADR-0021](0021-orchestration-roles-and-delegation.md) (plan and queue).

## Context

The owner asked whether Guanxi should embed a work methodology (Agile, Scrum, Kanban, WIP
limits) and a native task board, or rely on per-session todo lists plus external trackers.
Agent-maintained checklists drift: the owner observed this in Claude Code's own plan UI, and
lane 7 found false self-reporting in 22.6% of misalignment episodes across 20,574 real
sessions (preprint).

Evidence (lane 7, [research](../research/2026-10-19-landscape/07-work-methodology.md)):

- A harness-fed plan raised a weak model from 13.6% to 25.2% resolved and cut cost for strong
  models by 26–40% with little accuracy change (arXiv:2609.20804, 176 configurations,
  preprint).
- In 2026 vendors made todo tools optional for strong models (Claude Code Task tools off on new
  models except background/cloud runs; Codex `update_plan` opt-in; Amp removed TODO; OpenCode
  removed `todowrite`, then restored it as opt-in for visibility).
- Transferable human practice: executable definition of done (−17…−56% Pass@1 without tests,
  ICSE 2025), explicit dependencies with release on readiness (+14 points, −35% cost,
  preprint), small WIP. Not transferable: sprints (≤2.5 points), ceremonies (1.6–3.1 points at
  about 2.2× tokens).
- Context pollution is real: a reminder that injected every task (609 tasks, ~435 KB) forced
  compaction every ~11 minutes.
- No benchmark compares a board or methodology against none for coding agents.

## Decision

1. **Work ledger as a kernel service** (`packages/work`): plan revisions (immutable), items
   (title, acceptance command, dependencies, estimate, owner role, protected paths), evidence
   links, status history. The run-level ledger of ADR-0020 is the same service scoped to one
   run.
2. **Status is derived, not reported.** Transitions come from harness events: acceptance run
   result in a clean checkout, accepted commit, judge verdict, human decision. An agent's
   "done" creates a `verification_requested` event only.
3. **Modes**:
   - `off` — plain sessions: no ledger, an optional lightweight plan tool per model class;
   - `run` — automatically for delegated, relay and background runs;
   - `project` — project-wide work graph, turned on when the project has two or more
     executors, a linked external tracker, or the user opens the backlog. It becomes the
     default for all projects only after the WL-series A/B shows a gain.
4. **Context discipline**: agents receive a strip of at most 300 tokens (current item,
   acceptance, next item, blocking issues) at cycle boundaries and when drift is detected; the
   full graph is available through a `work.query` tool on demand. Nothing injects the whole
   board.
5. **Flow rules borrowed from Kanban**: pull-based assignment of ready items (all dependencies
   done); WIP limits derived from real capacity (worktree leases, governor permits, review
   queue), never from arbitrary numbers; explicit definition of done = acceptance command.
   No sprints, story points or ceremonies.
6. **Board** in the UI is a projection (columns by derived status, dependency view, evidence
   links); an optional Markdown export (`.guanxi/work/*.md`) is produced on demand and not committed to
   the project repository (D-174).
7. **External tracker sync** (plugins, first GitHub Issues and Jira, D-115): the tracker owns
   business intent (title, description, priority, assignee); Guanxi owns execution state
   (items, evidence, derived status). Link external issues to ledger items; write outward
   rarely and coarsely (start, blocked, done with evidence link); read by polling every 10 minutes (D-175; the node
   is loopback-only by default; webhooks need a relay plugin). Respect rate limits (GitHub: 80
   content creations per minute, 500 per hour; Jira: about 20 writes per issue per 2 s).
   Agents do not get the tracker MCP tools by default (GitHub MCP descriptions cost about
   12.8k tokens).
8. **Measurement**: the WL series in the bench stage (ADR-0025) compares `none`, `todo`,
   `todo + recite`, `ledger`, `ledger + sync`, stratified by model class, with metrics status
   accuracy, update latency, false "done" rate, resolved rate, cost; plus a "bad plan" canary.

## Invariants

- No item reaches `done` without an evidence event produced by the harness.
- The strip never exceeds its token budget (asserted).
- Sync never overwrites business fields owned by the external tracker.

## Consequences

The ledger Guanxi already needs for relay and delegation becomes visible and reusable for the
whole project. Teams that live in GitHub or Jira keep them. The board adds a UI surface and a
sync plugin to maintain.

## Alternatives considered

- **Session todo plus external trackers only**: simpler, but leaves execution state to agent
  memory and to rate-limited external APIs.
- **Full Agile/Scrum**: ceremonies cost tokens without measurable gain for agents.

## Validation

- A planted "done" claim without passing acceptance leaves the item open (test).
- Strip size assertion; `work.query` returns the full graph.
- Sync test against recorded GitHub and Jira fixtures: business fields untouched, status
  comment posted once per transition, rate-limit backoff honoured.
- WL-series A/B recorded before `project` mode becomes a default.
