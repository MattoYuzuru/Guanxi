# Lane 3 — Fleet build and test execution, scheduling, host resource awareness, local distributed inference

**Raw research report** (D-120: raw lane reports are evidence; the synthesis in
[`../README.md`](../README.md) and the ADRs are canonical). Lane run 2026-10-20/21 by a
`discovery-agent:evidence-researcher`; sources accessed 2026-10-20 or 2026-10-21. **[F]** is a
sourced fact, **[I]** is the researcher's inference. "L3" refers to
[`../2026-10-19-landscape/03-compute-fabric.md`](../2026-10-19-landscape/03-compute-fabric.md).

## 1. Executive summary

1. No off-the-shelf distributed build or test system fits a JS/TS + Playwright + Docker repo on a
   mixed Mac/Windows/Linux fleet. The REAPI family (Bazel, BuildBuddy, Buildbarn, NativeLink)
   needs a Bazel or REAPI-client migration; Playwright under remote execution is not documented
   end to end [S10]. Nx Agents is the only JS-native distributed executor, and running it on
   your own machines needs Nx Cloud Enterprise [S2, S3]. Reusable pieces:
   - task-output caches: Turborepo (MIT), moon (MIT) and the Nx self-hosted cache OpenAPI spec
     [S1, S5, S9];
   - Playwright `--shard`, blob reports, `merge-reports` and `run-server` [S14];
   - remote BuildKit and a registry pull-through cache [S15, S18];
   - git bundles and bundle URIs [S19].
2. Cache poisoning is a documented failure mode. Nx deprecated its free self-hosted cache
   plugins on 2026-05-21 because of CREEP (CVE-2025-36852), and its spec now requires `409` on
   overwrite [S1]. [I] Guanxi's fenced `refs/guanxi/attempts/*` model should extend to shared
   caches: attempts write into an attempt-scoped namespace, and only accepted completions
   promote entries.
3. Most schedulers don't fit this fleet:
   - Nomad is BUSL-1.1 (L3);
   - k3s has no Windows (L3), and k0s Windows workers are experimental [S23];
   - Slurm has no macOS (L3);
   - Ray multi-node on macOS is untested (L3);
   - CI agents (GitHub runners, Buildkite) route by label or queue only and have no resource
     requests [S25, S27].

   HTCondor (Apache-2.0; macOS, Windows, Linux) is the closest conceptual prior art [S20]:
   partitionable slots with `request_cpus/memory/disk`, a "Desktop" owner policy (start when the
   keyboard has been idle for more than 15 min, suspend when the user returns), and WoL through
   `condor_power` and `condor_rooster`. It is too heavy for one person to run; mine it for ideas.
4. Host-wide awareness needs signals specific to each OS:
   - Linux and WSL: PSI `some/full avg10` [S28];
   - macOS: kernel memory-pressure level [S30], thermal state and user idle time [S32];
   - Windows: `os.loadavg()` is always `[0,0,0]` [S38], `GetLastInputInfo` is session-scoped
     [S37], and NVML in WSL cannot report active compute processes [S35].
5. Headroom reservation has precedents: Kubernetes allocatable = capacity − reserved − eviction
   threshold [S39], Nomad `reserved` [S22], and the HTCondor presence policy [S20]. Each OS can
   enforce it:
   - cgroup v2 and systemd `CPUWeight`/`MemoryHigh`/`MemoryMax` [S29];
   - Windows Job Objects [S36];
   - macOS only `taskpolicy` QoS and IO throttling (E-cores on Apple Silicon) [S31].
6. Job-size estimation should use decayed-histogram percentiles, not a plain EMA. Google
   Autopilot uses a 12 h CPU half-life, p90–p95 for serving and peak or p98 for memory [S40];
   VPA uses about p90 plus a 15% margin and an OOM bump [S41]. Nx Agents packs work by CPU,
   memory and duration seen in earlier runs [S2].
7. Coding-agent prior art in 2025–2026 converged on "your machine as a worker, the vendor's
   control plane":
   - Claude Code self-hosted runners (beta, Aug 2026; Linux and macOS, not Windows) [S51];
   - Cursor "My Machines" and Team Pools [S53];
   - Devin Outposts [S54];
   - Copilot coding agent on self-hosted runners [S65].

   Isolation is per session. None of the sampled tools places work by measured host load across
   the user's machines: Paseo, Emdash and Xum let the user pick a host by hand [S62–S64].
   Per-workspace port blocks are the convention, for example Conductor's 10 ports [S56].
