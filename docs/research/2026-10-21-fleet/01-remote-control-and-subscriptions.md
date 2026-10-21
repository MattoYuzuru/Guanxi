# Lane 1 — Phone to own-machine coding agents, subscription terms, rate limits

**Raw research report** (D-120). Lane run 2026-10-20/21 by a `discovery-agent:evidence-researcher`.
**[V]** = read in the primary source, **[S]** = secondary source or search snippet, **[I]** =
inference. Not legal advice. Section 4 is input for an owner decision.

## Executive summary

1. **Both vendors cover the basic scenario for their own agent.** Both relay through their own
   servers, neither can be self-hosted, and each works with a single vendor only.
   - **Claude Code Remote Control** works on Pro, Max, Team and Enterprise.
     - In server mode the phone can start sessions on any registered machine; a server process
       allows 32 concurrent sessions by default.
     - Cross-session messaging lets sessions on different machines talk through Anthropic's
       servers [A1, A2].
     - It is not end-to-end encrypted; transcripts are stored by Anthropic [A1].
   - **Codex Remote** has been GA since 2026-06-25.
     - The ChatGPT mobile app controls a Mac or Windows host through an OpenAI relay.
     - Threads can be handed off between machines.
     - An experimental `codex remote-control` command covers headless hosts [O1–O3].
2. **Third-party tools:**
   - **Paseo** is now Apache-2.0 (relicensed from AGPL around 2026-08-27) and is the closest
     analogue to Guanxi.
     - It runs a daemon on each machine and supports several hosts.
     - Its relay is optional and end-to-end encrypted (Curve25519 + NaCl box).
     - It drives Claude through the Agent SDK, Codex through `codex app-server` and the rest
       through ACP [T5–T8].
   - **Happy** (MIT) has a self-hostable end-to-end encrypted relay [T1–T3].
   - **Remodex** (Apache-2.0, branding excluded) has a well-specified end-to-end handshake
     (Ed25519/X25519/HKDF/AES-GCM) [T9].
   - **CloudCLI / Claude Code UI** is AGPL, so it can only run as a separate process [T13].
   - **CodeRemote and Moshi** are proprietary; **Omnara** is closed and not end-to-end
     encrypted [T10, T11, T14, T15].
3. **Anthropic allows the owner's own use of the unmodified binary.** Using his own account and
   his own unmodified `claude` binary, on his own machines, steered from his own phone, is
   documented and supported:
   - the legal page does not prevent "an end user from signing in to the unmodified Claude Code
     binary with their own Claude subscription" [A6];
   - the Help Center (2026-10-07) says the Agent SDK, `claude -p` and third-party apps still draw
     from subscription limits [A12].
4. **Anthropic's hard prohibitions:**
   - offering claude.ai login inside another product;
   - collecting, storing or intermediating Claude credentials;
   - routing other people's requests through a Free, Pro or Max plan;
   - modifying the binary [A6, A7].

   From **2026-11-12**, the Usage Policy also bans "services that route requests through consumer
   subscriptions or misrepresent the product or client being used" [A18].
5. **Anthropic's billing for harness traffic keeps changing:**
   - 2026-04-04: billed as extra usage [S1];
   - 2026-05-13: reversed, with a planned SDK credit [S3];
   - 2026-06-15: that plan paused [A12];
   - 2026-10-07: subscription limits restated [A12].

   "Third-party harness" was never defined.
6. **OpenAI:**
   - App-server authentication with a ChatGPT login "has never been permitted for commercial or
     hosted services". Local and open-source apps may keep using it, though OpenAI recommends
     migrating to **Sign in with ChatGPT** [O4].
   - Sign in with ChatGPT for open-source apps has been self-serve since DevDay 2026-09-29.
     - It supports several hosts per user through `ext_agent_host_id`.
     - It documents moving credentials to the user's own VMs.
     - Preview gaps: `store:false` and no hosted tools [O8–O11].
7. **Limits** are per account and shared by every surface and machine, for both vendors; no
   per-device limits are documented. Neither publishes a concurrency cap. Users report HTTP 429s
   at roughly 2–6 parallel streams on top plans [S10, S14] (low confidence).
8. **The repository is out of date.** These say that Pro/Max OAuth is forbidden "including
   through the Agent SDK" and that harness traffic has been billed as extra usage since
   2026-04-04:
   - ADR-0017, table row 16;
   - the 2026-10-19 owner decisions, lines 38–41;
   - the 2026-10-19 landscape lane 01, lines 43–48 and risk R1.

   Current primary texts are more nuanced (point 3). The `--bare` risk (D-142) still applies
   [A8].

