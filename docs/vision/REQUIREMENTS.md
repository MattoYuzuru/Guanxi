# Requirements catalog

**Status:** accepted as the owner's intent; individual designs are `proposed` until their ADR
is accepted; rows marked `proposed` are not yet the owner's intent · **Updated:** 2026-10-20

This catalog formalises the owner's 2026-10-19 brief (dictated in Russian). Every row is one
testable requirement. Columns:

- **ID** — referenced elsewhere as `REQ-<ID>` (for example `REQ-A1`) so it cannot be confused
  with roadmap stage IDs such as `K1` or `F1`. IDs are stable; never renumber. Deleted
  requirements keep their row with `withdrawn`.
- **Pri** — `Must` (needed for the milestone the stage feeds), `Should`, `Could`.
- **Stage** — the first roadmap stage that delivers it ([ROADMAP](../plans/ROADMAP.md)); a
  second stage is listed when delivery is split.
- **Design** — the ADR or document that answers it, or `none yet`.

## A. Connections (model and service access)

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| A1 | Use paid subscriptions (ChatGPT, Claude, Copilot, …) without paying for API, only through vendor-sanctioned routes: official CLI agents as sub-agents, or vendor-published sign-in. | Must | K5 | [ADR-0017](../decisions/0017-model-access-connections-and-secrets.md) |
| A2 | Use API keys (Anthropic, OpenAI, DeepSeek, OpenRouter, gifted keys); show balance, spend and limits to the user **and** to agents, each with source and observation time. | Must | K3 | ADR-0017 |
| A3 | Connect non-LLM services (web search, STT, TTS, image and video APIs) through the same registry. | Should | K3 | ADR-0017 |
| A4 | Use local inference on any owned machine for every modality. | Must | K3 (local), F2 (remote) | [ADR-0031](../decisions/0031-compute-fabric-node-agent-and-runtimes.md) |
| A5 | One connection registry that agents can read safely: references to secrets, health, balance, limits, capabilities; secret values never reach a model context, a log, a trace or a remote node outside the owner's devices. Auditors never see secret values either (D-141). | Must | K3 | ADR-0017 |
| A6 | Connections and secrets belong to an account; each user has their own. | Must | U3 | [ADR-0027](../decisions/0027-accounts-sharing-and-access-modes.md) |
| A7 | Subscription agents run on any of the owner's machines, each signed in there with the unmodified vendor CLI; Guanxi never reads, moves or stores vendor tokens; a subscription connection is usable only by its owner, never by another account; limits are aggregated account-wide (D-190). | Must | K5 | [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md) §6 |

## B. Machines and resources (fleet)

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| B1 | The same Guanxi build runs on every machine (macOS, Linux, Windows); a machine's role is configuration, not a different product. | Must | F1 (roles), U6 (installers) | [ADR-0018](../decisions/0018-federation-ownership-and-leases.md) |
| B2 | Data replicates between the owner's machines without a mandatory central server (multi-master, D-105). Sessions, runs, attempts and hardware leases have exactly one writer; shared configuration merges by defined rules (D-116). | Must | F1 | ADR-0018 |
| B3 | A remote client (phone) can watch a live session and its sub-agents, send a prompt, stop work and dictate by voice, with the same rights as on the desktop, through Guanxi's own end-to-end encrypted relay; a phone prompt runs at the always-on home and may be delegated to any machine (D-186, D-187). | Must | U4 | [ADR-0026](../decisions/0026-clients-desktop-web-mobile.md), [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md) §5 |
| B4 | Each machine publishes periodic metrics (CPU, RAM, GPU/VRAM, disk, network, ports, containers, running builds and sessions) with provenance; work is placed on a machine with room; optional pay-per-minute cloud machines are used only within an approved budget. | Must (metrics, placement), Should (cloud) | F1, F3, F4 | ADR-0031 |
| B5 | Agents can run tests and builds on another, stronger or idle machine, and remember that preference. | Should | F3 | ADR-0031 |
| B6 | The fleet design has no size cap: about ten machines in one site is the first target, and sites plus sampling-based placement extend it to large or geo-distributed fleets (D-193). | Should | F2, F3 | ADR-0018, [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md) §§2, 8 |
| B7 | One compute-provider protocol covers owned machines (free, resource accounting only), self-hosted sandboxes, paid per-minute providers and training services; owned machines come first (D-188). | Must (owned), Could (paid) | F4 | [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md) §1 |
| B8 | The machine the owner is using stays fully usable: placement keeps an adaptive interactive headroom from memory pressure, CPU, thermal state and foreground activity, prefers other machines for heavy work and moves work away when the headroom shrinks (D-189). | Must | F3 | [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md) §2 |
| B9 | Train or fine-tune models on owned GPUs or on a service with the user's key; an agent may help sign up for a provider while the user completes CAPTCHA, payment and terms (D-192). | Could | F5 | [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md) §7 |
| B10 | Fully local mode: models run whole on one machine by default; a loaded model holds a residency lease that builds and tests never evict; splitting one model across machines is experimental (D-191). | Should | F3, W2 | [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md) §4 |

