# Owner decisions — 2026-10-20 addendum (open questions)

**Status:** accepted · **Date:** 2026-10-20 · **Decisions:** D-141–D-184
**Extends:** [2026-10-20](2026-10-20-owner-decisions.md).

The owner was asked every open question from [OPEN_QUESTIONS](../plans/OPEN_QUESTIONS.md)
(Q-201–Q-230, Q-233–Q-244) in chat, each with a recommended default, and accepted all of them.
Q-231 and Q-232 were answered earlier by D-122 and D-121. These answers let stages start
without stopping to ask the owner. A stage that needs a different answer raises a new
question.

Mapping: D-141–D-170 answer Q-201–Q-230 in order; D-171–D-182 answer Q-233–Q-244 in order.

## Models, connections and secrets

| ID | Question | Decision |
| --- | --- | --- |
| D-141 | Q-201 | Auditors and models never see secret values. The harness redacts every known secret by exact match in model context, logs, traces, exports and audit views. This confirms the secrets part of D-113. |
| D-142 | Q-202 | Claude as lead runs through **Claude Code by default** and through an Anthropic API key as the alternative; both are supported. The connection shows its billing state (subscription, extra usage or API) with source and age. The owner accepts the risk that harness use of Claude Code is billed as extra usage or that `-p --bare` stops reading the subscription login; the API key is the fallback. |
| D-143 | Q-203 | ChatGPT is used on **Plus/Pro through Sign in with ChatGPT** in the official Codex CLI; Business is not targeted. Computer use runs on Guanxi's own tools, not OpenAI's hosted computer-use tool. |
| D-144 | Q-204 | Gemini through an **API key only**; no integration through the closed Antigravity CLI. |
| D-145 | Q-205 | A connection may be marked `unattended` so the node key unlocks it for background runs without an interactive login; per connection, **off by default**, visible on Connections. |

## Fleet and hardware

| ID | Question | Decision |
| --- | --- | --- |
| D-146 | Q-206 | Private network: **hosted Tailscale** (free personal plan) first; self-hosted Headscale on the VPS stays documented as the alternative. |
| D-147 | Q-207 | Installing a model on a node is a **durable node-owned run with resumable download** (stages F2, W1). This replaces the legacy rule that pulls are connection-owned for the target design; the legacy code keeps connection-owned pulls until those stages land. |
| D-148 | Q-208 | Guanxi keeps the Macs and the Windows PC awake with a **power assertion while they hold or grant active leases or have pending timers**. Wake-on-LAN is opt-in per node. |
| D-149 | Q-209 | Cloud rental budget is **$0 until the owner sets** monthly and per-launch caps. The first adapter is RunPod (v2 API); Vast, Modal and SkyPilot only if a later need appears. |
| D-162 (amended by D-185, ADR-0038 §9) | Q-222 | Computer-use tiers 3–4 run **only on the Mac Mini and Mac Studio**, never on the main MacBook, and never use the live browser profile. |
| D-163 | Q-223 | The Windows PC is assumed to run **Windows Pro**; WSL2 is acceptable for vLLM/SGLang and benchmark containers. |
| D-164 (obsolete, D-185) | Q-224 | No Thunderbolt 5 pooling of Mac Studio and Mac Mini now; revisit when a model larger than 256 GB is needed. |
| D-170 (superseded by D-186) | Q-230 | The **Mac Mini is the default always-on home** for long lead sessions and phone access, so private data stays at home; the VPS is a relay. |

## Benchmarks

| ID | Question | Decision |
| --- | --- | --- |
| D-150 | Q-210 | API budget for benchmarks: **$200 per month** (biweekly full A/B on DeepSeek Flash, smokes, free nightly local runs). |
| D-151 | Q-211 | Untrusted benchmark containers run on the **Windows PC under WSL2 Docker**; the VPS is not a default benchmark host. *Amended by D-194 (2026-10-21): the Fedora PC in rootless Podman under a dedicated user.* |
| D-152 | Q-212 | The private benchmark uses **Guanxi plus one or two owner repositories**, named by the owner when B2 starts; never-published repositories are preferred as the holdout. |
| D-153 | Q-213 | The owner labels **50 trials at the start and about 20 per month** for judge calibration. |
| D-165 | Q-225 | Subscriptions (Claude Code, Codex) run automated benchmarks **only on a 30-task subset once a week**; everything else uses API keys or local models. |
| D-166 | Q-226 | Publish **aggregate results only**; never publish canary-marked or GPL task content. |
| D-167 | Q-227 | Harbor (Python) is acceptable as an external process next to the TypeScript monorepo. |

## Accounts, clients and voice