## 1. Products

### Anthropic (proprietary)

| Surface | What | Architecture |
| --- | --- | --- |
| Remote Control | steer local sessions from claude.ai/code or the app. Server mode: `--capacity` (default 32), `--spawn same-dir/worktree/session`, push notifications | outbound HTTPS only, no inbound ports; TLS with short-lived scoped credentials; transcript stored on Anthropic servers, so not end-to-end; Pro, Max, Team, Enterprise; no API keys; Trusted Devices beta [A1] |
| Remote Control limits | exits after about 10 min offline, resumable for about 4 h; refuses wrapper global flags; needs the trust prompt; does not work with `ANTHROPIC_BASE_URL` or with non-essential traffic disabled; `setup-token` cannot start it | [A1, A9] |
| Cross-session messaging | `ListAgents` / `SendMessage` between your own sessions, routed across machines through Anthropic | plain text; cannot approve anything; `isolatePeerMachines` [A2] |
| Cloud sessions, Dispatch, Channels | Anthropic VMs (self-hosted only on Team and Enterprise); phone to Cowork (Pro, Max); Telegram/Discord/iMessage through MCP (preview) | [A3–A5] |

### OpenAI

| Surface | What | Architecture |
| --- | --- | --- |
| Codex Remote / mobile | ChatGPT mobile controls a desktop host (macOS, Windows; Linux in preview); QR pairing; thread handoff | "secure relay layer", host must stay awake; docs advise a VPN or mesh network [O1, O3] |
| `codex remote-control` (experimental) | headless daemon plus pairing code | relay and encryption not documented [O2] |
| SSH remote hosts | the desktop app starts a remote `codex app-server` over SSH | [O1] |
| Codex cloud | per-task cloud workspaces; share the plan allowance | [O6, O7] |
| Licence | `openai/codex` (CLI, app-server) is Apache-2.0; relay, apps and cloud are proprietary | [O14] |

### Third-party tools

