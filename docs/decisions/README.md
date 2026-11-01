# Decisions

**Updated:** 2026-11-01

Statuses: `proposed` (not yet approved), `accepted` (approved, maybe not implemented),
`implemented`, `superseded`. A newer owner decision record overrides older ones. Every ADR
lists the evidence it rests on.

## Owner decision records

| Record | Status |
| --- | --- |
| [2026-11-01](2026-11-01-owner-decisions.md) (D-222–D-234: first alpha authorization, licensing, desktop identity and release cadence, scoped payment grants, local client authentication, dictation, browser and evaluation corpus) | accepted intent; implementation tracked separately |
| [2026-10-31](2026-10-31-owner-decisions.md) (D-219–D-221: B3 gate moves from MS1 to MS2 with a smoke cohort now, Sonnet-only workers for the wave 7 lead, desktop platform order macOS → Linux/Fedora → Windows) | accepted |
| [2026-10-24](2026-10-24-owner-decisions.md) (D-214–D-218: MS1 exit by fault scenarios instead of six hours, user API key for the lead, worker models, Developer/Visual split withdrawn, in-app connections centre with a provider catalog) | accepted |
| [2026-10-23 addendum](2026-10-23-owner-decisions-addendum.md) (D-200–D-212: UI redesign, palette, icons over text, no retry buttons, composer layout, models in chat, fleet map, Sonnet MS1 lead, API-key and subscription-token routes for it) | accepted |
| [2026-10-23](2026-10-23-owner-decisions.md) (D-196–D-199: Fedora real runs, Claude Code as MS1 lead, Guanxi-Test-Repo target, local R3 observation journal with paths) | accepted |
| [2026-10-22](2026-10-22-owner-decisions.md) (D-195: restored Fedora checks and deliberate retirement of Agent Workstation) | accepted |
| [2026-10-21](2026-10-21-owner-decisions.md) (D-185–D-194: real fleet, Fedora home, own phone relay, compute-provider protocol, interactive headroom, owner-bound subscriptions, local AI, training, scale, benchmark host) | accepted |
| [2026-10-20 addendum](2026-10-20-owner-decisions-addendum.md) (D-141–D-182: answers to every open question Q-201–Q-244; D-183: own kernel instead of Cordis; D-184: approval signing helper) | accepted |
| [2026-10-20](2026-10-20-owner-decisions.md) (D-123–D-140: quota alerts, notifications, logo, design system, layout, modes, agent browser) | accepted |
| [2026-10-19 addendum](2026-10-19-owner-decisions-addendum.md) (D-114–D-122: work methodology, trackers, clarifications after the S0 review) | accepted |
| [2026-10-19 re-foundation](2026-10-19-owner-decisions.md) (D-101–D-113) | accepted |
| [2026-08-18 phase 3/4](../legacy/alamo/decisions/2026-08-18-phase-3-4-decisions.md) (Russian) | accepted for the legacy code; overridden where D-101+ conflict |
| [2026-08-02 product](../legacy/alamo/decisions/2026-08-02-product-decisions.md) (Russian) | accepted for the legacy code; overridden where D-101+ conflict |

## Architecture decision records (Guanxi)

