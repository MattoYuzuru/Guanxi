# Open questions

**Status:** accepted (one K5 default open) · **Updated:** 2026-10-21

New questions go under **Open** with the stage they block and a recommended default. A stage
may start with the default when the owner has not answered, and must record that it did.
Answers move into a new owner decision record. Legacy questions `Q-1`–`Q-37` are in
[`docs/legacy/alamo/plans/OPEN_QUESTIONS.md`](../legacy/alamo/plans/OPEN_QUESTIONS.md).

## Open

The owner answered the earlier questions below on 2026-10-20. One K5 default awaits an answer.

| ID | Question | Blocked | Answer |
| --- | --- | --- | --- |
| Q-245 | The editor payment grant is connection-wide and has no expiry (K5 default, 2026-10-21). Should it be scoped per share or project, with an expiry? | K5, U3 | K5 default: connection-wide, no expiry; owner answer pending. |

## Answered

Answers: D-121 and D-122 in the
[2026-10-19 addendum](../decisions/2026-10-19-owner-decisions-addendum.md); D-141–D-182 in the
[2026-10-20 addendum](../decisions/2026-10-20-owner-decisions-addendum.md), where each answer is
stated in full.

| ID | Question | Blocked | Answer |
| --- | --- | --- | --- |
| Q-201 | The brief allows auditors to read secrets. Confirm the design choice that auditors and models never see secret values (D-113)? | K2, K3, E1 | D-141: Never; secrets are redacted by exact match. |
| Q-202 | Claude as lead through Claude Code may be billed as extra usage (secondary source, since 2026-04-04), and `-p --bare` may stop reading the subscription login. Accept that risk, or run the lead on an Anthropic API key, or ask Anthropic for approval as an open-source project? | K5, MS1 | D-142: Support both; default to Claude Code; show the billing state. |
| Q-203 | Which ChatGPT plan is used? Plan usage for Business is not confirmed in the docs. Is computer use on Guanxi's own tools acceptable instead of OpenAI's hosted tool? | K5, C1 | D-143: Plus/Pro via Sign in with ChatGPT; own computer-use tools. |
| Q-204 | Is there a Google AI Pro/Ultra plan worth integrating through the closed Antigravity CLI, or is Gemini API-key only? | K5 | D-144: API key only. |
| Q-205 | May "unattended" connections be unlocked by the node key so background runs work without an interactive login? | K3, R1 | D-145: Yes, per connection, off by default. |
| Q-206 | Private network: hosted Tailscale (free personal plan, non-commercial, up to 6 users) or self-hosted Headscale on the VPS? | F1 | D-146: Tailscale first; Headscale documented. |
| Q-207 | Should installing a model on a remote node become a durable node-owned run (changes the legacy rule that pulls are connection-owned)? | F2, W1 | D-147: Yes, with resumable download. |
| Q-208 | May Guanxi keep Macs and the Windows PC awake while they hold leases? Use Wake-on-LAN? | F2 | D-148: Power assertion while leases are active; WoL opt-in. |
| Q-209 | Cloud rental: monthly cap, per-launch cap, providers (RunPod, Vast, Modal), SkyPilot yes/no? | F4 | D-149: $0 until set; RunPod v2 adapter first. |
| Q-210 | Monthly API budget for benchmarks: about $200 (biweekly full A/B on DeepSeek Flash, smokes, free nightly local runs) or $300–450 (weekly full A/B, some V4-Pro)? | B1, B2 | D-150: $200. |
| Q-211 | Which hosts may run untrusted benchmark containers: Windows PC (WSL2 Docker), Linux VPS (x86_64, 200–300 GB disk)? | B1 | D-151: Windows PC under WSL2; amended by D-194: the Fedora PC in rootless Podman under a dedicated user. |
| Q-212 | Which repositories form the private benchmark? Any never-published private repositories (best holdout)? | B2 | D-152: Guanxi plus one or two owner repositories. |
| Q-213 | Can the owner label 50–100 trials at the start and 20–30 per month for judge calibration? | B2 | D-153: 50 at start, 20 per month. |
| Q-214 | When an editor prompts in someone else's shared session, whose connections and budget pay? | U3 | D-154: The owner's only if allowed; otherwise the editor's. |
| Q-215 | Can an admin ever read other users' sessions (for example children in a family)? | U3 | D-155: No; privacy is absolute in the UI. |
| Q-216 | Will the project hold an Apple Developer account and run a push relay for native iOS? | U5 | D-156: Decide after the PWA. |
| Q-217 | Audio retention period; will the owner record ~100 phrases (~20 minutes) for the STT eval set; which cloud STT vendors may receive the glossary; how to write inflected English terms in Russian speech? | V1 | D-157: Keep audio 7 days; record the set; no cloud glossary sharing by default; inflected English terms as the Latin-script term plus a hyphenated Russian ending. |
| Q-218 | May a relay executor apply small plan amendments, or only propose them? | R2 | D-158: Propose only. |
| Q-219 | Night wake policy: which events wake the lead immediately, which wait until morning; quota for advisor/L3 per night? | R3 | D-159: Failures and input_required immediately; completions batched until 08:00; 3 L3 reviews per night. |
| Q-220 | L2 judge model: the same local model, a separate small local model, or cheap API (DeepSeek)? | R3 | D-160: A different local model family if available, else DeepSeek Flash. |
| Q-221 | Do lessons become project skills automatically or only after the lead reviews them? | R3, E2 | D-161: After lead review (risk class RC1). |
| Q-222 | Computer-use tiers 3–4 on the main MacBook, or only on the Mac Mini/Studio? Use the live browser profile? | C3 | D-162: Only on Mini/Studio; no live profile. |
| Q-223 | Windows edition (Pro or Home)? Is WSL2 acceptable for vLLM/SGLang and benchmark containers? | C2, F3, B1 | D-163: Assume Pro; WSL2 acceptable. |
| Q-224 | Is pooling Mac Studio + Mac Mini over Thunderbolt 5 (RDMA, enabled from Recovery) wanted for models larger than 256 GB? | W2 | D-164: Not now. |
| Q-225 | May subscriptions (Claude Code, Codex) be used for automated benchmark runs, and what share of quota? | B2 | D-165: Only on a 30-task subset weekly. |
| Q-226 | Publish benchmark tasks and results? | B2 | D-166: Publish aggregates only; never canary-marked or GPL task content. |
| Q-227 | Is a Python tool (Harbor) acceptable as an external process next to the TypeScript monorepo? | B1 | D-167: Yes. |
| Q-228 | Mobile: is a PWA enough at first; later Capacitor (code reuse) or Expo (background voice)? | U4, U5 | D-168: PWA first; Expo after a voice spike. |
| Q-229 | Should embeddings (L3 index) ship in the first indexing slice or stay behind a flag until the A/B? | X1 | D-169: Behind a flag. |
| Q-230 | Which machine should be the default always-on home for long lead sessions and phone access: Mac Mini or VPS? | F1, U4 | D-170: Mac Mini (private data stays home); VPS as relay. |
| Q-231 | Which actions, if any, should stop a run for confirmation (`requires_confirmation`, D-118)? Candidates: cloud launches, publishing packages, pushing to a protected remote branch, sending messages. | K4, F4 | D-122: Empty list; cloud spend is already capped by the budget ledger. |
| Q-232 | Jira Cloud or Jira Data Center (Data Center has no official MCP server, so it needs a REST adapter)? | WG2 | D-121: Support both through REST; MCP only for Cloud. |
| Q-233 | Where does the business backlog live: in GitHub/Jira (Guanxi mirrors execution state) or in Guanxi itself? | WG1, WG2 | D-171: In the external tracker when one is linked; in Guanxi otherwise. |
| Q-234 | May agents create new work items without approval, or only propose them? | WG1 | D-172: Propose; the lead or the user accepts. |
| Q-235 | Until the WL-series A/B decides: plan tool off for frontier models and on with periodic recitation for local small models? | K4, WG1 | D-173: Yes. |
| Q-236 | Commit the Markdown projection of the board (`.guanxi/work/*.md`) to the project repository? | WG1 | D-174: No; export on demand. |
| Q-237 | Read external trackers by polling (every 5–15 minutes) or add a relay plugin for webhooks? | WG2 | D-175: Poll every 10 minutes. |
| Q-238 | Default WIP limits: how many parallel executors per project and how long a review queue? | WG1 | D-176: Derived from free worktree leases and governor permits; review queue of 3 per person. |
| Q-239 | Who draws the production wordmark: outline it ourselves from IBM Plex Sans with adjustments to the logo diagonal (the owner approves in the catalog), or commission a type designer? | DS1, U1 | D-177: Outline it ourselves; revisit before a public release. |
| Q-240 | Publish the Guanxi Bridge extension on the Chrome Web Store (privacy disclosure, limited-use review), or distribute it unpacked for developers only? | C4 | D-178: Unpacked first; store publication before MS2. |
| Q-241 | May agents use delegated control of the live Chrome on the main MacBook (Q-222 keeps computer-use tiers 3–4 off it)? | C4 | D-179: Yes, per site, with a visible indicator and one-click stop. |
| Q-242 | Offer BrowserOS neo (AGPL) as an optional external browser connection? | C4 | D-180: Not now. |
| Q-243 | Offer a suggested (still off by default) `requires_confirmation` preset for runs that use imported site sessions (purchases, sending, deleting, credential changes, OAuth consent, uploads)? | C4 | D-181: Offer it as a one-click preset, off by default. |
| Q-244 | May imported site sessions ever reach rented cloud machines, as per-attempt expiring grants? | C4, F4 | D-182: Never by default; per run only if the run policy names the site. |