| Product | How it drives agents | Relay / NAT | End-to-end | Self-host | Licence | Reuse in Guanxi |
| --- | --- | --- | --- | --- | --- | --- |
| Paseo | Agent SDK (Claude), app-server (Codex), ACP | optional relay; LAN, Tailscale or Cloudflare | Curve25519 + NaCl | yes (incl. Elixir relay) | Apache-2.0 (since ~2026-08-27) | copy with notices; check the provenance of pre-relicense files and npm licence metadata (#7032) [T5–T8] |
| Happy | wraps the CLIs; the newer "Happy Agent" uses the Agent SDK and Pi's Codex transport | outbound WebSocket | NaCl secretbox | yes | MIT | copy the relay design; avoid the Codex token-reuse path [T1–T4] |
| Remodex | `codex app-server` over stdio | self-hosted relay, Tailscale | Ed25519/X25519/HKDF/AES-GCM | yes | Apache-2.0 (no branding) | reference handshake [T9] |
| Omnara | Agent SDK, app-server | its cloud | no | no | closed | little [T10, T11] |
| VibeTunnel | PTY to browser | Tailscale, tunnels | via transport | yes | MIT | terminal fallback [T12] |
| CloudCLI | web UI | direct | — | yes | AGPL | separate process only [T13] |
| CodeRemote, Moshi | — | Tailscale / SSH | — | — | proprietary | none [T14, T15] |
| acp-ui + stdio-to-ws | ACP over WebSocket | dev tunnels | TLS | yes | MIT | remote ACP reference [T16] |

The ACP Streamable HTTP / WebSocket transport RFD is a draft or active, depending on the source
[T17]. claude-agent-acp is Apache-2.0 [T18].

## 2. Terms of service

### Anthropic (verbatim highlights)

- **Legal page [A6]:**
  - OAuth is "intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise
    subscription plans and is designed to support ordinary use of Claude Code and other native
    Anthropic applications".
  - Developers building products "should use API key authentication… Anthropic does not permit
    third-party developers to offer Claude.ai login… or to route requests through Free, Pro, or
    Max plan credentials on behalf of their users… may not collect, store, or intermediate
    Claude.ai credentials".
  - "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with
    their own Claude subscription."
  - Limits "assume ordinary, individual usage".
- **Agent SDK overview [A7]:** "does not allow third party developers to offer claude.ai login
  or rate limits for their products… unless previously approved". Products may not be called
  "Claude Code" or imitate it.
- **Help Center [A12]:**
  - 2026-06-15: SDK changes paused.
  - 2026-10-07: "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with
    your subscription limits."
  - Separately, the API credits for Max and Team cover API-key usage, not Claude Code [A15].
- **Consumer Terms (effective 2025-10-08) [A17]:**
  - no sharing of credentials;
  - no access "through automated or non-human means… except… API key… or where we otherwise
    explicitly permit it";
  - a "non-commercial use only" clause appeared in the regional variant that was fetched.
- **Usage Policy from 2026-11-12 [A18, A19]:** "Resell, proxy, or otherwise provide access to
  Claude through unauthorized means, including services that route requests through consumer
  subscriptions or misrepresent the product or client being used."
- **Headless mode [A8, A9]:**
  - `--bare` never reads OAuth credentials and "will become the default for `-p`";
  - `CLAUDE_CONFIG_DIR` keeps accounts separate;
  - `setup-token` is meant for CI.

| Scenario | Assessment | Confidence |
| --- | --- | --- |
| Own account, unmodified `claude` on his machines, steered from his phone through Remote Control | documented | high |
| Guanxi drives his own binary (`-p` or ACP) on his machines, each with its own `/login` | allowed by the legal carve-out, and the Help Center says it draws subscription limits; billing could be reclassified | medium-high |
| Guanxi's own relay carries only UI and events; model calls leave from `claude` on each machine | no prohibition found | medium-high [I] |
| Several of his machines signed in to one account | supported, limits pooled | high |
| Extracting OAuth tokens into a Guanxi model client, or imitating Claude Code | prohibited | high |
| Another person prompting through his subscription | prohibited | high |
| Copying credentials between his own machines | not addressed; a per-machine login avoids the question | low |
| Round-the-clock unattended automation on the subscription | "ordinary, individual usage" risk | medium |

### OpenAI

- **App-server [O4]:**
  - auth modes `chatgpt`, `apikey` and experimental `chatgptAuthTokens`;
  - "App-server authentication has never been permitted for commercial or hosted services";
    local and open-source apps may continue, with a recommendation to migrate to Sign in with
    ChatGPT;
  - the app-server and its WebSocket transport are experimental;
  - set `clientInfo.name`.
- **Sign in with ChatGPT for open-source apps [O8–O11]:**
  - self-serve;
  - `ext_agent_host_id` per install, with several hosts per user sharing the plan;
  - credentials can be moved to the user's own VMs over SSH;
  - per-host attribution and revocation are not available yet;
  - preview gaps: `store:false`, no hosted tools.
- **Codex auth [O5]:** headless login by device code or by copying `~/.codex/auth.json` ("treat
  like a password"). API keys are recommended for programmatic CI, as guidance only.
- **Terms of Use (snippets) [O12, O13]:** no sharing of credentials; no programmatic extraction
  of output; no circumventing rate limits; several devices allowed.

| Scenario | Assessment |
| --- | --- |
| Guanxi (local, open source) spawns `codex app-server` with Codex's own login on each machine | allowed today; migration recommended |
| Sign in with ChatGPT plan usage | the sanctioned path, in preview |
| Reading `auth.json` tokens into a non-Codex client | avoid |
| A hosted or commercial service, or another person using his plan | not permitted |

## 3. Limits across several machines

- **Anthropic:**
  - one pool per account across web, desktop, mobile, Claude Code and cloud sessions [A3, A16];
  - a 5-hour window plus a weekly limit [A13], and usage credits after the limit [A14];
  - Guanxi can read `rate_limits.five_hour` and `rate_limits.seven_day` from the statusline JSON
    [A11];
  - `/usage` attribution is local to the machine [A10];
  - no official concurrency cap; 429s reported at 3–6 parallel sessions on Max [S10].
- **OpenAI:**
  - local and cloud usage share the allowance;
  - Plus has a 5-hour window plus weekly limits; Pro has no 5-hour limit [O6];
  - Guanxi can read `account/rateLimits/read` and `account/rateLimits/updated` [O4];
  - 429s reported above about 2–3 concurrent streams on Pro [S14].

## 4. Implications for Guanxi (input, not a decision)

**Hard constraints (high confidence):**

1. Run only the user's installed, unmodified `claude` and `codex`, each under that machine's own
   login. Never read, copy, forward or store vendor OAuth tokens.
2. Never imitate a vendor client.
3. Bind subscription connections to their owner: no second human may prompt through them.
   Extend D-104 from relays to the account model.
4. A Guanxi relay carries only UI, job and event traffic, end-to-end encrypted and run by the
   owner. Model traffic leaves from the vendor CLI on the machine that holds the login.
5. Treat the billing classification as changing data, shown with its source and age. Pass
   explicit flags instead of relying on `-p` / `--bare` defaults.

**Reuse:**

- Paseo (Apache-2.0): daemon/provider split, relay protocol, Elixir relay;
- Happy (MIT): relay design;
- Remodex (Apache-2.0): handshake;
- acp-ui (MIT) and the ACP remote-transport RFD;
- Headscale, Tailscale or iroh for transport;
- Remote Control and Codex Remote as the user's own fallback.

**Guanxi must build itself:**

- a multi-vendor durable job layer, where one prompt from the phone can run on any host or
  vendor;
- an owner-run relay with pairing;
- an account-bound connection policy;
- account-wide aggregation of limits;
- Mac → Windows delegation that does not depend on vendor features.

## Contradictions and unverified items

- **Contradictions:**
  - harness billing (April rule versus October Help Center);
  - the Agent SDK note versus the legal carve-out;
  - Paseo's licence history;
  - Codex Remote encryption;
  - Happy's own docs;
  - Remote Control availability in older guides;
  - the status of the ACP transport RFD.
- **Unverified:**
  - how Anthropic classifies harness traffic, and whether ACP or `-p` could be billed as credits;
  - whether claude-agent-acp passes `--bare`;
  - whether Remote Control and ACP coexist;
  - official concurrency caps;
  - Codex relay encryption;
  - the live OpenAI terms (HTTP 403);
  - whether the "consumer subscriptions" wording is new;
  - which regional Consumer Terms apply;
  - copying credentials between machines;
  - details of the Happy, Paseo and Dispatch internals.

## Sources

**Anthropic.** A1 code.claude.com/docs/en/remote-control; A2 …/cross-session-messaging; A3
…/claude-code-on-the-web; A4 …/desktop; A5 …/channels; A6 …/legal-and-compliance; A7
…/agent-sdk/overview; A8 …/headless; A9 …/authentication; A10 …/costs; A11 …/statusline; A12
support.claude.com/en/articles/15036540 (updates 2026-06-15, 2026-10-07); A13 …/11145838; A14
…/12429409; A15 platform.claude.com api-credits-for-subscribers; A16 claude.com/pricing; A17
anthropic.com/legal/consumer-terms (2025-10-08); A18 anthropic.com/legal/aup (effective
2026-11-12); A19 anthropic.com/news/2026-usage-policy-update (2026-10-08). All accessed
2026-10-20/21.

**OpenAI.** O1 learn.chatgpt.com/docs/remote-connections; O2 …/developer-commands; O3
…/changelog (2026-05-21 to 2026-10-07); O4 …/app-server; O5 …/auth; O6 …/pricing; O7 …/cloud; O8
developers.openai.com/siwc/token-sharing-open-source; O9 …/codex-app-server; O10
…/self-hosted-vms; O11 …/preview-limitations; O12 openai.com/policies/row-terms-of-use
(effective 2026-01-01, snippet); O13 help.openai.com/en/articles/10471989 (snippet); O14
github.com/openai/codex.

**Secondary.** S1 techcrunch.com 2026-04-04; S2 news.ycombinator.com/item?id=47633464; S3
venturebeat.com 2026-05-13; S4 zed.dev/blog/anthropic-subscription-changes (2026-05-14, updated
2026-06-16); S5 ccleaks.com (2026-08-10); S6 news.ycombinator.com/item?id=47844269; S7
docs.openclaw.ai/providers/anthropic; S8 helpnetsecurity.com 2026-02-25; S9 pasqualepillitteri.it
(August 2026, snippet); S10 github.com/anthropics/claude-code issues 46037, 53922, 96872; S11
macrumors.com 2026-05-15; S12 codex.danielvaughan.com 2026-07-10; S13 xenospectrum.com (DevDay
2026-09-29); S14 github.com/openai/codex issues 42685, 41702.

**Projects.** T1 github.com/slopus/happy; T2 happy.engineering docs; T3 slopus/happy-agent; T4
gist felix021 (2026-04-14); T5 github.com/getpaseo/paseo + LICENSE; T6 paseo.sh docs/security; T7
getpaseo/paseo-relay; T8 paseo issues 2982, 7032 (2026-10-15); T9 Emanuele-web04/remodex; T10
omnara-ai/omnara; T11 HN 46991591; T12 amantus-ai/vibetunnel (Beta 18, 2026-07-11); T13
siteboon/claudecodeui; T14 coderemote.dev; T15 getmoshi.app; T16 formulahendry/acp-ui; T17
agentclientprotocol.com RFD streamable-http-websocket-transport; T18
agentclientprotocol/claude-agent-acp; T19 juanfont/headscale. Accessed 2026-10-21.