8. Scale and WAN: Consul uses LAN gossip per datacenter plus a WAN pool [S66], Nomad federates
   regions [S22], and Sparrow combines sampling with late binding [S67]. Tailscale DERP can fall
   to a few Mbit/s, and peer relays were about 12× faster in one example [S48], so placement
   must account for bandwidth.
9. Fully local AI across mixed machines:
   - Splitting one model across a Mac and a CUDA box works only through llama.cpp RPC, which
     describes itself as "proof-of-concept… fragile and insecure" [S70], or Parallax (Apache-2.0,
     early) [S74].
   - exo 1.x is CPU-only on Linux [S69].
   - vLLM and SGLang multi-node need identical Linux environments [S71, S72].
   - MLX distributed is Mac-only [S73].
   - Ollama has no multi-node mode [S77].
   - Petals has been inactive since 2024-09.

   [I] Default to whole-model placement plus MoE expert offload. A loaded large model is a
   protected **residency lease** that build and test admission must respect.

## 2. Evidence highlights

### Remote build and test execution

- BuildBuddy: the core is MIT, but remote build execution is enterprise-only [S8].
- Buildbarn and bazel-remote are Apache-2.0 [S6].
- NativeLink is FSL-1.1-Apache-2.0, with BSL modules since 2026-05-29 [S7].
- Turborepo (MIT) offers a remote cache with an OpenAPI spec and HMAC artifact signing, and no
  distributed execution [S5].
- Nx: free self-host plugins are deprecated (CREEP); a custom server must return `409` on
  overwrite [S1]. Nx Agents assigns work using `dte.scheduling-constraints` [S2].
- Playwright:
  - sharding balances by count or file, not by duration;
  - blob reports and `merge-reports` combine shards;
  - `run-server` with `connectOptions` runs remote browsers, and the client and server versions
    must match [S14].
- BuildKit `remote` driver: plain TCP gives unauthenticated access, so TLS is required [S15].
  The registry mirror covers Docker Hub only, one upstream per mirror [S18].
- Dagger: no supported remote engine [S13]. Earthly OSS has stopped; the EarthBuild fork is
  MPL-2.0 [S12].
- Not applicable to JS:
  - sccache-dist (Linux/FreeBSD servers, compilers only) [S11];
  - distcc and icecream (GPL, C/C++) [S6];
  - the Gradle cache [S16].
- Nix remote builders declare `URI, systems, maxJobs, speedFactor, supportedFeatures`, and Nix
  prefers the fastest machine after taking load into account [S17]. [I] This is a good schema
  for Guanxi node capability declarations.

### Schedulers

| System | Resource model | Sleep / WoL | Fit [I] |
| --- | --- | --- | --- |
| HTCondor | p-slots, request_cpus/memory/disk, custom resources | `HIBERNATE`, `condor_power` (UDP WoL, same subnet), `condor_rooster`, offline ads | best ideas, heavy daemons |
| Slurm 26.05 | cores/mem/GRES | `SuspendProgram/ResumeProgram`, power states | no macOS |
| Nomad | cpu/cores/memory, client `reserved` | none | BUSL-1.1 |
| k3s / k0s | requests/limits | none | no Windows / experimental |
| GitHub runners | labels only, one job per runner | none | CI only |
| act | Docker, Ubuntu images, ports collide in matrix jobs | — | local replay only |
| Buildkite | queues and tags, no CPU or memory requests | — | SaaS control plane |
| pueue (Apache-2.0) | groups and parallel limits, single host | — | local queue design reference |

### Host resource awareness

- **Linux and WSL:**
  - PSI `/proc/pressure/{cpu,memory,io}` with per-cgroup pressure and poll triggers [S28];
  - systemd resource control [S29].
- **macOS:**
  - `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` normal/warn/critical [S30];
  - `ProcessInfo.thermalState` [S32];
  - idle time from `CGEventSourceSecondsSinceLastEventType` plus `IOPMCopyAssertionsStatus`
    [S32];
  - `taskpolicy -b` [S31].
  - [I] macOS has no cgroups, so memory caps need container-VM sizing or watchdog kills.