| ID | Question | Decision |
| --- | --- | --- |
| D-154 (amended by D-190) | Q-214 | When an editor prompts in someone else's shared session, the **session owner's connections and budget pay only if the owner allowed it** for that share; otherwise the editor's own connections pay. |
| D-155 | Q-215 | An admin can **never read other users' sessions** in the UI, including in a family setup; there is no admin override. |
| D-156 | Q-216 | Whether to hold an Apple Developer account and run a native push relay is decided **after the PWA** ships (U5). |
| D-157 | Q-217 | Audio is kept **7 days**; the owner records the STT eval set (about 100 phrases, 20 minutes); the glossary is **not sent to cloud STT vendors** by default (per-connection consent, ADR-0028). Inflected English terms in Russian speech are written as the canonical Latin-script term with the Russian ending after a hyphen (`PR-а`, `worktree-ах`); V1 may revise this from the eval set with the owner's review. |
| D-168 | Q-228 | Mobile: **PWA first; Expo** after a background-voice spike. Capacitor is not planned. |

## Relay, judge and self-evolution

| ID | Question | Decision |
| --- | --- | --- |
| D-158 | Q-218 | A relay executor **only proposes** plan amendments; the lead accepts them. |
| D-159 | Q-219 | Night wake policy: failures and `input_required` wake the lead **immediately**; completions are batched until **08:00** local time; at most **3 L3 reviews per night**. A run policy may override these. |
| D-160 | Q-220 | The L2 judge is a **local model of a different family** from the executor when one is available; otherwise DeepSeek Flash. |
| D-161 | Q-221 | Lessons become project skills **only after the lead reviews them** (risk class RC1). |

## Work ledger

| ID | Question | Decision |
| --- | --- | --- |
| D-171 | Q-233 | The business backlog lives **in the external tracker when one is linked**, in Guanxi otherwise; Guanxi mirrors execution state. |
| D-172 | Q-234 | Agents **propose** new work items; the lead or the user accepts them. |
| D-173 | Q-235 | Until the WL-series A/B decides: the plan tool is **off for frontier models** and **on with periodic recitation for small local models**. |
| D-174 | Q-236 | The Markdown projection of the board (`.guanxi/work/*.md`) is **not committed**; it is exported on demand. |
| D-175 | Q-237 | External trackers are read by **polling every 10 minutes**; a webhook relay plugin only if polling proves insufficient. |
| D-176 | Q-238 | WIP limits are **derived from free worktree leases and governor permits**; the review queue holds **3 items per person**. |

## Design, browser and indexing

| ID | Question | Decision |
| --- | --- | --- |
| D-169 | Q-229 | Embeddings (index level IX3) stay **behind a flag** until the localisation A/B (stage X2). |
| D-177 | Q-239 | Guanxi **outlines the production wordmark itself** from IBM Plex Sans with adjustments that echo the logo diagonal; the owner approves it in the catalog. Revisit (type designer) before a public release. |
| D-178 | Q-240 | The Guanxi Bridge extension is distributed **unpacked for developers first**; Chrome Web Store publication (privacy disclosure, limited-use review) happens **before MS2**. |
| D-179 | Q-241 | Agents may use **delegated control of the live Chrome on the main MacBook**, per site, with a visible indicator and one-click stop. This is a browser grant (ADR-0035), not computer-use tier 3–4 (D-162). |
| D-180 | Q-242 | BrowserOS neo is **not offered** now. |
| D-181 | Q-243 | Guanxi offers a one-click `requires_confirmation` **preset for runs that use imported site sessions** (purchases, sending, deleting, credential changes, OAuth consent, uploads), **off by default** (D-122 stays the default). |
| D-182 | Q-244 | Imported site sessions **never reach rented cloud machines by default**; a run may allow it only when its policy names the site, and then only as per-attempt expiring grants. |

## Kernel (after the K1 spike, later the same day)

The K1 lane built the Cordis facade and met every budget: 100 reload cycles without leaks,
object heap +2.02%, boot about 50 ms, 88 MB RSS. Five facade workarounds contained the known
upstream lifecycle races. Those races are still open upstream as unmerged pull requests
(cordiverse/cordis #96, #185, #91, #194, #218), which literally meets ADR-0015 rejection
criterion 3. The lane and the architecture review recommended accepting Cordis with an amended
criterion.

| ID | Topic | Decision |
| --- | --- | --- |
| D-183 | Kernel | **Reject Cordis; build the own kernel** that ADR-0015 names as the fallback: about 1–2k lines with Cordis semantics (context tree, services, inject, effects with disposers, events, plugin lifecycle, profiles and patch layers, manifest), designed so the upstream race classes cannot occur, behind a Guanxi-owned `PluginContext` facade. Every K1 exit-gate test stays and must pass against the own kernel. The owner chose this over "accept with an amended criterion" and "accept until P1". A superseding ADR-0037 records the design. |

## Approval key custody (after the DS1-b review)

| ID | Topic | Decision |
| --- | --- | --- |
| D-184 | Approval signing | The approval key moves into a separate code-signed **signing helper** outside the checkout that asks for Touch ID or the password on every signature and names the component and hash in the prompt (stage DS2). It is built right after DS1 merges, before the owner approves any component; until then the owner approves nothing and never chooses "Always Allow" on a keychain prompt. Chosen over accepting the risk until the first release and over taking an Apple Developer account now. |