## C. Agents and orchestration

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| C1 | Route models by role (for example lead = Claude via Claude Code, coder = DeepSeek API, computer-use verifier = Codex via ChatGPT plan, routine = local Qwen). | Must | K5 | [ADR-0021](../decisions/0021-orchestration-roles-and-delegation.md) |
| C2 | Choose models per session and as project defaults (K5); let agents choose within constraints such as "local models only" (R3). | Must | K5, R3 | ADR-0021 |
| C3 | Support multi-agent organisations (leads, workers, reviewers, judges) and delegation by capability, cost and limits. | Should | R3 | ADR-0021 |
| C4 | Asynchronous delegation with hibernation: the lead dispatches a run to another machine and stops spending tokens; retries, lost machines and completion wake the lead and notify the user. | Must | R1, F2 | [ADR-0019](../decisions/0019-durable-runs-hibernation-and-wake.md) |
| C5 | A small-context executor works for hours through proactive relay handoffs, unlimited cycles, without quality degrading and with exact task tracking. | Must | R2 | [ADR-0020](../decisions/0020-relay-executor-handoff-and-judge.md) |
| C6 | An optional judge (rules, a checker authored by the lead, or an LLM) checks progress periodically. | Must | R3 | ADR-0020 |
| C7 | Review cycles may run on the same cheap model for as long as the user allows. | Should | R3 | ADR-0020 |
| C8 | Show an ETA for a session or run, with a confidence. | Should | R3 | ADR-0020 |
| C9 | Show plan progress, follow-ups, the prompt queue and a summary, derived from harness state rather than the agent's own checklist. | Must | K4 (session), WG1 (project) | [ADR-0032](../decisions/0032-work-ledger-board-and-tracker-sync.md) |
| C10 | A project work ledger whose item status comes from evidence (acceptance runs, commits, judge verdicts, human decisions); a human-readable board view; modes `off` / `run` / `project` (D-114). | Should | R2 (run), WG1 (project) | ADR-0032 |
| C11 | Two-way link with external trackers, first GitHub Issues and Jira (D-115), without giving agents tracker tools by default. | Should | WG2 | ADR-0032 |
| C12 | Canceling a run cancels or detaches each child per policy, exactly once, including while the lead hibernates; a delayed stop never cancels work started after it. | Must | R1, F1 | ADR-0019, ADR-0018 |

