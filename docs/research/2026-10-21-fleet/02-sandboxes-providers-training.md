# Lane 2 — On-demand isolated compute: sandboxes, self-hosted backends, provider protocol, training, assisted sign-up

**Raw research report** (D-120). Lane run 2026-10-20/21 by a `discovery-agent:evidence-researcher`.
"acc." means the page was undated and accessed 2026-10-20; "(secondary)" marks third-party
evidence; **[I]** marks inference. Section 7 is input for an owner decision.

## 1. Executive summary

- **E2B and Daytona** charge the same per-second rates: $0.0504/vCPU-h and $0.0162/GiB-h
  [S1][S10].
  - E2B is CPU-only. Sessions last 24 h on Pro and 1 h on Hobby.
  - E2B pause keeps the filesystem and memory with no TTL and resets the session window
    [S1][S2][S4].
- **Daytona is no longer usable open source.** Development went private in June 2026, and the
  AGPL repo was archived on 2026-10-03 [S12].
- **E2B is the only provider whose hosted API also runs self-hosted under Apache-2.0.**
  - E2B Embed (2026-09-30) runs the Firecracker stack on one Linux+KVM host with the same SDKs
    and no account [S7][S8].
  - It has no secrets, volumes, workload identity or bring-your-own proxy.
- **Vercel Sandbox has the most complete boundary for untrusted code** [S19]–[S22]:
  - Firecracker;
  - an SNI/CIDR egress firewall;
  - credentials injected into HTTP headers, so they never enter the VM;
  - billing for active CPU only;
  - Docker inside;
  - 24 h sessions on Pro.

  It cannot be self-hosted.
- **Modal puts GPUs and CPU sandboxes behind one API** [S15]–[S18]:
  - about $0.071/vCPU-h and $0.024/GiB-h;
  - gVisor by default, and a VM runtime for Docker;
  - 24 h sessions;
  - domain and CIDR allowlists;
  - Apache-2.0 SDKs.
- **Brokering credentials through an egress proxy is now common:** Vercel, Cloudflare Sandbox,
  Docker Sandboxes and microsandbox [S21][S27][S47][S50]. Codex cloud strips secrets before the
  agent phase [S66], and Cursor recommends OIDC tokens [S67].
- **Hosted agent products clone from the forge with app-scoped tokens** rather than pushing a
  laptop worktree [S66]–[S69]. Guanxi needs its own transport for uncommitted worktrees: a git
  bundle or temporary ref, plus a CAS.
- **SkyPilot and dstack cannot cover a Mac Mini or a Windows host.**
  - SkyPilot SSH Node Pools need Debian-based Linux [S71].
  - dstack SSH fleets need Linux, Docker and passwordless sudo [S72].

  This confirms that Guanxi needs its own node agent (ADR-0031).
- **2026 changes:**
  - Fly GPUs ended 2026-08-01 [S33];
  - Hetzner raised prices from 2026-06-15 [S42];
  - RunPod CPU pods lost Docker-in-Docker [S41];
  - OpenPipe's hosted platform was retired 2026-07-30 [S78];
  - HF AutoTrain is unmaintained [S79];
  - Docker Cloud Sandboxes launched 2026-09-24 [S47];
  - HF Sandboxes on Jobs are experimental [S49];
  - Apple `container` reached 1.0 (secondary) [S57].
- **Process-only under ADR-0016:**
  - AGPL: Daytona, Nightona, Beam beta9, LXD, Unsloth Studio;
  - BUSL: Nomad, Terraform;
  - FSL: NativeLink;
  - proprietary: OrbStack, Docker `sbx`.
- **Clean permissive building blocks:**
  - Apache-2.0: the E2B runtime, Embed and SDK; microsandbox (beta); Firecracker; Kata; gVisor;
    Incus; Lima; Apple `container`; SkyPilot; the Vercel, Cloudflare and Modal SDKs;
  - MIT: Colima;
  - MPL-2.0: dstack, OpenTofu, go-plugin.

## 2. Hosted providers

### 2a. Agent sandboxes