- **Windows and WSL2:**
  - `.wslconfig` defaults [S33]: memory is 50% of host RAM, `autoMemoryReclaim=dropCache`,
    `vmIdleTimeout` is 60 s and `instanceIdleTimeout` is 15 s;
  - keep repositories in the WSL filesystem, not `/mnt/c` [S34];
  - NVML in WSL is limited [S35];
  - Job Objects give CPU rate caps and memory limits [S36];
  - `GetLastInputInfo` is session-specific [S37]. [I] A small helper in the user's session is
    needed.
- **Estimator [I]:**
  - key `(repo, task_kind, node_class, lockfile_hash)`;
  - track peak RSS, CPU-seconds, wall time, disk written and browser count;
  - request = decayed p90 peak RSS × 1.15;
  - duration = EMA of wall time per node class, plus a learned `speedFactor`;
  - an OOM bumps the estimate;
  - a cold start uses a per-kind default with confidence `unknown`.

### Coding-agent prior art

| Product | Where work runs | Isolation and contention |
| --- | --- | --- |
| Claude Code cloud sessions | VM per session or self-hosted [S50] | network allowlist, credential proxy, idle expiry; bundle upload excludes untracked and secret-looking files |
| Claude Code self-hosted runners (beta) | Linux and macOS, not Windows [S51] | `--capacity`, idle release, kill-after, drain; outbound-only |
| Codex cloud | OpenAI containers [S52] | setup online, agent offline by default |
| Cursor self-hosted (My Machines, Team Pools) | agent loop in the cloud, tools on the worker [S53] | one agent per worker, idle release |
| Devin | VM per session; Outposts [S54] | shared VMs compete for resources at a lower concurrency cap |
| Copilot coding agent | Actions and ARC runners [S65] | ephemeral single-use runners |
| OpenHands (MIT) | Docker, process or remote [S55] | Runtime API |
| Conductor | worktrees | 10-port block per workspace [S56] |
| Emdash, Paseo (Apache-2.0); Xum, Claude Squad (AGPL) | worktrees, local or SSH | host chosen by hand |
| Vibe Kanban, Crystal, Terragon | — | sunset, renamed or shut down [S58–S60] |

### Scale and WAN [I]

1. Make the site (LAN or datacenter) a failure domain: gossip inside a site, summaries across
   sites.
2. Above roughly 50–100 nodes, or across sites, switch to Sparrow-style sampling plus late
   binding, and make an offer a short reservation lease.
3. Lease TTLs and failure detectors should scale with RTT.
4. Keep a git mirror, a CAS artifact cache and a registry pull-through cache in each site; fetch
   large outputs lazily.
5. Score candidates by expected transfer time, using the link type from `tailscale status`.
6. Owned hardware costs energy, wear and interactive disruption; split capacity fairly with DRF.

### Distributed inference on owned machines

| Runtime | Licence | One model across Mac + CUDA? | Maturity |
| --- | --- | --- | --- |
| llama.cpp RPC | MIT | yes, in principle [S70] | "proof-of-concept… fragile and insecure" |
| Parallax | Apache-2.0 | claimed (MLX + SGLang/vLLM) [S74] | early, v0.0.1 |
| exo 1.x | Apache-2.0 | no (Linux is CPU-only) [S69] | active |
| MLX distributed | MIT | no (Mac-only) [S73] | mature for Mac to Mac |
| vLLM / SGLang | Apache-2.0 | no (identical Linux) [S71, S72] | production |
| distributed-llama | MIT | CPU/Vulkan on all OSes [S76] | niche |
| Ollama | MIT | no multi-node [S77] | — |
| Petals | MIT | — | inactive since 2024-09 |

- **Kimi K2** has 1T parameters (32B active) and ships in INT4. That is about 520 GB of
  weights, more than this fleet holds without two or more large Macs over TB5, or the cloud
  [S79].
- **[I] Residency lease.** A resident model holds `model-resident:<node>:<digest>`, which
  reserves its weights plus KV cache. Build and test capacity is then capacity − interactive
  reserve − OS reserve − residency − Docker VM. Tests can be preempted; residents are never
  evicted for a test.