## D. Projects and sessions

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| D1 | A Project may exist without a filesystem folder. | Must | K4 | [TARGET_ARCHITECTURE](../architecture/TARGET_ARCHITECTURE.md), ADR-0027 |
| D2 | The empty session screen shows the Guanxi logo, the project picker, the prompt box, the access mode, the model picker, the microphone and the attachment button. | Must | K4 (interim), U1 | ADR-0026 |
| D3 | Exactly two user-facing access modes: Full access and Read-only; neither shows approval prompts (D-118). | Must | K4 | ADR-0027 |
| D4 | Attach and read any file type the selected models or tools can handle. | Must | K4 | ADR-0021 |
| D5 | Share a session with other accounts as viewer (read-only, live) or editor (may prompt and stop). | Should | U3 | ADR-0027 |
| D6 | Tracing at least as detailed as DeepSeek Harness: prompts, visible reasoning, tool calls, sub-agents, compaction and handoff events, costs. | Must | K2 | [ADR-0023](../decisions/0023-session-event-log-and-tracing.md) |
| D7 | Side chats read the session without writing to it; ephemeral by default with "Save to session log" and "Send to main" (D-135). | Should | U1 | [LAYOUT_AND_SCREENS](../design/LAYOUT_AND_SCREENS.md) |

## E. Accounts

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| E1 | Password-protected accounts on one installation; sessions are private by default. | Should | U3 | ADR-0027 |
| E2 | Settings and connections are per account. | Should | U3 | ADR-0027 |

## F. Plugins and UI

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| F1 | Everything is a plugin, including UI: themes, languages, code editor, tree viewer, animations, pricing, subscription management. | Must | K1, P1 | [ADR-0015](../decisions/0015-refoundation-on-own-cordis-kernel.md), [ADR-0022](../decisions/0022-plugin-trust-tiers-ui-slots-and-design-tokens.md) |
| F2 | One design system (tokens, palette, icon set, components); every plugin, including agent-written ones, conforms by construction and by lint. UI built before U1 is interim and is migrated by U1's gate. | Must | U1 | ADR-0022 |
| F3 | A minimal sidebar: New, Projects, Models, Settings. Plugins add entries; they do not rearrange the layout. | Must | U1 | ADR-0026 |
| F4 | Desktop on macOS first, then Fedora and other Linux, then Windows; later iOS and Android. | Must (macOS), Should (Linux, Windows), Could (mobile native) | U2, U6, U5 | ADR-0026 |
| F5 | Untrusted plugins (agent-written or unreviewed third-party) run sandboxed with declared capabilities, and their UI inherits the theme. | Should | P2 | ADR-0022 |
| F6 | The user owns the workspace layout: any block in any zone (sides, top, bottom, centre grid, floating, popout), add, hide, resize, extend status lines, save named layouts (account default, per-project overrides); the navigation sidebar moves or collapses but keeps New, Projects, Models and Settings; moving a block works without dragging (D-131). | Must | U1 | [ADR-0036](../decisions/0036-workspace-layout-and-experience-modes.md) |
| F7 | ~~Two experience modes, Developer (IDE-like) and Visual (results, artifacts, preview, browser; code only as a summary), each with its own layout (D-132).~~ Superseded by D-204 and owner feedback 2026-10-23: one interface, a full-width session with side panels on demand. | Should | U1 | ADR-0036 |
| F8 | One design system: tokens, `@guanxi/ui`, a live catalog in the product (no Developer-mode gate since owner feedback 2026-10-23) plus Storybook, owner approvals recorded and signed by the app, gates that fail on seeded violations; unapproved components block releases (D-137, D-138). | Must | DS1 | [ADR-0034](../decisions/0034-design-system-tokens-catalog-and-gates.md) |
| F9 | The brand (logo, 關係 lockup, colours, IBM Plex, voice and tone) is applied consistently in product, docs and exports (D-126–D-130). | Should | DS1, U1 | [BRAND](../design/BRAND.md) |