| Provider | Billing and example rate | Max session | Access | Snapshot / pause / fork | Docker | GPU | Egress control | OSS parts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E2B | per s; $0.0504/vCPU-h, $0.0162/GiB-h; Pro $150/mo [S1] | 1 h Hobby, 24 h Pro [S1][S4] | SDK/REST exec, files; no native SSH found | pause keeps FS + memory (no TTL); snapshots one-to-many [S2][S3] | via template [S6] | no | hostname or CIDR allow/deny, SOCKS5 egress proxy [S5] | Apache-2.0 SDK, runtime, Embed [S7][S8][S9] |
| Daytona | per s; same rates; Windows $0.0858/vCPU-h [S10] | 15 min idle auto-stop [S14] | SSH via token, SDK [S11] | FS + memory snapshots only on VM sandboxes [S11] | reported | yes [S10] | tiered; CIDR/domain [S11] | archived AGPL [S12] |
| Modal | per s; about $0.071/vCPU-h, $0.024/GiB-h [S15] | 24 h [S16] | exec, tunnels | FS snapshots; memory snapshots experimental [S16] | VM runtime [S16] | yes, gVisor only | CIDR/domain allowlists [S17] | Apache-2.0 client [S18] |
| Vercel Sandbox | active CPU $0.128/h, $0.0212/GB-h, $0.60 per 1M creations [S19] | 45 min Hobby, 24 h Pro | `runCommand`, exec `--tty`; no SSH [S20] | persistent; FS snapshots (30 d) [S19][S20] | yes [S20] | no | SNI/CIDR firewall, header credential injection [S21][S22] | Apache-2.0 SDK [S23] |
| Cloudflare Sandbox | 10 ms granularity, active CPU; $0.072/vCPU-h [S24] | sleeps after `sleepAfter` | exec, PTY, preview URLs, `gitCheckout` [S26] | disk snapshots to R2 (20 GB, 30 d) [S25][S27] | not documented | no | outbound interception; credentials stay in the Worker [S27][S29] | Apache-2.0 SDK [S28] |
| Fly Machines / Sprites | per s; Sprites $0.0385/CPU-h [S30][S31] | — | SSH, REST [S32] | suspend with memory; Sprites FS checkpoints [S31][S32] | ? | ended 2026-08-01 [S33] | — | — |
| Morph Cloud | $0.05 per MCU [S34] | — | SSH, exec (secondary) | memory + disk branching (secondary) | ? | ? | ? | — |
| Runloop | $0.108/CPU-h [S35] | keep-alive 1 h default | SSH, API | disk snapshots, forks [S35] | yes | — | — | — |
| Docker Cloud Sandboxes | per s; $0.07/h for 1 vCPU/2 GiB; paused sandboxes free [S47] | 24 h max | `sbx`; `sbx move --to cloud` | pause | own dockerd | ? | proxy credential injection | proprietary [S48] |
| HF Sandboxes (Jobs) | per min; cpu-basic $0.01/h [S49] | 24 h | exec, files; `ssh=True` on Jobs | — | ? | yes | warns against long-lived keys | experimental; pooled mode unsafe for untrusted code [S49] |

### 2b. CI, devbox and VM fallbacks

- **Namespace:** per minute; about $0.06/vCPU-h; `--duration` TTL; macOS instances [S37].
- **Depot:** per second, $0.18/vCPU-h overage; sandbox SDK; joins a tailnet [S38].
- **Northflank:** per second, $0.0167/vCPU-h; BYOC; Kata with Cloud Hypervisor [S39][S90].
- **Beam:** per ms; beta9 is AGPL [S40].
- **RunPod CPU pods:** no Docker-in-Docker [S41].
- **Hetzner:** hourly rounding; billed while powered off; 2026 price rises [S42].
- **DigitalOcean:** per second with a 60 s minimum; about $0.0158/vCPU-h. The best generic
  per-second VM [S43].
- **Scaleway:** CPU has a 60 min minimum [S44].
- **Codespaces:** $0.18/h for 2 cores [S45].
- **GitHub Actions:** fallback; the self-hosted runner fee is postponed [S46].

## 3. Self-hostable open source

| Project | Licence | macOS | Windows/WSL2 | Linux | Notes |
| --- | --- | --- | --- | --- | --- |
| E2B Embed and infra | Apache-2.0 | no | only in WSL2 with nested virtualization (untested) | KVM | Embed is single-node and has no secrets or volumes [S7][S8] |
| Daytona OSS / Nightona | AGPL (process-only) | — | — | yes | archived; avoid [S12][S13] |
| microsandbox | Apache-2.0 | Apple Silicon | WHP | KVM | beta: libkrun, host allowlists, secrets outside the VM, snapshots, SDKs [S50] |
| Firecracker / Kata / gVisor | Apache-2.0 | no | no | yes | production-grade isolation [S51][S53][S54] |
| Incus (LXD fork) | Apache-2.0 | client | client | server | LXD is AGPL for Canonical code [S55] |
| Lima | Apache-2.0, CNCF | yes | WSL2 driver | yes | v2.0 has plugins, krunkit GPU and MCP sandbox tools [S56] |
| Apple `container` | Apache-2.0 | macOS 26 | no | no | a VM per container; no remote API [S57] |
| OrbStack | proprietary | yes | no | no | not a default [S58] |
| Colima | MIT | yes | no | yes | built on Lima [S59] |
| Docker over SSH | — | client | client | server | the socket is effectively root; transport, not isolation [S60] |

