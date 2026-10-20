# Workflow — how to deliver one slice

**Status:** accepted working protocol · **Updated:** 2026-10-19 (translated and adapted from
the legacy protocol of 2026-08-02)

## Short version

You can tell an agent "continue the current stage per the docs". `AGENTS.md`,
`docs/NAVIGATION.md`, `ROADMAP.md` and `PHASE_STATUS.md` let it find the first unfinished
slice. It is more reliable to be explicit:

```text
Continue stage K1 (kernel spike). Read AGENTS.md and the canonical docs, use the
implementation, frontend and SRE skills, implement the slice, verify the exit gate
independently, update PHASE_STATUS and NEXT_AGENT_PROMPT, and make conventional commits.
```

One session closes one bounded vertical slice, never the whole platform.

## The cycle of one slice

### 1. Orientation

- Read `AGENTS.md` and follow the route in `docs/NAVIGATION.md`.
- Check `git status`, the current stage and accepted ADRs.
- Compare docs with code, tests and runtime; fix contradictions in the same task.
- Never touch unrelated or untracked user files.

### 2. Implementation plan

Write it down before a large edit: outcome and non-goals; affected contracts, stores and
components; failure, concurrency and security risks; migration and rollback; test matrix;
validation commands; what will be reused (and its license) instead of written.

### 3. Vertical implementation

```text
contract / migration
→ kernel service or plugin behaviour
→ client projection
→ failure states
→ tests
→ docs / status
```

Never leave a contract implemented on one side only.

### 4. Independent verification

Self-review and independent verification are different actions. Verification is done by a
**separate reviewer sub-agent** that did not write the code.

- Pick the reviewer from the table below; give it the exact diff of the slice and the claimed
  properties, not a general question; make it read-only.
- The author fixes findings in a **separate commit** (`fix(...)` or `test(...)`), so the
  review is visible in history.
- "No findings" is a result too; record what was checked. A slice without review is not done.

The review must cover: happy path; error, cancel, reload and restart; concurrency and
idempotency; accessibility and responsive behaviour for UI; security and allowed roots for
tools; regression commands; residual risks; and **claimed-but-unproven properties** — for
every statement in docs or an exit gate, the reviewer looks for an assertion that fails when
the property is violated. Indirect proof is a finding.

### 4a. Counting tests

A headline number is not evidence. Separate:

- **new** — tests added by this slice (`git diff <base>..<head> --stat -- '*test*'`);
- **regression envelope** — files run in full to guard against regressions.

Write `K2: 11 new / 20 envelope`, not `K2 20/20`. The same file is never credited to two
slices.

### 4b. Benchmarks (after stage B1 exists)

A slice that changes prompts, tools, routing or compaction attaches a bench result (smoke at
least) per [ADR-0025](../decisions/0025-bench-stage-and-ab-gate.md). Simplifications need
non-inferiority; additions need superiority, or non-inferiority together with a ≥15% cost or
time win. Plugins that change agent behaviour follow the same rule through the evolution gate
(ADR-0024).

### 5. Documentation and commits

- Current-state docs describe only what is implemented.
- Roadmap scope is not rewritten to fit a convenient result.
- `PHASE_STATUS.md` holds the evidence.
- `NEXT_AGENT_PROMPT.md` is rewritten for the next unfinished slice. If the slice is blocked
  or verification failed, it stays on the current slice and explains the blocker and recovery.
- Generated artifacts are not committed.
- Conventional commits separate behaviour, tests/migrations and docs when that helps review.
- Reused third-party code is listed in `THIRD_PARTY_NOTICES.md` in the same commit.

```text
feat(kernel): load plugins through the Cordis facade
test(kernel): assert zero leaks over 100 reload cycles
fix(runs): reject stale fencing tokens on completion
docs: record K1 verification evidence
```

## Skills to use

The skill and reviewer names below are the maintainer's agent setup. Contributors with other
tools use their equivalents: a planning step, an implementation reviewer, an accessibility
reviewer and a security reviewer.

| Work | Skills |
| --- | --- |
| Any non-trivial implementation | `sde-agent:implementation-planning`, `sde-agent:sde-agent`, `sde-agent:implementation-evidence` |
| React, UX, accessibility | `frontend-agent:frontend-agent`, `frontend-agent:frontend-verification` |
| Runs, recovery, migrations | `architecture-agent:architecture-migration`, `sre-agent:verification-strategy` |
| Governor, fleet, performance | `sre-agent:performance-analysis`, `sre-agent:reliability-testing` |
| Agents, tools, MCP, plugins | `sre-agent:defensive-security-review`, `sre-agent:finding-validation` |
| Stage exit | `sre-agent:release-readiness` |
| Documentation drift | `cleaner-agent:documentation-reconciliation` |

## Reviewer sub-agents

These are sub-agent types for step 4, a different registry from skills. A skill name cannot be
passed as `subagent_type`.

| Slice area | Reviewer |
| --- | --- |
| server, contract, migration, kernel | `sde-agent:implementation-reviewer` |
| Web, UI, accessibility | `frontend-agent:accessibility-reviewer` |
| runtime, recovery, security, fleet | `sre-agent:test-actor` |
| architectural boundary | `architecture-agent:adversarial-architect` |
| deletion, docs drift | `cleaner-agent:cleanup-reviewer` |
| release, delivery | `devops-agent:release-verifier` |
| requirements, product docs | `product-agent:requirements-critic` |

Check the list of available agent types before calling; do not rely on memory. One
implementation owner and one independent verification lane are usually enough.

## When to say "next stage"

Only if all slices of the stage have implementation evidence; the exit gate was checked as a
whole; SRE/release review found no blocking issue; migrations and recovery were checked;
`PHASE_STATUS` and current docs are updated; `NEXT_AGENT_PROMPT` points to the next stage's
first slice; the worktree has clear commits. Otherwise "continue" means the next slice of the
same stage.

## Parallel sessions

Stages without a dependency between them (see the [roadmap graph](roadmap.mmd)) may run in
separate sessions at the same time when they touch different packages. Each session works in
its own worktree, avoids running heavy checks (browser gate, benchmarks) at the same time as
another session on the same machine (use a shared lock if your environment provides one), and
merges only after its own exit gate. The concrete rules for the current wave (lanes, owned
paths, ports, the `agent-dev` lock, hand-off files and merge order) are in
[lanes/README](lanes/README.md).