- **[I] Gang lease.** Distributed inference needs a lease across every participating node.
- **[I] Interference.** Measure tokens/s under a build load and store an interference
  coefficient per node.

## 3. Candidate recommendations (researcher's options)

### A. Placement and quota for 6 agents on 3 machines

- **MacBook:**
  - while the user is present, keep about 50% of the P-cores free and memory pressure normal;
  - run only light jobs under `taskpolicy -b`;
  - run Docker and e2e only after 15 min idle, on AC power, at a fair thermal state;
  - suspend or requeue those jobs when the user returns.
- **Always-on Mac:** inference first (residency leases), then build and test in what is left.
- **Windows/WSL2:** the build and test primary.
  - Set `.wslconfig memory` explicitly.
  - Keep repositories on ext4 and run dockerd inside WSL.
  - Set `instanceIdleTimeout=-1`.
  - Run CUDA inference natively on Windows.
- **Typed slots:** `cpu.heavy(k)`, `browser(k)`, `compose(k)`, 10-port blocks and GPU/unified
  memory bytes.
- **Per-agent limits:** at most one heavy job and one e2e job at a time, with DRF across
  agents.
- **Priority:** the interactive user, then blocking agent steps, then speculative tests, then
  scavenger work. Agent attempts are never preempted; tests can be cancelled and requeued.

### B. Dispatch

1. Score the candidates: wake latency, history-based duration, cache warmth, transfer time,
   interference with resident models and a presence penalty.
2. Send offers to the top 2–3. Each replies with a short reservation; bind to the first that is
   ready (late binding).
3. On the executor, start from the local mirror and apply the agent's diff as a git bundle into
   `refs/guanxi/attempts/<id>` and a worktree.
4. Restore caches keyed by lockfile, Playwright version and image digest, then take the port,
   compose and database leases.
5. Stream logs in sequenced chunks, with heartbeats renewing the leases.
6. Send small artifacts with the completion; traces and videos stay in the executor's CAS and
   are fetched lazily.
7. Merge shards with `merge-reports`.

### C. Escalating to rented machines

Only when the run policy and the budget ledger allow spending, and at least one of these holds:

- no owned node passes the hard filters;
- the deadline would be missed even after counting provisioning time;
- the owned nodes are unreachable and waking them failed.

Prefer stateless e2e shards for rented machines, and never send secret-heavy runs.

### D. Pitfalls to record as node facts

- **WSL:**
  - `/mnt/c` is slow;
  - the 50% memory default and the `dropCache` reclaim;
  - the idle shutdown;
  - clock drift after the host sleeps, still reported in 2025-12 [S49], which can exceed the
    60 s HLC window;
  - limited NVML.
- **macOS:** the Docker VM takes 50% of memory and Resource Saver adds a cold start [S43].
  Apple `container` needs macOS 26 [S44], and containers have no Metal.
- **WoL:** Tailscale cannot send magic packets, so a sender on the LAN is needed [S47]. Macs need
  "Wake for network access" [S45]. Windows wakes only from S3 or S4, not from Fast Startup or S5
  [S46].
- **NAT:** DERP throttling, so prefer peer relays [S48].

## 4. Contradictions and gaps

- **Fleet specification:** L3 says the Windows PC has 32 GB RAM and 12 GB VRAM and lists a
  256 GB Mac Studio; the owner's latest example mentions a 128 GB PC. The owner must confirm.
- **Conflicting sources:**
  - the GitHub self-hosted runner fee (postponed or in effect);
  - exo on Linux;
  - Playwright `connectOptions`;
  - VPA percentiles;
  - the `iogpu` defaults;
  - the Emdash licence;
  - WSL clock drift;
  - the macOS pressure-level mapping;
  - Nx self-host history.
- **Not verified:**
  - Autopilot primary PDF (HTTP 403);
  - Parallax on Windows and an actual Mac + CUDA run;
  - llama.cpp RPC performance mixing Metal and CUDA;
  - Kimi K2 checkpoint size;
  - no measurements on the owner's fleet yet (link types, interference, Playwright memory).

## 5. Sources