WSL2 enables `nestedVirtualization` by default on Windows 11 (docs 2026-10-16) [S62]. KVM stacks
inside WSL2 are possible in principle, but unverified.

## 4. Sending a worktree and getting artifacts back

How the products do it:

- **Codex cloud:** checkout at a SHA, a setup script, the agent phase offline, secrets removed
  before the agent runs [S66].
- **Cursor:** Firecracker VMs, clone through a GitHub App, HSM-signed commits, OIDC preferred
  [S67].
- **Jules:** VM snapshots [S68].
- **Devin:** blueprint snapshots, secrets never in the snapshot [S69].
- **OpenHands:** an action server, tar.gz upload, remote runtimes through E2B, Modal and
  Daytona [S70].

Primitives:

- `git bundle`, made for offline transfer with prerequisite checks [S63];
- REAPI CAS: `FindMissingBlobs`, batch upload and `GetTree` [S64];
- GitHub App tokens: 1 h, scoped to a repository [S65].

**[I] Proposed Guanxi flow:**

1. Snapshot the dirty worktree into a commit object (temporary index plus `commit-tree`).
2. For owned nodes, push to `refs/guanxi/attempts/<id>` on the node's mirror.
3. For hosted sandboxes, upload `git bundle <forge-base>..<snapshot>`. The sandbox fetches the
   base with a 1 h single-repository token.
4. Move large non-git inputs through a CAS with missing-blob negotiation.
5. Pack outputs by declared globs (tar+zstd, sha256) into the node's CAS and stream the logs.
6. Return result commits as a bundle into `refs/guanxi/results/<id>`; never auto-merge them.

## 5. Provider abstractions (prior art)

- **SkyPilot (Apache-2.0)** provisioner functions: bootstrap, run, stop and terminate
  instances; query; open and clean up ports; get cluster info; get command runners; volumes.
  - It has autostop. v0.13.0 added "Cost Caps" (unverified) [S71].
  - SSH Node Pools are Linux only.
- **dstack (MPL-2.0):** a `Compute` class with capability mixins; `gpuhunt` offers and prices;
  shim and runner agents. SSH fleets need Linux and show $0 pricing [S72].
- **Kubernetes DRA (Apache-2.0):** DeviceClass, ResourceSlice and ResourceClaim; GA in 1.34
  [S73].
- **Nomad:** BUSL, do not copy [S74].
- **OpenTofu and go-plugin (MPL-2.0):** subprocess plugins over gRPC with a protocol version
  check [S75].

**[I] Minimal Guanxi provider protocol:**

| Operation | What it covers |
| --- | --- |
| `capabilities()` | isolation class, OS/arch, Docker, GPU, snapshot kinds, egress-policy kinds, credential brokering, max session, billing granularity, regions |
| `offers(request)` | Offer objects: shape, region, per-second prices, start estimate, with source, `observed_at` and confidence |
| `reserve(offer, max_duration)` | a budget reservation |
| `launch(spec, ttl, idempotency_key)` | starts work with a provider-side TTL |
| `exec` | streamed, optional PTY |
| `put` / `get` | files and bundles |
| `artifacts(globs)` | packed outputs into the CAS |
| `logs()` | log stream |
| optional `snapshot` / `pause` / `resume` / `fork` | where the provider supports them |
| `set_network_policy()` | egress rules |
| `teardown()` | idempotent |
| `list(tag)` | for the orphan reaper |
| `usage()` | provider-reported or estimated |

Owned machines are a provider at $0, reached over the node channel rather than SSH. They publish
capacity and leases, and are ranked by fit, queue time and the cost of waking them.

## 6. Training services and assisted sign-up

