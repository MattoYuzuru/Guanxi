# Research — 2026-10-19 landscape

**Status:** locally validated research (web sources accessed 2026-10-19) · **Language of raw
reports:** Russian (D-120: raw evidence keeps its original language; this English synthesis is
canonical; raw reports are excluded from `npm run lint:md` and kept as written)

Seven research lanes (2026-10-19) and four design lanes (2026-10-20, raw reports in English) examined what to reuse for Guanxi. Each raw report marks every
claim as **[V]** (checked in a primary source: repository, LICENSE file, official docs,
paper) or **[I]** (inference), and ends with numbered sources with access dates. This page is
the English synthesis; the raw reports are the evidence.

| Lane | Raw report | Scope |
| --- | --- | --- |
| 1 | [01-harness-core.md](2026-10-19-landscape/01-harness-core.md) | Harness bases, agent loops, providers, subscriptions, standards, secrets |
| 2 | [02-plugins-ui-sync.md](2026-10-19-landscape/02-plugins-ui-sync.md) | Plugin kernel, shells, design system, accounts, multi-device sync |
| 3 | [03-compute-fabric.md](2026-10-19-landscape/03-compute-fabric.md) | Runtimes, model catalog and fit, fleet scheduling, durable execution, observability |
| 4 | [04-long-horizon.md](2026-10-19-landscape/04-long-horizon.md) | Context management, relay handoff, planner/executor, multi-agent, judges, ETA |
| 5 | [05-self-evolve-voice-cu.md](2026-10-19-landscape/05-self-evolve-voice-cu.md) | Self-evolution, STT glossary, computer use, indexing, evals |
| 6 | [06-benchmarks.md](2026-10-19-landscape/06-benchmarks.md) | Benchmark construction, grading, A/B statistics, harness minimalism |
| 7 | [07-work-methodology.md](2026-10-19-landscape/07-work-methodology.md) | Agent work methodology, plan/todo tools, native work board vs external trackers |
| D1 | [01-harness-ui-patterns.md](2026-10-20-design/01-harness-ui-patterns.md) | UI of Claude Code, Codex, DeepSeek Harness, Cursor, Zed, Goose, Warp and others; screen inventory; interaction principles; glass accessibility |
| D2 | [02-design-system-tooling.md](2026-10-20-design/02-design-system-tooling.md) | Tokens (DTCG, Style Dictionary), catalog (Storybook and in-app), gates, approvals, motion |
| D3 | [03-typography-and-identity.md](2026-10-20-design/03-typography-and-identity.md) | Fonts and scripts, AI-generic looks to avoid, three identity directions with computed palettes |
| D4 | [04-agent-browser-and-layout.md](2026-10-20-design/04-agent-browser-and-layout.md) | Agentic browsers, session import limits and design, docking layout engines, layout schema |

Paths inside the raw reports refer to the repository layout before the 2026-10-19 move of
Alamo docs into `docs/legacy/alamo/`.

## Headline findings

1. **"DeepSeek Harness" is real and open.** `deepseek-ai/deepseek-harness` — MIT, TypeScript,
   about 254k stars, created 2026-08-13, developer preview `dsh-v0.2.1-rc.2`. It is built on
   **Cordis** (MIT, about 9k stars; paper arXiv:2608.25512) and follows "Everything is a
   Plugin": agent loop, providers, tools, compaction and UI are plugins; typed UI slots;
   lossless append-only session log with an inspector. It accepts no external pull requests and
   announces breaking changes. Guanxi copies from it but does not depend on it (D-108).
2. **Subscriptions.** Anthropic forbids Claude Free/Pro/Max OAuth tokens in other products,
   including the Agent SDK; the only compliant path is the user's own unmodified `claude`
   binary. OpenAI publishes "Sign in with ChatGPT" for open-source and local apps plus the
   Codex app-server. Google moved consumer plans to a closed CLI; Gemini is API-key only in
   practice. GitHub offers the Copilot SDK (MIT) and `copilot --acp`.