All accessed 2026-10-20/21. **S1** nx.dev self-hosted-cache-packages deprecation (2026-05-21);
**S2** nx.dev distribute-task-execution; **S3** nx.dev bring-your-own-compute, pricing; **S4**
nx.dev blog custom-runners-and-self-hosted-caching (2025-03-31); **S5** turborepo.dev remote
caching; **S6** GitHub REST metadata for the repositories named above; **S7** nativelink.com
license and terms (2026-05-29); **S8** buildbuddy.io config-rbe and LICENSE; **S9**
moonrepo.dev remote-cache, blog v1.30; **S10** aspect rules_js, mrmeku/rules_playwright,
mikn/rules_typescript#202; **S11** mozilla/sccache Distributed.md; **S12** earthly.dev
shutting-down (2025-04-16), EarthBuild; **S13** docs.dagger.io custom-runner, dagger#9516;
**S14** playwright.dev test-sharding, docker, playwright#43106; **S15** docs.docker.com remote
driver; **S16** docs.gradle.org build_cache; **S17** nix.dev conf-file, distributed-builds;
**S18** distribution mirror recipe; **S19** git-scm bundle-uri; **S20** htcondor.readthedocs.io
ep-policy-configuration, power-management, condor_power, htcondor-users 2026-March; **S21**
slurm.schedmd.com power_save; **S22** developer.hashicorp.com nomad client, resources,
preemption, federate-regions; **S23** docs.k0sproject.io experimental-windows; **S25**
docs.github.com self-hosted runners, 2026 pricing changes (2025-12-15); **S26** nektosact.com
not_supported; **S27** buildkite.com queues; **S28** docs.kernel.org psi; **S29** freedesktop
systemd.resource-control; **S30** apple-oss-distributions/xnu memorystatus_notify.md; **S31**
manp.gs taskpolicy, eclecticlight.co (2022-10-20); **S32** developer.apple.com thermal state,
CGEventSourceSecondsSinceLastEventType, forums 25509; **S33** learn.microsoft.com wsl-config
(2026-10-16); **S34** wsl filesystems (2026-06-02); **S35** docs.nvidia.com cuda wsl-user-guide;
**S36** jobobject_cpu_rate_control_information; **S37** GetLastInputInfo; **S38**
nodejs.org/api/os (v26.12.0); **S39** kubernetes.io reserve-compute-resources; **S40** Autopilot
EuroSys 2020 (PDF 403; slides and secondary summary); **S41** CNCF VPA blog (2023-02-24);
**S42** iogpu wired-limit notes (secondary); **S43** docs.docker.com desktop settings; **S44**
github.com/apple/container; **S45** support.apple.com wake for network access, sleep proxy;
**S46** learn.microsoft.com wake-on-lan, system power states; **S47** tailscale.com blog
wake-on-lan-tailscale-upsnap; **S48** tailscale.com connection types, peer relays; **S49**
microsoft/WSL#13867 (2025-12), #4245; **S50** code.claude.com claude-code-on-the-web; **S51**
code.claude.com self-hosted-environments, reference, whats-new 2026-w32; **S52**
developers.openai.com codex cloud environments, internet access; **S53** cursor.com self-hosted
docs and blog, Cloudflare changelog 2026-09-02; **S54** docs.devin.ai environment, dynamic
workflows, outposts; **S55** docs.openhands.dev sandboxes; **S56** docs.conductor.build; **S57**
imbue-ai/sculptor; **S58** terragon-labs/terragon-oss; **S59** BloopAI/vibe-kanban, shutdown
(2026-04-10); **S60** stravu/crystal; **S61** smtg-ai/claude-squad; **S62** coder/xum; **S63**
getpaseo/paseo; **S64** generalaction/emdash, HN 47140322; **S65** GitHub changelog 2025-10-28
Copilot self-hosted runners; **S66** developer.hashicorp.com consul gossip; **S67** Sparrow
SOSP 2013; **S69** exo-explore/exo (v1.0.71, 2026-04-23); **S70** llama.cpp rpc README; **S70b**
llama.cpp server README; **S71** docs.vllm.ai parallelism_scaling; **S72** docs.sglang.io
pipeline parallelism; **S73** ml-explore mlx distributed; **S74** GradientHQ/parallax,
docs.gradient.network, arXiv 2509.26182; **S76** b4rtaz/distributed-llama; **S77**
ollama/ollama#4643; **S79** huggingface.co moonshotai Kimi-K2 Instruct, Thinking, K2.6.