| Service | API | Pricing | Weights out | Credentials |
| --- | --- | --- | --- | --- |
| Together | upload JSONL or Parquet, then a job (LoRA, full, SFT, DPO), then download [S76] | per 1M tokens, per-job minimum | download | API key only; ZDR off by default |
| Fireworks | SFT, DPO, RFT; `firectl model download` [S77] | from $0.50 per 1M tokens; GPU per second | LoRA or merged | API key |
| OpenPipe | hosted platform retired 2026-07-30; ART (Apache-2.0) continues [S78] | — | — | — |
| Modal, RunPod, Lambda, Vast + Axolotl or Unsloth | your own pod and trainer | per s or per min; Lambda H100 $3.99/GPU-h [S81] | you own them | RunPod and Vast scoped keys, no expiry [S82] |
| HF Jobs | `hf jobs uv run`, TRL or Unsloth scripts; volumes and buckets [S49] | per min | Hub or bucket | fine-grained tokens; OIDC (secondary) |
| HF AutoTrain | archived 2026-09-17 [S79] | — | — | avoid |
| Unsloth / Axolotl | core Apache-2.0 (Unsloth Studio is AGPL); Axolotl Apache-2.0 [S80] | — | — | — |
| Vertex / SageMaker | per token or per second [S83] | — | — | workload identity (not re-verified) |

**Assisted sign-up [I]:**

- The agent prepares the plan, the prices, the terms link and a cost cap, then opens the
  official page.
- The user does the CAPTCHA, email check, 2FA, payment and terms acceptance.
- The key goes into the vault through the provider's OAuth or device flow, or through a field
  owned by Guanxi and kept outside the transcript. The model sees only a `secret://` reference
  and derived facts.
- MCP 2025-11-25 requires URL-mode elicitation for keys and payments [S84].

Terms of service:

- GitHub forbids accounts registered by bots [S85].
- RunPod forbids creating accounts or accessing the service by automated means [S86].
- HF requires a natural person or legal entity [S87].
- Together has no such clause [S76].

**Never automate:** CAPTCHA, terms acceptance, payment entry or credit farming.

## 7. Lane recommendation (input for the owner)

- **First adapters:** (1) the Guanxi node as a provider for owned machines; (2) E2B, hosted and
  self-hosted Embed; (3) optionally Modal (GPU plus CPU). Vercel is the runner-up for egress and
  credential brokering, and DigitalOcean the generic per-second VM.
- **Self-hosted default per machine:**
  - Linux VPS: E2B Embed if KVM is exposed, else gVisor or Incus.
  - Mac: a Lima VM per attempt, or Apple `container` on macOS 26; Colima for the Docker API.
  - Windows PC: a dedicated WSL2 distribution with Docker.
- **Security:**
  - Use microVM or gVisor isolation for untrusted code.
  - Deny egress by default.
  - The sandbox never holds long-lived keys; use proxy injection or per-attempt grants.
  - Reserve budget before launch and set a provider TTL.
  - Run a dead-man heartbeat and reap orphans by tag.
  - Use provider spend caps where they exist.
  - Treat returned artifacts as untrusted.
- **Avoid:**
  - AGPL and BUSL components as code;
  - OrbStack and `sbx` as defaults;
  - RunPod CPU pods for Docker;
  - Hetzner or Scaleway for short jobs;
  - Fly GPUs;
  - HF pooled sandboxes for untrusted code;
  - HF AutoTrain;
  - OpenPipe's hosted platform.

## 8. Contradictions and unverified items

- **Contradictions:**
  - the Fly Sprites price;
  - Modal VM runtime maturity;
  - Daytona's last open release;
  - the GitHub runner fee;
  - vendor and benchmark cold-start figures;
  - plan names;
  - E2B self-host providers;
  - Lambda billing granularity.
- **Unverified:**
  - SSH for E2B, Modal and Vercel;
  - Docker in Cloudflare and Fly;
  - GPUs for Morph and Vercel;
  - CodeSandbox pricing;
  - RunPod CPU prices;
  - SkyPilot Cost Caps;
  - the Cloud Hypervisor and `agent-sandbox` licences;
  - Apple `container` 1.0 from a primary source;
  - E2B Embed or microsandbox inside WSL2;
  - KVM on typical VPS plans;
  - Fireworks retention;
  - the newer MCP elicitation mechanics;
  - short-lived credentials on the hyperscalers;
  - automated sign-up terms for E2B, Modal, Vercel, Vast and Lambda.

## Sources

