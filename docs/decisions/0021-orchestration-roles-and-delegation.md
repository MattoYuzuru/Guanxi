# ADR-0021: Agent orchestration — native and external agents, roles, delegation policy

**Status:** proposed · **Date:** 2026-10-19
**Carries forward:** legacy ADR-0008 (agent execution and integrations) and ADR-0010
(first-party coding agent).

## Context

The brief describes role-based routing (lead on a Claude subscription, coder on DeepSeek API,
computer-use verifier on a ChatGPT plan, routine on local Qwen), choices at session and
project level or delegated to agents, organisations of agents, composition of models (an LLM
writes a prompt for an image model) and a light harness (D-110).

Evidence (lane 4): multi-agent helps on parallel, read-heavy work and hurts on tightly coupled
coding; "why do multi-agent systems fail" (MAST) lists specification and coordination
failures; single-writer coding with central verification is the robust pattern; a bad plan is
worse than none.

## Decision

1. **Agent backends**:
   - *native*: Guanxi's loop on `pi-agent-core`; full control of prompts, tools, compaction,
     relay and trace;
   - *external*: ACP or app-server adapters for Claude Code, Codex, Copilot, Gemini CLI,
     OpenCode, Goose. Each adapter declares what it exposes (plan, tool calls, usage, resume).
2. **Roles**: `lead`, `executor`, `reviewer`, `judge`, `advisor` (on-demand, quota-limited),
   `scout` (read-only, returns ≤2k summary). A role binds to `(connection, model, params)` by,
   in priority order: explicit session choice → project default → delegation policy.
3. **Delegation policy**: choose the cheapest allowed executor whose predicted
   `p_success(model, item.est_human_min) ≥ θ` (θ ≈ 0.8 for unattended runs), using a
   METR-style logistic curve fitted on Guanxi's own history with external benchmarks as a
   prior. If none qualifies, ask the planner to split the item, else raise the tier. Policy
   constraints ("local only", budgets, no cloud) are hard filters.
4. **Escalation ladder at runtime**: fresh cycle → J2 hint → local reviewer → cheap API model
   (if allowed) → advisor (quota) → wake lead → user.
5. **Delegation brief** (lead → executor), required fields: objective and definition of done;
   immutable plan revision with items, acceptance commands and estimates; constraints and run
   policy (roots, commands, network, protected paths); resources (node, model, `W`,
   keep-alive); judge config; wake policy; time budget; report format; fallback connections
   per role and quota reactions (`on_quota_low`), which are the only automatic reactions to
   quota events Guanxi may take (D-124, ADR-0033).
6. **Multi-agent rules**: one writer per worktree; parallelise only independent items on
   separate worktrees with resource leases; central merge and verification gate.
7. **Composition**: a session may include several models; a tool call can target a media
   model (for example `image.generate` on a local runtime); outputs are typed artifacts.
8. **Light orientation**: the default system prompt states node, OS, cwd, project roots,
   access mode, tools, skills, budgets and `AGENTS.md`; additional instructions require a
   benchmark win (ADR-0025).
9. **Tools baseline**: files, shell, search (multiple backends via connections), fetch,
   attachments of any type the active model or a converter can read, plan/queue tools,
   `note.add`, `delegate`, `work.query`, MCP tools (ADR-0022 §9), skills.
10. **Progress visibility (REQ-C9)**: the plan, item progress, follow-ups, the prompt queue and
    the session summary are projections of the work ledger (ADR-0032), so the UI shows
    derived state, not the agent's checklist. A lightweight plan tool for `off` mode is
    enabled per model class (default on for local small models, off for frontier models)
    until the WL-series A/B decides.
11. **Confirmations**: neither access mode prompts; runs stop for a person only through
    `input_required` or the run policy's `requires_confirmation` list (D-118).
12. **Agent-chosen routing (REQ-C2)** inside constraints arrives with the delegation policy in
    stage R3; earlier stages support explicit and project-default choices only.

## Consequences

Routing is explainable (every choice logs its inputs with provenance). External agents cannot
be relay executors (their compaction is internal) but can be leads, reviewers or verifiers.

## Validation

Golden tests for role resolution precedence; recorded ACP sessions per adapter; a benchmark
comparing native and external agents on the same tasks (stage B2).

## Evidence

Lane 1 §§2–8, lane 4 §§3–4, 8.3 ([research](../research/README.md)).