## G. Models workbench (multimodal)

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| G1 | A Models section with catalogs (Hugging Face, Ollama, others), search by type and modality; downloads show bytes, speed, ETA and a resumable state. | Must | W1 | ADR-0031 |
| G2 | The composer adapts to the selected models' input modalities (for example image-only input hides the text box). | Must | W2 | ADR-0031 §9 |
| G3 | Expose every parameter a model supports, with recommended settings; the harness adds no hidden limits. | Must | W2 | ADR-0031 §9 |
| G4 | Preview media results; edit images. | Should | W3 | ADR-0026 |
| G5 | Compose models: an LLM writes the prompt an image model renders; STT dictates a prompt for a video model; several models in one session. | Should | W2 | ADR-0021 |
| G6 | Batch jobs, for example eight hours of MP3 through a local Whisper into text files in a chosen folder. | Should | W3 | ADR-0019 |
| G7 | A new user downloads a local image model and generates a picture within ten minutes on a supported machine. | Could | W2 | none yet |

## H. Tools and capabilities

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| H1 | The standard tool set of other harnesses: web search (several backends, subscription-dependent), fetch, files, shell. | Must | K4 | ADR-0021 |
| H2 | Computer use (browser, apps, own cursor) that does not disturb the user working at the same time (tiers 0–3); the real cursor only while the user is idle (tier 4). | Should | C1–C3 | [ADR-0029](../decisions/0029-computer-use-tiers.md) |
| H3 | Connect MCP servers, sandboxed and off by default. | Must | P1 | ADR-0022 §9 |
| H4 | Skills and project instructions (Agent Skills standard, AGENTS.md) with progressive disclosure. | Must | P1 | ADR-0022 §10 |
| H5 | Index project knowledge per worktree when it measurably helps (benchmarked). | Could | X1, X2 | [ADR-0030](../decisions/0030-project-knowledge-indexing.md) |
| H6 | Parallel agents in separate worktrees never collide on ports, containers, databases or heavy CPU slots. | Must | F3 | ADR-0018 |
| H7 | A built-in agents' browser with product preview: the user watches, takes over and hands back; Read-only runs cannot submit, upload or download (D-139). | Should | C1 | [ADR-0035](../decisions/0035-agent-browser-and-site-sessions.md) |
| H8 | Agents use the user's site accounts only per granted site: login inside Guanxi, the Guanxi Bridge extension, or delegated live Chrome; bookmarks and history from files; passwords by reference; no bulk cookie import (D-140). | Should | C4 | ADR-0035 |

## I. Voice

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| I1 | Dictation with a choice of backend (on-device, whisper.cpp on another machine, a paid API): desktop and web first, phone through the PWA, then native apps. | Must | V1, U4, U5 | [ADR-0028](../decisions/0028-voice-and-glossary.md) |
| I2 | A per-project glossary with automatic replacement; voice-originated prompts are marked; audits learn new glossary entries from past sessions through a gate. | Must (glossary, marks), Should (learning) | V1, V2 | ADR-0028 |
| I3 | A voice mode on the phone. | Could | U5 | ADR-0026 |

## J. Observability and cost

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| J1 | Full trace, telemetry and observability; the inspector UI and the agent query tool read the same log (reasoning only for local agents). | Must | K2 | ADR-0023 |
| J2 | Balances and costs are visible and attributed per connection (K3), per run (R1) and per account (U3). | Must | K3, R1, U3 | ADR-0017 |
| J3 | Every usage window (5-hour, weekly, daily, monthly) and balance warns at 20%, 10% and 5% remaining, once per window, plus a forecast warning when the burn rate exhausts it before the reset or before dependent runs finish (D-123). | Must | NC1 | [ADR-0033](../decisions/0033-notification-center-and-quota-alerts.md) |
| J4 | One notification center per account with actions: open, add a prompt, accept the recommended action or choose another, wake dependent leads, switch a role to a fallback connection, pause runs, snooze. Automatic reactions only when the run policy names them (D-124). | Must | NC1 | ADR-0033 |
| J5 | Notifications reach the user in the app, as operating-system notifications and as phone push, with content-free push payloads (D-125). | Must (app, OS), Should (phone) | NC1, U4 | ADR-0033 |
| J6 | A process view per agent and sub-agent (shells, containers, browser contexts, dev servers with ports, leases) with Open and Finished lists and Stop/Kill; exact per-machine power and battery, per-agent energy as an estimate with confidence (D-134). | Must (processes), Should (energy) | K4 (shells), F3 (containers, leases), U1 (block) | [LAYOUT_AND_SCREENS](../design/LAYOUT_AND_SCREENS.md) |

