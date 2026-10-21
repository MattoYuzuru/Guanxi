# ADR-0038: Compute providers, fleet placement and remote control

**Status:** accepted direction (D-185–D-193), proposed design · **Date:** 2026-10-21
**Extends:** [ADR-0018](0018-federation-ownership-and-leases.md) (ownership, leases),
[ADR-0031](0031-compute-fabric-node-agent-and-runtimes.md) (node agent, cloud budget),
[ADR-0017](0017-model-access-connections-and-secrets.md) (connections),
[ADR-0026](0026-clients-desktop-web-mobile.md) (clients).

## Context

The owner wants to send a prompt from the phone and have the session run on one of his own
machines, using his own Claude and ChatGPT subscriptions there. Builds, containers and tests
should run wherever there is room, and long or heavy work should move off the laptop he is
using. He wants one way to use any compute source:

- his own machines at any scale, free apart from electricity;
- self-hosted sandboxes;
- paid per-minute providers;
- training services used with his key.

A fully local AI on owned hardware should work the same way. His fleet today (D-185):

| Machine | Spec | Role |
| --- | --- | --- |
| MacBook | M5 Pro, 24 GB | main machine, interactive |
| Fedora PC (dual-boot with Windows) | Ryzen 5 3600, 32 GB, RTX 3060 12 GB; a resident Qwen 27B of the owner's workstation holds about 10.6 GB of VRAM | always-on home, builds, tests, GPU work |
| Fedora laptop (`asus`) | Ryzen 7 4800H, 15 GB, RTX 2060 6 GB; also used interactively | extra node with interactive headroom |
| VPS `keykomi` | 1 vCPU, 2 GB | relay only |

Research ([2026-10-21 fleet lanes](../research/2026-10-21-fleet/)) found:

- Vendors already offer phone control of their own agent (Claude Code Remote Control, Codex
  Remote). Each is single-vendor, routes through the vendor's servers, and is not end-to-end
  encrypted.
- Paseo (Apache-2.0) is the closest open design: a daemon per machine and an optional
  end-to-end encrypted relay.
- No tool places work by measured host load across a user's own machines.
- SkyPilot and dstack cannot manage macOS or Windows hosts.
- E2B is the only sandbox whose hosted API also runs self-hosted under Apache-2.0.
- Distributed inference across a Mac and a CUDA box is still experimental.
- Anthropic's terms allow the user's own unmodified `claude` on his own machines, including
  when a harness drives it. Routing other people's requests through a consumer subscription is
  banned outright from 2026-11-12. OpenAI allows local, open-source use of `codex app-server`
  with the user's ChatGPT login, and offers Sign in with ChatGPT.

## Decision

### 1. One compute-provider protocol

Every compute source implements one protocol, modelled on SkyPilot's provisioner and dstack's
backend interface, but implemented as a Guanxi plugin:

| Operation | Purpose |
| --- | --- |
| `capabilities()` | isolation class (bare, container, gVisor, microVM, VM), OS/arch, Docker inside, GPUs, snapshot kinds, egress-policy kinds, credential brokering, maximum session, billing granularity, regions |
| `offers(request)` | shapes with price per second (0 for owned machines), expected start (including wake-up), and provenance: source, `observed_at`, confidence |
| `reserve(offer, maxDuration)` | short reservation lease; for paid providers also a budget-ledger reservation (ADR-0031 §7) |
| `launch(spec, ttl, idempotencyKey)` | always sets a provider-side TTL where one exists |
| `exec`, `put`/`get`, `logs`, `artifacts(globs)` | streamed execution, file and bundle transfer, artifacts into the node's content-addressed store |
| `snapshot`, `pause`, `resume`, `fork` | optional, declared in capabilities |
| `setNetworkPolicy`, `teardown`, `list(tag)`, `usage` | egress rules; idempotent teardown; orphan reaping; metered usage labelled `reported` or `estimated` |

Kinds of provider:

- **Owned node** (first and only kind implemented now, D-188). A Guanxi node reached over the
  node channel, not SSH; SSH is used only to enroll a host.
  - It costs 0 and reserves no budget.
  - It still publishes capacity and leases (ADR-0018).
  - It is ranked by fit, queue time, transfer cost and the cost of waking it.
- **Self-hosted sandbox backend** on an owned node, for untrusted code:
  - Linux: E2B Embed with KVM, or gVisor or Incus;
  - Mac: a Lima VM, or Apple `container` on macOS 26;
  - Windows: a dedicated WSL2 distribution.
- **Paid provider** (later). E2B first; Modal for GPU plus CPU; Vercel Sandbox where the
  strongest egress and credential brokering matter; DigitalOcean as a generic per-second VM.
  Every launch has a budget reservation, a provider TTL, a dead-man heartbeat and tag-based
  reaping.
