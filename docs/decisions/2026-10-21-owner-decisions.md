# Owner decisions — 2026-10-21 (fleet, compute providers, phone access)

**Status:** accepted · **Date:** 2026-10-21 · **Decisions:** D-185–D-194
**Extends:** [2026-10-20 addendum](2026-10-20-owner-decisions-addendum.md).
**Evidence:** [2026-10-21 fleet research](../research/2026-10-21-fleet/) (three lanes);
design in [ADR-0038](0038-compute-providers-fleet-placement-and-remote-control.md).

The owner asked for:

- prompting from the phone while sessions run on his own machines, with his own subscriptions;
- work spread across every machine he has, by available resources;
- one way to use any compute source:
  - owned machines at any scale, free apart from electricity;
  - self-hosted sandboxes;
  - paid per-minute providers;
  - training services used with his key;
- fully local AI on owned hardware.

He answered the questions below in chat.

| ID | Topic | Decision | Source |
| --- | --- | --- | --- |
| D-185 | Fleet facts | The owner's machines (corrected the same day after he clarified which machine is which): a **MacBook M5 Pro, 24 GB** (main, interactive, carried); a **dual-boot PC** — Ryzen 5 3600, 32 GB, RTX 3060 12 GB, Fedora 44 on NVMe (the `fedora` SSH host, running the owner's own agent workstation with a resident Qwen 27B on the GPU) and Windows on a second disk; a **Fedora laptop** — ASUS TUF A15, Ryzen 7 4800H, 15 GB, RTX 2060 6 GB, reachable as `ssh asus` on the LAN; and the existing **VPS `keykomi`** (Ubuntu 26.04, 1 vCPU, 2 GB, Caddy on 443, AmneziaWG VPN) used only as a relay. There is no Mac Mini or Mac Studio. This replaces the hardware assumed in VISION, ADR-0018, ADR-0025, ADR-0029 and ADR-0031 and makes D-162, D-164 and D-170 obsolete (see D-186, ADR-0038 §9). | owner answer and inspection 2026-10-21 |
| D-186 | Always-on home | The **Fedora PC** (`fedora`) is the always-on home: the owner keeps it running; it holds long sessions, accepts work from the phone and delegates while the MacBook sleeps. When the owner boots it into Windows, the home role pauses and runs wait or move per ADR-0018. The Fedora laptop (`asus`) is a further node; the owner also uses it interactively, so D-189 headroom applies to it. Replaces D-170. | owner answer, corrected 2026-10-21 |
| D-187 | Phone access | Guanxi's **own end-to-end encrypted relay from the first phone stage** (U4). It runs on `keykomi` behind the existing Caddy on 443, kept small to fit 1 vCPU and 2 GB, and sees only ciphertext. The node mesh stays Tailscale or Headscale (D-146). The vendors' Remote Control and Codex Remote stay optional fallbacks. | owner answer |
| D-188 | Compute providers | **One provider protocol for every compute source:** owned Guanxi nodes (no billing, only resource accounting and load balancing), self-hosted sandbox backends, paid per-minute providers, and training or inference services. **Only owned machines are implemented first.** Paid adapters come later; E2B is the first candidate because its hosted and self-hosted forms share one API. | owner answer (adapter order) and owner direction |
| D-189 | Interactive headroom | The machine the owner is using stays fully usable: prompting, browsing, and running the apps Guanxi builds. Guanxi keeps an **adaptive headroom** measured from memory pressure, CPU, thermal state and foreground activity; there is no idle-only rule. Heavy work goes to other machines first. Work placed on the active machine can be preempted and moves elsewhere when the headroom shrinks. | owner answer |
| D-190 | Subscription agents on other machines | Each machine signs in with its own **unmodified** vendor CLI (`claude`, `codex`). Guanxi never reads, copies or moves vendor tokens, and never imitates a vendor client. Subscription connections are **bound to their owner**: no other person may prompt through them, even in a shared session. This amends D-154: only API-key or local connections may pay for an editor's prompts, and only when the owner allows it. Limits are aggregated account-wide from the vendors' rate-limit reports. | owner direction plus research (Anthropic Usage Policy from 2026-11-12; OpenAI app-server terms) |
| D-191 | Fully local AI | A whole model on one machine is the default. A loaded model holds a **residency lease** that builds and tests never evict. Splitting one model across machines (llama.cpp RPC, Parallax) is experimental and behind a flag. | owner direction plus integrator default |
| D-192 | Training and provider sign-up | A **train** run kind runs on owned GPUs or on a service using the user's key from the vault. An agent may help the user sign up for a provider: it prepares the plan, prices and cost cap and opens the official page. The user completes the CAPTCHA, email check, 2FA, payment and terms acceptance. Keys enter the vault through the provider's OAuth or device flow, or through a field Guanxi owns outside the transcript; the model sees only a `secret://` reference. | owner direction plus integrator default |
| D-193 | Fleet scale | No cap on fleet size. A site (LAN or datacenter) is a failure domain. Beyond about 50–100 nodes, or across sites, placement switches to sampling with late binding. Replaces the "about ten machines" sizing in REQ-B6 as a limit; ten machines in one site stays the first target. | owner direction plus integrator default |
| D-194 | Benchmark host | Untrusted benchmark containers run on the **Fedora PC in rootless Podman under a dedicated user**, with CPU and memory limits. They never touch the owner's workstation services or the resident Qwen on the GPU. The MacBook runs only fixture smokes. The benchmark API budget stays $200 per month (D-150). Amends D-151 (Windows PC under WSL2), which predates the corrected fleet (D-185); Windows with WSL2 remains possible only when the PC is booted into Windows. | owner answer 2026-10-21 |

## Notes

- The 2026-10-21 research corrects an earlier summary. Anthropic does allow a user to sign in to
  the unmodified Claude Code binary with their own subscription, including when a third-party
  harness drives it through `-p` or ACP. What it forbids is offering claude.ai login in another
  product, handling the user's credentials, routing other people's requests through a
  subscription, and imitating the client. The billing classification of such traffic changed
  several times in 2026 and is shown as data with its source and age (D-142).
- The Fedora PC already runs the owner's own agent workstation: an outbound relay through
  `keykomi`, Claude Code Remote Control, and `agent submit`. Guanxi's node will coexist with it
  at F1 enrollment rather than replace it silently.
  **Superseded for the application by [D-195](2026-10-22-owner-decisions.md):** the owner
  explicitly requested its retirement on2026-10-22. Application units are disabled; the SSH
  relay and VPN remain active. The fleet/home direction and general residency rules remain.
