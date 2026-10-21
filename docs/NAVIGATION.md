# Documentation map

**Status:** implemented · **Updated:** 2026-10-21
**Purpose:** canonical index; content lives in the linked documents.

## Quick routes

| Task | Read |
| --- | --- |
| Understand the product | [VISION](vision/VISION.md) → [REQUIREMENTS](vision/REQUIREMENTS.md) |
| See what the owner decided | [Owner decisions 2026-10-19](decisions/2026-10-19-owner-decisions.md) → [addendum](decisions/2026-10-19-owner-decisions-addendum.md) → [2026-10-20](decisions/2026-10-20-owner-decisions.md) → [2026-10-20 addendum](decisions/2026-10-20-owner-decisions-addendum.md) → [2026-10-21](decisions/2026-10-21-owner-decisions.md) → [ADR index](decisions/README.md) |
| Understand the target design | [TARGET_ARCHITECTURE](architecture/TARGET_ARCHITECTURE.md) → relevant ADR |
| Build or review UI | [design system](design/README.md) → [`guanxi-ui` skill](../.agents/skills/guanxi-ui/SKILL.md) |
| Know why a library was chosen | [research synthesis](research/README.md) → raw lane report |
| Continue implementation | [PHASE_STATUS](plans/PHASE_STATUS.md) → [WORKFLOW](plans/WORKFLOW.md) → [ROADMAP](plans/ROADMAP.md) |
| Hand off to the next agent | [NEXT_AGENT_PROMPT](plans/NEXT_AGENT_PROMPT.md) |
| Run or join a parallel lane | [lanes](plans/lanes/README.md) |
| Check owner choices still open | [OPEN_QUESTIONS](plans/OPEN_QUESTIONS.md) |
| Change the code that exists today | [legacy docs](legacy/README.md) (Russian): DEVELOPMENT, TESTING, HLD, LLD, RUNTIME_LIFECYCLE |
| Reuse third-party code | [ADR-0016](decisions/0016-licensing-and-third-party-reuse.md) → [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md) |

## Canonical documents

| Document | Status | Owns |
| --- | --- | --- |
| [README](../README.md) | implemented | introduction, how to run the current code |
| [AGENTS](../AGENTS.md) | implemented | rules for agents working in this repository |
| [VISION](vision/VISION.md) | accepted | why Guanxi exists, principles, positioning |
| [REQUIREMENTS](vision/REQUIREMENTS.md) | accepted intent | testable requirements A–M with stages and designs |
| [TARGET_ARCHITECTURE](architecture/TARGET_ARCHITECTURE.md) | proposed | target system, domain model, ownership, packages |
| [decisions/](decisions/README.md) | mixed | owner decision records and ADR-0015–0038 |
| [design/](design/README.md) | accepted direction | brand book, principles, foundations (tokens), layout and screens, components and catalog |
| [research/](research/README.md) | locally validated | landscape synthesis, reuse register, raw lane reports |
| [ROADMAP](plans/ROADMAP.md) | proposed structure | stage graph, dependencies, exit gates, milestones |
| [PHASE_STATUS](plans/PHASE_STATUS.md) | implemented | mutable tracker with evidence |
| [WORKFLOW](plans/WORKFLOW.md) | accepted | protocol for one slice |
| [NEXT_AGENT_PROMPT](plans/NEXT_AGENT_PROMPT.md) | ready | bounded prompt for the next slice |
| [lanes/](plans/lanes/README.md) | accepted | rules, current ownership and prompts for parallel lanes |
| [OPEN_QUESTIONS](plans/OPEN_QUESTIONS.md) | accepted | open questions with recommended defaults (none open) and answered ones with their decisions |
| [legacy/](legacy/README.md) | implemented (legacy) | Alamo-era docs describing the code in `packages/` today |

## Diagrams

Mermaid sources live next to the docs so agents can check and reuse them:

- [target system](architecture/diagrams/target-system.mmd);
- [roadmap graph](plans/roadmap.mmd);
- legacy diagrams in [`legacy/alamo/architecture/diagrams/`](legacy/alamo/architecture/diagrams/).

## Update rules

- Current-state docs change together with code.
- Target state changes through an ADR or an owner decision record.
- The roadmap links to requirements and ADRs and does not duplicate them.
- A research fact carries its source, date and limits.
- An outdated document is marked `superseded` with a link to its replacement; decision
  history is never deleted.