3. **No existing node agent covers an Apple + Windows + Linux personal fleet.** GPUStack v2 is
   Linux-only, LocalAI's distributed mode needs PostgreSQL and NATS, Xinference has no auth by
   default, exo is Apple-only. Guanxi writes a thin TypeScript node agent and drives native
   runtimes through adapters.
4. **No embedded durable-execution engine fits.** Temporal's SQLite mode is dev-only, Restate is
   BSL, Inngest SSPL, DBOS TypeScript Postgres-only. Guanxi extends its own SQLite event store
   with attempts, leases, promises, timers and an outbox, borrowing the semantics.
5. **Relay handoff must be ledger-first.** Free-form summaries lose the artifact trail (Factory:
   2.2–2.45 of 5) and drift across cycles (ACE, Amp). The handoff is about 70% harness-kept
   ledger, plus append-only agent notes, plus a short narrative written fresh each cycle.
6. **Small models need small, checkable tasks.** METR has not measured any open-weight model at
   80B or below; gpt-oss-120b reaches about 45 minutes at 50% success. Items must be minutes of
   human work, each with an acceptance command.
7. **Self-improvement works best on text first.** Skill and playbook evolution shows solid
   gains (SkillOpt +19.1 points inside Claude Code; ACE +10.6%); open-ended code evolution is
   expensive (a DGM run costs about $22k) and prone to metric gaming. Evaluator, gate,
   redaction and rollback stay outside what the loop can edit.
8. **Harness effects are small on pass rate but large on cost.** 0–8 points of pass rate versus
   up to 40× token difference; a 50-task × 5-run suite detects only about a 10-point change.
   Efficiency metrics must be part of every gate.

## Reuse register

What Guanxi plans to take, from where, and how. "Copy" means vendoring code with attribution
in `THIRD_PARTY_NOTICES.md`; "Depend" means a package dependency; "Process" means a separate
program the user installs, talked to over a protocol; "Pattern" means design only.