S1 e2b.dev/pricing; S2 e2b.dev/docs/sandbox/persistence; S3 e2b.dev/docs/sandbox/snapshots; S4
docs.e2b.dev/faq/sandbox-lifetime; S5 e2b.dev/docs/sandbox/internet-access, docs.e2b.dev/changelog;
S6 e2b.dev/docs/template/examples/docker; S7 github.com/e2b-dev/infra (+ self-host.md); S8
e2b.dev/resources/introducing-e2b-embed (2026-09-30); S9 github.com/e2b-dev/E2B; S10
daytona.io/pricing; S11 daytona.io docs sandboxes, ssh-access, network-limits; S12
github.com/daytonaio/daytona (archived 2026-10-03); S13 github.com/nightona-co/nightona; S14
northflank.com/blog/daytona-vs-modal (2026-06-12); S15 modal.com/pricing; S16
modal.com/docs/guide/sandboxes; S17 modal.com/docs/guide/sandbox-networking; S18
github.com/modal-labs/modal-client; S19 vercel.com/docs/sandbox/pricing (2026-09-10); S20
vercel.com/docs/sandbox/concepts (2026-08-25); S21 vercel.com/changelog safely-inject-credentials
(2026-02-24); S22 vercel.com/changelog advanced-egress-firewall-filtering; S23
github.com/vercel/sandbox; S24 developers.cloudflare.com/containers/pricing; S25
developers.cloudflare.com/containers/platform-details/limits (2026-10-12); S26
developers.cloudflare.com/sandbox (2026-09-30); S27 blog.cloudflare.com/sandbox-ga (2026-04-13);
S28 github.com/cloudflare/sandbox-sdk; S29 developers.cloudflare.com sandbox api-map; S30
docs.fly.io/about/pricing; S31 fly.io/sprites, checkpoint-restore; S32 fly.io/docs/reference/
suspend-resume; S33 community.fly.io/t/27785, bex.co blog (2026-07-09); S34
cloud.morph.so/web/subscribe; S35 runloop.ai/pricing, docs.runloop.ai; S36 codesandbox.io sdk
pricing; S37 namespace.so/pricing, cli create; S38 depot.dev agents, pricing; S39
northflank.com/pricing; S40 beam.cloud/pricing, github.com/beam-cloud/beta9; S41
docs.runpod.io/pods/overview, runpod.io blog enhanced-cpu-pods; S42 docs.hetzner.com price
adjustment (2026-06-15); S43 docs.digitalocean.com droplets pricing (2026-08-25); S44
scaleway.com pricing and FAQ; S45 docs.github.com codespaces billing; S46 github.blog changelog
2025-12-16, cicdcost.com; S47 docker.com blog cloud sandboxes (2026-09-24); S48
github.com/docker/sbx-releases; S49 huggingface.co docs jobs, jobs-pricing, sandbox; S50
github.com/zerocore-ai/microsandbox; S51 github.com/firecracker-microvm/firecracker; S52
github.com/cloud-hypervisor/cloud-hypervisor; S53 github.com/kata-containers/kata-containers; S54
github.com/google/gvisor; S55 github.com/lxc/incus, stgraber.org LXD relicensing (2023-12-12); S56
github.com/lima-vm/lima, v2.0.0, CNCF blog (2025-12-11); S57 github.com/apple/container; S58
orbstack.dev/pricing; S59 github.com/abiosoft/colima; S60 docs.docker.com protect-access; S61
github.com/kubernetes-sigs/agent-sandbox; S62 learn.microsoft.com wsl-config (2026-10-16); S63
git-scm.com/docs/git-bundle; S64 github.com/bazelbuild/remote-apis; S65 docs.github.com GitHub
App installation token; S66 learn.chatgpt.com cloud-environment; S67 cursor.com/docs/cloud-agent/
security; S68 jules.google docs; S69 docs.devin.ai environment, secrets; S70 OpenHands runtime
README; S71 docs.skypilot.ai existing-machines, sky/provision, releases (v0.13.0 2026-07-22,
v0.14.0 2026-10-05); S72 dstack.ai fleets, BACKENDS.md; S73 kubernetes.io DRA; S74 hashicorp/nomad
LICENSE; S75 OpenTofu (1.12.3, 2026-06-18), hashicorp/go-plugin; S76 docs.together.ai
fine-tuning, pricing, ZDR, terms (2026-05-19); S77 fireworks.ai pricing, deploying-loras; S78
openpipe.ai blog, coreweave docs; S79 huggingface autotrain-advanced (archived 2026-09-17); S80
unslothai/unsloth, axolotl-ai-cloud/axolotl; S81 lambda.ai/instances; S82 docs.runpod.io
credentials, runpod blog scoped keys, docs.vast.ai permissions, api-keys; S83 Vertex AI and
SageMaker pricing; S84 modelcontextprotocol.io 2025-11-25 elicitation, SEP-1036; S85
docs.github.com terms of service; S86 runpod.io terms (2026-03-24); S87 huggingface.co terms;
S88a marktechpost.com sandboxes (2026-08-27); S88b blog.logrocket.com sandbox comparison; S89
docker.com blog docker-sandboxes (2026-01-30); S90 northflank.com microVM sandboxes.
