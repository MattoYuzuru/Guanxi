# Open questions

**Status:** proposed (owner answers needed) · **Updated:** 2026-10-19

Each question names the stage it blocks and a recommended default. A stage may start with the
default when the owner has not answered, and must record that it did. Answers move into a new
owner decision record. Legacy questions `Q-1`–`Q-37` are in
[`docs/legacy/alamo/plans/OPEN_QUESTIONS.md`](../legacy/alamo/plans/OPEN_QUESTIONS.md).

| ID | Question | Blocks | Recommended default |
| --- | --- | --- | --- |
| Q-201 | The brief allows auditors to read secrets. Confirm the design choice that auditors and models never see secret values (D-113)? | K2, K3, E1 | Never; secrets are redacted by exact match. |
| Q-202 | Claude as lead through Claude Code may be billed as extra usage (secondary source, since 2026-04-04), and `-p --bare` may stop reading the subscription login. Accept that risk, or run the lead on an Anthropic API key, or ask Anthropic for approval as an open-source project? | K5, MS1 | Support both; default to Claude Code; show the billing state. |
| Q-203 | Which ChatGPT plan is used? Plan usage for Business is not confirmed in the docs. Is computer use on Guanxi's own tools acceptable instead of OpenAI's hosted tool? | K5, C1 | Plus/Pro via Sign in with ChatGPT; own computer-use tools. |
| Q-204 | Is there a Google AI Pro/Ultra plan worth integrating through the closed Antigravity CLI, or is Gemini API-key only? | K5 | API key only. |
| Q-205 | May "unattended" connections be unlocked by the node key so background runs work without an interactive login? | K3, R1 | Yes, per connection, off by default. |
| Q-206 | Private network: hosted Tailscale (free personal plan, non-commercial, up to 6 users) or self-hosted Headscale on the VPS? | F1 | Tailscale first; Headscale documented. |
| Q-207 | Should installing a model on a remote node become a durable node-owned run (changes the legacy rule that pulls are connection-owned)? | F2, W1 | Yes, with resumable download. ADR-0031 and W1 build on this default until confirmed. |
| Q-208 | May Guanxi keep Macs and the Windows PC awake while they hold leases? Use Wake-on-LAN? | F2 | Power assertion while leases are active; WoL opt-in. |
| Q-209 | Cloud rental: monthly cap, per-launch cap, providers (RunPod, Vast, Modal), SkyPilot yes/no? | F4 | $0 until set; RunPod v2 adapter first. |
| Q-210 | Monthly API budget for benchmarks: about $200 (biweekly full A/B on DeepSeek Flash, smokes, free nightly local runs) or $300–450 (weekly full A/B, some V4-Pro)? | B1, B2 | $200. |
| Q-211 | Which hosts may run untrusted benchmark containers: Windows PC (WSL2 Docker), Linux VPS (x86_64, 200–300 GB disk)? | B1 | Windows PC under WSL2. |
| Q-212 | Which repositories form the private benchmark? Any never-published private repositories (best holdout)? | B2 | Guanxi plus one or two owner repositories. |
| Q-213 | Can the owner label 50–100 trials at the start and 20–30 per month for judge calibration? | B2 | 50 at start, 20 per month. |
| Q-214 | When an editor prompts in someone else's shared session, whose connections and budget pay? | U3 | The owner's only if allowed; otherwise the editor's. |
| Q-215 | Can an admin ever read other users' sessions (for example children in a family)? | U3 | No; privacy is absolute in the UI. |
| Q-216 | Will the project hold an Apple Developer account and run a push relay for native iOS? | U5 | Decide after the PWA. |
| Q-217 | Audio retention period; will the owner record ~100 phrases (~20 minutes) for the STT eval set; which cloud STT vendors may receive the glossary; how to write inflected English terms in Russian speech? | V1 | Keep audio 7 days; record the set; no cloud glossary sharing by default. |
| Q-218 | May a relay executor apply small plan amendments, or only propose them? | R2 | Propose only. |
| Q-219 | Night wake policy: which events wake the lead immediately, which wait until morning; quota for advisor/L3 per night? | R3 | Failures and input_required immediately; completions batched until 08:00; 3 L3 reviews per night. |
| Q-220 | L2 judge model: the same local model, a separate small local model, or cheap API (DeepSeek)? | R3 | A different local model family if available, else DeepSeek Flash. |
| Q-221 | Do lessons become project skills automatically or only after the lead reviews them? | R3, E2 | After lead review (risk class RC1). |
| Q-222 | Computer-use tiers 3–4 on the main MacBook, or only on the Mac Mini/Studio? Use the live browser profile? | C3 | Only on Mini/Studio; no live profile. |
| Q-223 | Windows edition (Pro or Home)? Is WSL2 acceptable for vLLM/SGLang and benchmark containers? | C2, F3, B1 | Assume Pro; WSL2 acceptable. |
| Q-224 | Is pooling Mac Studio + Mac Mini over Thunderbolt 5 (RDMA, enabled from Recovery) wanted for models larger than 256 GB? | W2 | Not now. |
| Q-225 | May subscriptions (Claude Code, Codex) be used for automated benchmark runs, and what share of quota? | B2 | Only on a 30-task subset weekly. |
| Q-226 | Publish benchmark tasks and results? | B2 | Publish aggregates only; never canary-marked or GPL task content. |
| Q-227 | Is a Python tool (Harbor) acceptable as an external process next to the TypeScript monorepo? | B1 | Yes. |
| Q-228 | Mobile: is a PWA enough at first; later Capacitor (code reuse) or Expo (background voice)? | U4, U5 | PWA first; Expo after a voice spike. |
| Q-229 | Should embeddings (L3 index) ship in the first indexing slice or stay behind a flag until the A/B? | X1 | Behind a flag. |
| Q-230 | Which machine should be the default always-on home for long lead sessions and phone access: Mac Mini or VPS? | F1, U4 | Mac Mini (private data stays home); VPS as relay. |
| Q-231 | **Answered by D-122 (empty list).** Which actions, if any, should stop a run for confirmation (`requires_confirmation`, D-118)? Candidates: cloud launches, publishing packages, pushing to a protected remote branch, sending messages. | K4, F4 | Empty list; cloud spend is already capped by the budget ledger. |
| Q-232 | **Answered by D-121 (both, REST).** Jira Cloud or Jira Data Center (Data Center has no official MCP server, so it needs a REST adapter)? | WG2 | Support both through REST; MCP only for Cloud. |
| Q-233 | Where does the business backlog live: in GitHub/Jira (Guanxi mirrors execution state) or in Guanxi itself? | WG1, WG2 | In the external tracker when one is linked; in Guanxi otherwise. |
| Q-234 | May agents create new work items without approval, or only propose them? | WG1 | Propose; the lead or the user accepts. |
| Q-235 | Until the WL-series A/B decides: plan tool off for frontier models and on with periodic recitation for local small models? | K4, WG1 | Yes. |
| Q-236 | Commit the Markdown projection of the board (`.guanxi/work/*.md`) to the project repository? | WG1 | No; export on demand. |
| Q-237 | Read external trackers by polling (every 5–15 minutes) or add a relay plugin for webhooks? | WG2 | Poll every 10 minutes. |
| Q-238 | Default WIP limits: how many parallel executors per project and how long a review queue? | WG1 | Derived from free worktree leases and governor permits; review queue of 3 per person. |