| ADR | Title | Status |
| --- | --- | --- |
| [0015](0015-refoundation-on-own-cordis-kernel.md) | Re-found on an own thin kernel over Cordis 4 and pi-ai | accepted; Cordis part rejected by D-183 (own kernel, ADR-0037) |
| [0016](0016-licensing-and-third-party-reuse.md) | Apache-2.0 licensing and third-party reuse | accepted; implemented (including `npm run check:licenses`) |
| [0017](0017-model-access-connections-and-secrets.md) | Model access: connections, subscription agents, secrets | accepted policy, proposed design |
| [0018](0018-federation-ownership-and-leases.md) | Multi-master federation with single-writer ownership and fenced leases | accepted direction, proposed design |
| [0019](0019-durable-runs-hibernation-and-wake.md) | Durable runs, lead hibernation and wake-up | proposed |
| [0020](0020-relay-executor-handoff-and-judge.md) | Relay executor, ledger-first handoff, judge cascade | proposed |
| [0021](0021-orchestration-roles-and-delegation.md) | Orchestration: native and external agents, roles, delegation | proposed |
| [0022](0022-plugin-trust-tiers-ui-slots-and-design-tokens.md) | Plugin trust tiers, UI slots, design tokens | proposed |
| [0023](0023-session-event-log-and-tracing.md) | The session event log is the trace | proposed (reasoning capture accepted) |
| [0024](0024-self-evolution-loop.md) | Self-evolution loop with risk classes and protected surfaces | accepted tiers, proposed design |
| [0025](0025-bench-stage-and-ab-gate.md) | Bench stage and the A/B gate | accepted as stage, proposed design |
| [0026](0026-clients-desktop-web-mobile.md) | Clients: Electron desktop, web/PWA, native mobile | proposed |
| [0027](0027-accounts-sharing-and-access-modes.md) | Accounts, sharing, the two access modes | accepted modes, proposed design |
| [0028](0028-voice-and-glossary.md) | Voice input, glossary, learning from corrections | proposed |
| [0029](0029-computer-use-tiers.md) | Computer use in tiers | proposed |
| [0030](0030-project-knowledge-indexing.md) | Project knowledge indexing where it helps | proposed |
| [0031](0031-compute-fabric-node-agent-and-runtimes.md) | Compute fabric: node agent, runtimes, catalog, cloud budget | proposed |
| [0032](0032-work-ledger-board-and-tracker-sync.md) | Work ledger, board projection, external tracker sync | accepted direction, proposed design |
| [0033](0033-notification-center-and-quota-alerts.md) | Notification center, quota and balance alerts, actionable notifications | accepted direction, proposed design |
| [0034](0034-design-system-tokens-catalog-and-gates.md) | Design system: tokens, catalog, approvals and gates | accepted direction, proposed design |
| [0035](0035-agent-browser-and-site-sessions.md) | Agent browser and site sessions | accepted direction, proposed design |
| [0036](0036-workspace-layout-and-experience-modes.md) | Workspace layout, blocks and experience modes | accepted direction, proposed design |
| [0037](0037-own-plugin-kernel.md) | Guanxi's own plugin kernel (supersedes the Cordis part of ADR-0015) | accepted (D-183); implemented in lane K1 |
| [0038](0038-compute-providers-fleet-placement-and-remote-control.md) | Compute providers, fleet placement and remote control | accepted direction, proposed design |

## Legacy ADRs (Alamo era, Russian)

They describe the code that exists in `packages/` today. Their target-state role in Guanxi:

| Legacy ADR | Status in Guanxi |
| --- | --- |
| [0001 local modular monolith](../legacy/alamo/decisions/0001-local-modular-monolith.md) | superseded by ADR-0015 as target structure; describes current code |
| [0002 resource governor](../legacy/alamo/decisions/0002-resource-governor.md) | carried forward into ADR-0018 / ADR-0031 (per-node governor) |
| [0003 capability manifest and adapters](../legacy/alamo/decisions/0003-capability-manifest-and-adapters.md) | carried forward into ADR-0017 / ADR-0031 |
| [0004 durable jobs and events](../legacy/alamo/decisions/0004-durable-jobs-and-events.md) | carried forward and extended by ADR-0019 / ADR-0023 |
| [0005 unified work entities](../legacy/alamo/decisions/0005-unified-work-entities.md) | input to the domain model in TARGET_ARCHITECTURE |
| [0006 catalog sources and compliance](../legacy/alamo/decisions/0006-catalog-sources-and-compliance.md) | carried forward into ADR-0031 |
| [0007 brand portability](../legacy/alamo/decisions/0007-brand-portability.md) | implemented by the clean rename to Guanxi (D-101); compatibility layer not needed |
| [0008 agent execution and integrations](../legacy/alamo/decisions/0008-agent-execution-and-integrations.md) | carried forward into ADR-0021 / ADR-0022 |
| [0009 application service lifecycle](../legacy/alamo/decisions/0009-application-service-lifecycle.md) | carried forward into ADR-0026 |
| [0010 first-party coding agent](../legacy/alamo/decisions/0010-first-party-coding-agent.md) | carried forward as the native agent (ADR-0021) |
| [0011 server-owned feature flags](../legacy/alamo/decisions/0011-server-owned-feature-flags.md) | kept; extended by the per-run harness version registry (ADR-0024) |
| [0012 estimated parallel admission verdict](../legacy/alamo/decisions/0012-estimated-parallel-admission-verdict.md) | carried forward into the fit ladder (ADR-0031) |
| [0013 phase 4 service control and clients](../legacy/alamo/decisions/0013-phase-4-service-control-and-clients.md) | carried forward into ADR-0026 |
| [0014 notification persistence and delivery](../legacy/alamo/decisions/0014-notification-persistence-and-delivery.md) | carried forward; its outbox pattern is reused for wake-ups (ADR-0019) |

## 2026-10-24 validation protocol

[D-213 — hosted final CI and scoped local iteration](2026-10-24-ci-protocol.md) supersedes
older per-lane/per-merge full local gate requirements.