## K. Self-evolving harness

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| K1 | Audits run on a button, a schedule, every N sessions or tool calls, or by sampling. | Must | E1 | [ADR-0024](../decisions/0024-self-evolution-loop.md) |
| K2 | Audits read prompts, agent messages, visible reasoning (local auditors only), tool calls and user interventions, and find friction, odd workarounds and missed capabilities. | Must | E1 | ADR-0024 |
| K3 | Findings become changes at the project level, the local harness level, or as an upstream pull request; glossary updates included. | Must | E2–E5 | ADR-0024 |
| K4 | The loop can implement a sandboxed plugin that follows the design system, ship it and restart the harness while idle. | Should | E4 | ADR-0024 |
| K5 | Every automatic change passes a pre-apply gate sized to its risk class (RC0: eval set or smoke suite; RC1: project smoke suite; RC2–RC3: benchmark A/B and canary); in-process code changes need an owner-approved pull request (D-117). | Must | E2 | ADR-0024, [ADR-0025](../decisions/0025-bench-stage-and-ab-gate.md) |
| K6 | Friction per 100 sessions is tracked by category and trends down release over release. | Should | E1 | ADR-0024 |

## L. Non-functional

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| L1 | Open source (Apache-2.0); reused code is attributed in `THIRD_PARTY_NOTICES.md`; dependency licenses pass the license gate. | Must | S0 | [ADR-0016](../decisions/0016-licensing-and-third-party-reuse.md) |
| L2 | Each stage's exit gate states its performance budgets (latency, memory) and passes a security review; a load test of the node runs before MS2. | Must | every stage | none yet (budgets set per stage gate) |
| L3 | Non-obvious design choices cite a paper or an industry standard. | Must | every stage | [research](../research/README.md) |
| L4 | Documentation, code comments and commits are in English; no secrets or private data enter the public history. | Should | every stage | ADR-0016, D-103, D-120 |
| L5 | The harness is light: it orients the model and adds scaffolding only when the benchmark shows a gain (D-110). | Must | B1 | ADR-0025 |

## M. Benchmarks

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| M1 | A headless `guanxi agent exec --json` entry point that benchmark runners can drive. | Must | K4 | ADR-0025 |
| M2 | A private benchmark built from real repositories: roll back before a merged PR (or a series), let the agent implement it, grade by hidden tests (the gate), with diff review and plan-level judging always reported as guardrail metrics (D-119). | Must | B2 | ADR-0025 |
| M3 | Paired A/B comparisons with confidence intervals, cost and time metrics, and per-model-tier reporting. | Must | B1 | ADR-0025 |
| M4 | A relay benchmark proving that quality per cycle does not trend down. | Must | B3 | ADR-0020 |
| M5 | Benchmarks run as a recurring stage on the fleet within budgets (free local models first, then cheap APIs, then subscriptions). | Should | B2 | ADR-0025 |

## N. States and failures

| ID | Requirement | Pri | Stage | Design |
| --- | --- | --- | --- | --- |
| N1 | Capability, fit, balance and runtime status always show source, observation time and confidence, or `unknown`. | Must | K3, W1 | ADR-0017, ADR-0031 |
| N2 | Work survives closing clients, a sleeping laptop and network loss: it continues, waits, or is reported as interrupted, and is never silently lost or duplicated. | Must | R1, F1 | ADR-0019, ADR-0018 |
| N3 | Offline, unreachable and degraded states are visible with what the user can do next (for example `home_unreachable`, `judge_unavailable`, `lead_unavailable`). | Must | F1, R3 | ADR-0018, ADR-0019, ADR-0020 |
