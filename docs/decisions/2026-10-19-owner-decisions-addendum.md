# Owner decisions — 2026-10-19 addendum

**Status:** accepted · **Date:** 2026-10-19 (later the same day) · **Decisions:** D-114–D-122
**Extends:** [2026-10-19 re-foundation record](2026-10-19-owner-decisions.md) (D-101–D-113).

The owner answered a question about agent work methodology and approved applying every finding
of the independent S0 documentation review. Where a finding showed that an accepted decision's
wording was wrong or ambiguous, the clarification is recorded here; the original decisions are
not rewritten. Clarifications D-116–D-120 were drafted from the review's suggested fixes and
accepted when the owner chose "fix all, aligning the ADRs with the decisions".

| ID | Topic | Decision |
| --- | --- | --- |
| D-114 | Work methodology | No Scrum/Agile layer. A **work ledger** is a kernel service; its status is derived from harness evidence, never from an agent's claim; the board is a UI projection; modes `off` / `run` / `project`; Kanban-style pull with WIP limits taken from real capacity. `project` mode becomes a default only after the WL-series A/B shows a gain. See [ADR-0032](0032-work-ledger-board-and-tracker-sync.md). |
| D-115 | External trackers | First sync plugins: **GitHub Issues** and **Jira**. External trackers own business intent; Guanxi owns execution state. |
| D-116 | One writer (clarifies D-105) | "Exactly one writer" applies to sessions, runs, attempt streams and hardware/local leases. Shared configuration (accounts, grants, projects, connection metadata, glossaries, settings) is explicitly multi-writer and merges by defined rules; identity and grant writes are accepted only from admin-capable interactive nodes. |
| D-117 | Self-evolution gate (clarifies D-107) | Every automatic change, including the lowest risk class (glossary, project memory), passes a pre-apply gate sized to its class. Automatic code changes are limited to sandboxed (T2) plugins. Any in-process code change is an owner-approved pull request. |
| D-118 | Confirmations | Neither access mode shows approval prompts. A run may still stop for a person only through (a) `input_required` escalations and (b) an explicit per-project run-policy list `requires_confirmation` (default: empty). Confirmed by D-122. |
| D-119 | Bench grading (clarifies D-109) | Hidden tests are the pass/fail gate. Diff review and plan-level judging against the merged change are always measured and reported, and act as guardrails (no significant drop), but never pass a task on their own, so valid alternative designs are not punished. |
| D-121 | Jira variant | Support both Jira Cloud and Jira Data Center through one REST adapter; the official Atlassian MCP (Cloud only) is not a dependency. Answers Q-232. |
| D-122 | Confirmation list | The `requires_confirmation` list is empty by default; runs stop for a person only on `input_required`. Cloud spend stays capped by the budget ledger. Answers Q-231. |
| D-120 | Language of research (clarifies D-103) | Raw research evidence keeps its original language (the 2026-10-19 lane reports are Russian); the English synthesis in `docs/research/README.md` and the ADRs are canonical. |

## Replication scope (accepted as part of the review fixes)

Secrets, reasoning and session content follow the owner's devices, not the whole fleet:

- session and run logs replicate only to nodes in the session owner's `owner_device` trust
  class (and are served to shared viewers through the API, not replicated);
- the account vault lives only on `owner_device` nodes the owner opted in; node-key wrapping
  applies only to connections marked `unattended`;
- `cloud_ephemeral` nodes receive no session replicas and no vault, only per-attempt,
  short-lived, scoped secret grants when the run policy allows;
- reasoning events are never replicated and are served only to agents running on local
  runtimes of owner devices.