| Area | Source | License | Mode | What exactly |
| --- | --- | --- | --- | --- |
| Plugin kernel | Cordis 4 (`cordis`; DSH's hardened copy only as vendored source, D-108) | MIT | Depend (exact pin, vendor if needed) | Context, services, `inject`, revertible effects, loader, HMR |
| Plugin distribution | DeepSeek Harness | MIT | Copy | Profiles/bundles/patch layers, plugin manager (install, rollback, engine checks), typed UI slots, theme rules |
| Session log and trace | DeepSeek Harness | MIT | Copy + adapt | `SessionHandle` contract (single writer, crash recovery, torn-tail safety), session inspector ideas |
| LLM layer | `pi-ai`, `pi-agent-core` (badlogic/pi-mono) | MIT | Depend | Multi-provider streaming, tool calling, model catalog; Anthropic OAuth module disabled |
| Model metadata | models.dev | MIT | Depend (data) | Prices, limits, capabilities with provenance |
| Agent protocol | ACP v1 (Zed), MCP `2026-07-28`, Agent Skills, AGENTS.md, A2A 1.0 (later) | open specs | Standard | Sub-agent control, tools, skills, project instructions |
| Subscription agents | Claude Code (user's binary), Codex app-server, Copilot SDK / `copilot --acp` | proprietary / Apache-2.0 / MIT | Process | Driven as sub-agents; never bundled |
| Secrets | `@napi-rs/keyring` | MIT | Depend | OS keychain wraps the vault key |
| Accounts | Better Auth (minimal plugins) | MIT | Depend | Email/password, passkey, admin, device authorization, API keys |
| Desktop shell | Electron + electron-builder | MIT | Depend | Thin shell over the user-level service |
| UI kit | shadcn/ui on Base UI, Lucide, assistant-ui, Streamdown, CodeMirror 6, xterm.js, wavesurfer.js, Filerobot + Konva | MIT / ISC / Apache-2.0 / BSD-3 | Copy-in or depend | Components, icons, chat runtime, streaming markdown, editor, terminal, audio, image editing |
| Design tokens | W3C DTCG 2025.10 + Style Dictionary | W3C CG / Apache-2.0 | Standard + depend | Single token source → CSS vars, Tailwind, MCP Apps variables |
| Untrusted plugin UI | MCP Apps (`@modelcontextprotocol/ext-apps`) | Apache-2.0 | Depend | Sandboxed iframe host with theme variables |
| Runtimes | Ollama, llama.cpp server, llama-swap, whisper.cpp, stable-diffusion.cpp, mlx-*, Kokoro-FastAPI | MIT / Apache-2.0 | Process | Tier-1 adapters |
| GPL runtimes | ComfyUI (GPL-3.0) | GPL-3.0 | Process only | Optional Tier-2 adapter, never bundled |
| Model catalog | Hugging Face Hub API, `@huggingface/gguf` | Apache-2.0 / MIT | Depend | Search by task/format, remote GGUF headers for fit |
| Durable semantics | Temporal timeouts, Absurd "first emit wins", Restate/Resonate durable promises | MIT (Temporal), Apache-2.0 (Absurd, Resonate), BSL (Restate: pattern only, no code) | Pattern | Attempts, timers, promises |
| Handoff | Codex, OpenCode, OpenHands condenser, Goose, Cline | Apache-2.0 / MIT | Pattern + selective copy | Handoff schema, stuck detector thresholds |
| Remote access | Tailscale or Headscale | BSD-3 | Process | Private network and TLS for remote clients |
| DR backup | Litestream | Apache-2.0 | Process | WAL streaming backup on macOS/Linux nodes |
| Sandbox | Anthropic `sandbox-runtime` (Seatbelt, bubblewrap) | Apache-2.0 | Depend | OS-level sandbox for tools and untrusted plugins |
| Computer use | Playwright MCP, Chrome DevTools MCP, Lume, Cua Driver | Apache-2.0 / MIT | Process / depend | Browser tier, VM tier, accessibility tier |
| Evals | Harbor, Inspect AI, promptfoo, mini-swe-agent | Apache-2.0 / MIT | Depend / process | Task format and runner, statistics, prompt unit tests, minimal baseline |
| Redaction | secretlint, gitleaks | MIT | Depend / process | Secret scrubbing before audits |

## Rejected or restricted

| Candidate | Reason |
| --- | --- |
| Fork of OpenCode | Bun + Effect 4 + SolidJS stack; constant V2 rework |
| Fork of Goose, Codex | Rust core; Codex has a CLA |
| Crush | FSL-1.1 (not open source until conversion) |
| Open WebUI, LobeHub | Non-OSI custom licenses; ideas only |
| Cherry Studio, Chatbox, Claude Squad | AGPL/GPL; incompatible with Apache-2.0 copying and the App Store |
| tldraw | Production license key required |
| Arize Phoenix | Elastic License 2.0 |
| Nomad, Restate, Inngest | BUSL / BSL / SSPL |
| GPUStack as node agent | Linux-only workers |
| Serena (v2+) | GPL-3.0; use LSP directly or as a separate process |
| OmniParser `icon_detect`, trufflehog | AGPL; separate process only |
| Task Master | MIT + Commons Clause |
| Claude Agent SDK as a core dependency | Proprietary terms; optional user-installed adapter only |
| Multi-master CRDT for jobs and leases | Stop and permits do not commute; replaced by single-writer ownership (ADR-0018) |

## Open research items

- Kernel spike: Cordis 4 RC stability under 100 plugin reload cycles (ADR-0015).
- Relay benchmark: does ledger-first relay beat naive summary on 20 multi-cycle tasks (ADR-0020)?
- Effective context length calibration per model and quantization.
- Apple GPU telemetry without private APIs.
- Expo vs Capacitor for background voice on the phone.
- Whether L3 embeddings improve localization on the owner's repositories (ADR-0030).