- **Training or inference service** (D-192): train run kinds against Together, Fireworks or
  HF Jobs, or against rented GPUs running Axolotl or Unsloth.

Licences: AGPL, BUSL, FSL and proprietary components (Daytona, Beam beta9, LXD, Nomad,
Terraform, NativeLink, OrbStack, Docker `sbx`) are process-only and never defaults.

### 2. Placement on owned machines

The run home places work as follows:

1. **Hard filters.** OS/arch, isolation, GPU or VRAM, installed models, policy.
2. **Score.** The score combines:
   - expected start, including wake latency;
   - duration from history;
   - cache warmth;
   - transfer time from measured link bandwidth;
   - interference with resident models;
   - the owner-presence penalty.
3. **Offers.** It sends offers to the top two or three candidates. Each governor answers with a
   short reservation, and the first ready node binds (Sparrow-style late binding).

Inside one site every candidate is scored. Beyond about 50–100 nodes, or across sites, the home
samples candidates (D-193). A site is a failure domain: fast telemetry gossip inside it,
summaries across sites, and lease TTLs and failure detectors scaled to RTT.

**Allocatable capacity** per node = capacity − interactive headroom − OS reserve − resident
models − container VM size. Signals:

- Linux and WSL: PSI;
- macOS: memory-pressure level, thermal state, user idle time;
- Windows: a user-session helper for input and Job Objects.

Free-memory figures alone are never the signal.

**Interactive headroom (D-189).** The machine the owner is using keeps enough room for
prompting, browsing and running the app under test.

- Heavy work prefers other machines.
- Work placed on the active machine runs at background priority (`taskpolicy -b` on macOS) and
  is preempted, requeued or moved when memory pressure or thermal state degrades.
- Agent attempts themselves are never preempted, as ADR-0031 requires; only their builds and
  tests are.

**Job-size estimates.**

- Key: (repository, task kind, node class, lockfile hash).
- Peak memory: decayed p90 of history × 1.15.
- Duration: an EMA per node class with a learned speed factor.
- An out-of-memory kill bumps the estimate.
- A cold start uses a per-kind default marked `unknown` confidence.

**Typed slots.** `cpu.heavy(k)`, `browser(k)`, `compose(k)` and 10-port blocks per worktree.
Limit: one heavy job and one end-to-end job per agent at a time. Capacity is shared fairly with
DRF. Priority: owner interactive > blocking agent step > speculative test > scavenger work.

### 3. Moving work and results

1. **Snapshot.** The dirty worktree is snapshotted into a commit object (temporary index plus
   `commit-tree`).
2. **Owned nodes.** The snapshot is pushed to `refs/guanxi/attempts/<id>` on the target node's
   mirror.
3. **Sandboxes.** They receive a git bundle on top of the forge base, fetched with a one-hour,
   single-repository token.
4. **Large non-git inputs** move through content-addressed storage with missing-blob
   negotiation.
5. **Outputs.**
   - Logs are streamed in sequenced chunks.
   - Small artifacts (JUnit, Playwright blob reports) travel with the completion.
   - Traces and videos stay in the executor's store and are fetched on demand.
   - Results come back as a bundle into `refs/guanxi/results/<id>` and are never merged
     automatically.
6. **Playwright** shards across nodes with blob reports and `merge-reports`, or runs browsers
   remotely with `run-server`.

**Shared caches are fenced.**

- An attempt writes only into its own namespace.
- Only an accepted completion promotes entries.
- An overwrite is refused (the Nx CREEP lesson, CVE-2025-36852).

### 4. Fully local AI (D-191)

- Each model runs whole on one machine. MoE expert offload to CPU RAM is used where it fits.
- A loaded model holds a **residency lease** (`model-resident:<node>:<digest>`) reserving its
  weights and KV cache. Builds and tests never evict it.
- Splitting a model across machines (llama.cpp RPC, Parallax) is experimental and behind a
  flag.
- Models loaded by processes Guanxi does not own (for example the owner's workstation Qwen on
  the Fedora PC) are observed as external residents and reserved the same way. It needs a gang lease across all participating nodes.

The interference of builds on decode speed is measured per node and stored as a coefficient.

### 5. Remote control from the phone (D-187)

**The relay.**

- Guanxi runs its own end-to-end encrypted relay from the first phone stage (U4). It is placed
  on `keykomi` behind the existing Caddy on 443 and kept small enough for one vCPU.
- Nodes connect outbound, so no inbound ports are needed at home.
- The phone pairs by QR code (X25519/Ed25519 keys, AEAD per session; Remodex and Paseo are the
  references).
- The relay carries only UI, job and event traffic and sees only ciphertext.

**Where model calls happen.** Model traffic never passes through the relay: it leaves from the
vendor CLI or runtime on the machine that holds the login.

