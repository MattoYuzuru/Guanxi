# Owner decisions — 2026-10-19 re-foundation

**Status:** accepted (owner answers) · **Date:** 2026-10-19
**Clarified by:** [2026-10-19 addendum](2026-10-19-owner-decisions-addendum.md) (D-114–D-122).
**Supersedes:** the target direction of the legacy Alamo decision records in
[`docs/legacy/alamo/decisions/`](../legacy/alamo/decisions/) wherever they conflict.

This record captures the owner's answers given during the 2026-10-19 brainstorming session,
in which the project was renamed from Alamo UI to **Guanxi** and its scope was widened from a
local Ollama workbench to a multi-model, multi-host agent harness. Newer owner answers
override older ones. Legacy decisions used IDs `D-001`–`D-035`; this record continues at
`D-101`.

The raw owner brief (Russian, voice-dictated) was formalised into
[`vision/REQUIREMENTS.md`](../vision/REQUIREMENTS.md). Research that informed the choices is
in [`research/`](../research/README.md).

## Decisions

| ID    | Topic                     | Decision                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D-101 | Name                      | The product is **Guanxi** (关系, "connections"). The rename is clean: no installation with user data exists, so no compatibility layer is kept for `alamo-ui`, `~/.alamo`, `alamo.*` storage keys or `ALAMO_*` variables. Legacy ADR-0007 is closed as implemented by this clean rename.                                                                                      |
| D-102 | License                   | Guanxi is released under **Apache-2.0** with a `NOTICE` file. Third-party code may be copied only under licenses compatible with Apache-2.0 and must be listed in `THIRD_PARTY_NOTICES.md`. Code without a license is never copied. See [ADR-0016](0016-licensing-and-third-party-reuse.md).                                                                       |
| D-103 | Documentation language    | Repository documentation is **English**. The owner may keep talking to agents in Russian. Alamo-era Russian docs are archived under `docs/legacy/alamo/` and are not rewritten. Clarified by D-120.                                                                                                                                                                                    |
| D-104 | Subscriptions             | Core ships only vendor-sanctioned access: official CLI agents (Claude Code, Codex, Copilot, …) driven as sub-agents, and vendor-published direct sign-in (for example "Sign in with ChatGPT"). The plugin API does not technically prevent third-party auth plugins used at the user's own risk, but the project neither ships nor promotes them. No subscription-sharing relay in core. See [ADR-0017](0017-model-access-connections-and-secrets.md). |
| D-105 | Multi-device topology     | **Multi-master**: every machine runs the same Guanxi and no permanent hub is required. The design keeps this correct by giving every entity exactly one writer and making each machine the only admission authority for its own hardware. See [ADR-0018](0018-federation-ownership-and-leases.md). Clarified by D-116.                                                                |
| D-106 | First end-to-end goal     | The north-star scenario is **delegation to a local model**: a strong lead plans and goes to sleep, a local model on another host executes for hours with relay handoffs, a judge watches, and the lead wakes up to review. The roadmap's first milestone is built around it.                                                                                       |
| D-107 | Self-evolution autonomy   | **Tiered**. Project-level changes (skills, docs, glossary) and sandboxed plugin changes may apply automatically, but only after an eval gate, with automatic rollback and a restart only while idle. Changes to the harness core go through a pull request the owner approves. See [ADR-0024](0024-self-evolution-loop.md). Clarified by D-117.                                       |
| D-108 | Base platform             | **Own thin kernel on Cordis 4 plus `pi-ai`/`pi-agent-core`.** DeepSeek Harness (MIT) is a source of code and patterns to copy with attribution, not an upstream dependency. See [ADR-0015](0015-refoundation-on-own-cordis-kernel.md).                                                                                                                          |
| D-109 | Benchmarks and A/B        | Benchmarks and A/B tests are a **mandatory, recurring stage** that gates harness changes. Tasks are mined from real repositories (roll back before a PR, let the agent implement it, compare with the merged change by tests, diff and plan-level judging). The owner accepts spending subscription quota and cheap DeepSeek API keys on it. See [ADR-0025](0025-bench-stage-and-ab-gate.md). Clarified by D-119. |
| D-110 | Harness weight            | The harness stays **light**: it gives the model its full power and mainly orients it (where it is, what it can use). Extra scaffolding must earn its place on the benchmark.                                                                                                                                                                                       |
| D-111 | Access modes              | Only two user-facing modes: **Full access** and **Read-only**. See [ADR-0027](0027-accounts-sharing-and-access-modes.md).                                                                                                                                                                                                                                          |
| D-112 | Projects                  | A Project does not require a filesystem folder (for example a "Homework" project that only chats and searches). This carries the legacy logical-Project decision forward.                                                                                                                                                                                         |
| D-113 | Reasoning in traces       | Visible reasoning, when a provider exposes it, is captured in the local session log and may be read by local auditors. Secrets are never shown to auditors or models, even though the brief allowed it: auditing never needs secret values, and the harness can redact them exactly because it knows them. The secrets part was confirmed by D-141 ([2026-10-20 addendum](2026-10-20-owner-decisions-addendum.md)). |

## Notes on interpretation

- D-104 was chosen after the session established (lane 1, verified 2026-10-19) that Anthropic
  forbids using Claude Free/Pro/Max OAuth tokens in any other product, including through the
  Agent SDK (refined on 2026-10-21: the user's own unmodified binary driven by a harness is
  allowed; handling credentials and routing other people's requests are not, D-190), while OpenAI publishes "Sign in with ChatGPT" for open-source and local apps.
  Sharing one subscription with other people is forbidden by every vendor checked.
- D-105 was chosen against the research lanes' hub-and-spoke recommendation. ADR-0018 shows
  how multi-master stays correct for jobs, stops and leases without consensus: the owner of a
  session or a machine is the only writer for it. An always-on node is still recommended for
  long lead sessions and phone access, but it is a placement choice, not a required role.
- D-108 replaced the research recommendation "Guanxi as a downstream distribution of DeepSeek
  Harness" (lane 1 matrix: 78/90 vs 64/90). Reasons the owner's choice is defensible: DSH
  accepts no external pull requests, announces breaking changes and is a DeepSeek trademark;
  an own kernel keeps governance, the public API and the data model under Guanxi's control.