**From prompt to work.** A phone prompt becomes a durable run at the always-on home (the Fedora
PC, D-186). The home places the work with §2 on itself, the MacBook or the Fedora laptop.

**Fallbacks.** The vendors' Remote Control and Codex Remote stay optional, for the owner's own
use.

### 6. Subscription agents on other machines (D-190)

- Each node runs the user's installed, **unmodified** `claude` or `codex`, signed in on that
  node (`/login`, or a device code for headless hosts). Separate accounts use separate config
  directories.
- Guanxi never reads, copies, forwards or stores vendor OAuth tokens. It never imitates a vendor
  client, and it passes explicit flags instead of relying on `-p` or `--bare` defaults.
- A subscription connection belongs to one person. No other account may prompt through it,
  including an editor in a shared session (amends D-154).
- Limits are per account and shared by all machines. Guanxi aggregates the vendors' reports:
  Claude `rate_limits.five_hour` and `seven_day`, Codex `account/rateLimits`. It meters local
  attribution itself, since vendors do not report usage per machine.
- Vendors publish no official concurrency cap, so concurrency is learned, starting low, around
  three parallel sessions per account.
- Billing classification (subscription, usage credits, API) is shown with its source and age.

### 7. Training runs and provider sign-up (D-192)

**Train runs.** A `train` run uploads a dataset, starts the job, polls it and downloads the
weights or adapter, using a key from the vault. Most services issue long-lived keys only, so:

- keys stay on the controller node;
- sandboxes never hold them;
- scoped keys are preferred where offered (RunPod, Vast).

**Assisted sign-up.**

- **The agent** prepares the plan, the prices, a link to the terms and a cost cap, then opens
  the official sign-up page in the agent browser (ADR-0035).
- **The user** completes the CAPTCHA, email check, 2FA, payment and terms acceptance. This is
  required: GitHub and RunPod forbid automated account creation.
- **The key** enters the vault through the provider's OAuth or device flow, or through a field
  Guanxi owns outside the transcript. MCP requires URL-mode elicitation for keys.

### 8. Scale (D-193)

The protocol, leases and placement have no fleet-size cap. The first target is about ten
machines in one site, and hierarchy is added only when needed.

### 9. Superseded assumptions

These items are replaced by D-185 and D-186:

- the Mac Mini as the always-on home (D-170);
- computer-use tiers 3–4 on a Mac Mini or Mac Studio (D-162). They now run on the Fedora PC
  or the Fedora laptop, never on the MacBook while the owner is using it;
- Thunderbolt 5 pooling (D-164), which no longer applies;
- the 32 GB and 256 GB Apple Silicon fleet assumed in ADR-0031.

Benchmark containers run on the Fedora PC in rootless Podman under a dedicated user with CPU
and memory limits (D-194, amending D-151); Windows with WSL2 remains possible only when the PC
is booted into Windows.

## Consequences

- Guanxi's distinctive value is real: one durable job layer across vendors and machines, with
  load-aware placement that no other tool offers.
- Work to be built:
  - an owner-run relay and pairing;
  - host-pressure signals on three operating systems;
  - a user-session helper on Windows;
  - fenced caches;
  - the provider plugin interface.
- Vendor billing and terms may change again. Connections show the current classification, and
  the owner-binding rule keeps the core within every vendor's terms seen so far.
- The relay host is small (one vCPU, 2 GB): only the relay runs there.

## Validation

- Placement simulation: 1,000 randomized fleets and jobs; no node exceeds its allocatable
  capacity; a resident model is never evicted by a test; the owner-presence reserve holds under
  synthetic interactive load.
- Relay: the relay stores and logs no plaintext (a test inspects the relay's storage and
  logs); a node's connection is outbound only; pairing rejects replayed or forged handshakes.
- Owner binding: a second account's prompt that would reach a subscription connection is
  refused (route test); no vendor token file is read by Guanxi code (static check plus test).
- Fenced cache: an attempt's write never becomes visible to another attempt before acceptance;
  an overwrite is refused.
- Transfer: a dirty worktree round-trips through bundle and attempt ref without touching the
  user's branch; results never merge automatically.

## Evidence

- [Lane 1 — remote control and subscriptions](../research/2026-10-21-fleet/01-remote-control-and-subscriptions.md)
- [Lane 2 — sandboxes, provider protocol, training](../research/2026-10-21-fleet/02-sandboxes-providers-training.md)
- [Lane 3 — fleet scheduling and local AI](../research/2026-10-21-fleet/03-fleet-scheduling-and-local-ai.md)
- `keykomi` was inspected read-only on 2026-10-21: Ubuntu 26.04, 1 vCPU, 1.9 GB RAM, Caddy on
  80 and 443, Docker, AmneziaWG on UDP. The Fedora PC was unreachable at that time.
