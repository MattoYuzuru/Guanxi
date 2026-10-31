# Stage status

**Status:** implemented tracker · **Updated:** 2026-10-31
**Current stage:** wave 8 (branch `lead/wave8`, 2026-11-01) — MS2 track. Wave 7 merged into `main` as `a1ba986b` (PR
MattoYuzuru/Guanxi#3, hosted gate green: run 41209344464). MS1 closed 2026-10-31 (D-214, D-219); desktop platform order macOS →
Linux/Fedora → Windows (D-221).

## Wave 8 (2026-11-01)

Three lanes, each by a Sonnet 5.5 author with separate Sonnet 5.5 reviews (two rounds each) and fixes in separate commits:

- **U2 macOS desktop, first slice** ([hand-off](lanes/U2-macos.handoff.md), `packages/desktop`): Electron shell that attaches
  to or starts the node as a detached service on a pinned official Node.js 26.9.0 (digest-verified, `RunAsNode` fuse off),
  sandboxed renderer with one preload function, navigation locked to the loopback origin, gesture-gated external links, CSP,
  listener ownership checks (`lsof` uid/pid) before attach and stop, localized failure screens with automatic recovery,
  unsigned arm64 DMG; signing/notarization env-driven and not run. Exit gates tested: window close and app quit leave the
  service and a run alive (detached process group); the renderer has no Node access. Owner questions Q-247/Q-248 (bundled
  LGPL `libffmpeg`, WTFPL build tool) gate a distributed DMG; a signed release needs the Apple Developer Program (D-156).
- **U3 route authorization** ([hand-off](lanes/U3-route-authz.handoff.md)): one fail-closed `can()` hook over 165 routes
  (HEAD as GET, unmapped → refused, boot check), local owner only for a loopback socket peer, proxy headers refused,
  reasoning owner-only at the source, owner-only filesystem/exec/settings routes, minimal health for non-operators, and the
  remote bind refused at boot (exit 78) without TLS, accounts, credentials and roots. Q-246 (local-owner secret) proposed.
- **K4 queue-v3 Q1** ([hand-off](lanes/K4-queue-v3-Q1.handoff.md)): native reader and progress2 over v3 state, verified
  full-byte consumption with owner/fence checks up to dispatch, typed content-free failures, the restricted-reader rollback
  floor (v3 mutations refused with 409 until Q2).

Evidence — **new:** desktop 163 unit + 43 Electron tests; auth 56+ new tests (auth suite 89, route-reasoning 9); Q1 63 new
server tests plus CLI/web cases. **Regression envelope (local, focused):** affected server set 895; native-agent 92 + Q0 14;
web unit + localization 136; browser specs for native agent 20. Not run: signing/notarization, a mounted DMG, hosted desktop
tasks (first run on the wave PR), a real agent run through the window.

## Wave 7 (2026-10-31)

Four lanes, each by a Sonnet 5.5 author with a separate Sonnet 5.5 review (`sde-agent:implementation-reviewer`) and fixes in
separate commits:

- **MS1 relay residuals** ([hand-off](lanes/MS1-relay-residuals.handoff.md)): a composed `cd <checkout>` that fails exits 125
  with a per-call marker line and is an infrastructure failure (`cwd_unavailable`), not a red gate; the relay `shell` tool's
  fixed-command branch returns a non-zero exit with scrubbed, bounded output instead of `tool_failed`.
- **Lead project view** ([hand-off](lanes/LP-lead-project-view.handoff.md)): opt-in (`home.lead.projectView` /
  `leads.projectView`, default off — lead default 2026-10-31) read-only `guanxi_project_tree|read|search` on the lead's
  `mcp__guanxi` server over committed git objects only; hidden-name policy applied before any blob is read, whole-blob
  scrubbing, no oracle about hidden files in search, `GIT_NO_LAZY_FETCH`, bounded and cancellable. Two review rounds.
- **B3-b smoke runner** ([hand-off](lanes/B3-b-smoke.handoff.md), [runbook](../../packages/bench/RELAY_SMOKE.md)): five
  `ledger-lite` tasks from `Guanxi-Test-Repo`, an owner-API runner with resume, stop-before-next and fingerprints, emitting
  `guanxi.b3.measurement/v1` for the B3-a validator; descriptive only.
- **B3-c naive arm** ([hand-off](lanes/B3-c-naive-arm.handoff.md)) and **B3 integration**
  ([hand-off](lanes/B3-integration.handoff.md)): a default-off, bench-only `home.relayCompaction: "naive"` relay mode
  (refused together with `home.lead`), recorded per attempt; arms run as restart-per-arm passes; the runner confirms each
  trial's arm from the run's own notes and the home database, refusing mixed or unconfirmed runs; drift pinned by driving
  the real relay executor.

Evidence — **new:** relay residuals 8 tests; project view 41 tests (+ mutation sets of 25, 20 and 17); B3-c 22 tests with a
default-path digest pin; bench 112 new tests (281 total) and 128 mutation cases plus 19 server-shape mutants.
**Regression envelope (local, focused):** relay + native-agent 432; leads/ms1-live/indexing/rehearsal 210; relay + ms1-live +
llama-server 532; bench 169. Not run: a real model, the Fedora node, the macOS container path. The real B3 smoke cohort
(ledger pass, then naive pass) is the next step on the Fedora pair.

## Wave 6 (2026-10-24, merged)

Branch `lead/ms1-close` (integration candidate) adds, each independently reviewed by Opus 5.5 with fixes in separate
commits: **MS1 lead/relay hardening** from eleven defects found on real runs (user API key family `sk-ant-usr`, the lead's own
MCP tool pre-allowed, finished-lead restart, zero money cap, bounded transient call retries for link drops and restarts,
bounded executor stop, wake prompt and stop reasons in the packet, allowed executors and argv acceptance in the delegate
tool, relay shell in its checkout with visible output, probes answering from the handoff strip); **K3 catalog**
(provider catalog by category, auto local Ollama connection with installed models, catalog-named imports without
duplicates, connection removal, the `/connections` centre and a catalog model picker, D-218); **UI round 4** (one timeline
session view, layout and panels behind one icon menu, Developer/Visual split withdrawn per D-217, Models grid, quieter text,
round-3 fixes). **Real evidence** ([MS1 fault runs](evidence/ms1-fault-runs-2026-10-24.md)): E1 link drop, E2 executor
restart, E3 runtime restart survived on the Fedora executor; E4 home restart ends with one honest wake; zero lead tokens
while asleep; exactly one wake in every run; run **A7 closed all ten `ledger-lite` items** with the lead asleep for 2 h 29 min at zero lead tokens and E1–E3 injected,
reproduced 93/93 in a clean checkout. The MS1 exit of D-214 is met; the B3 gate moved to MS2 (D-219, 2026-10-31). Earlier wave: [Fedora record](evidence/fedora-real-runtime-2026-10-23.md).

## Wave 6 evidence (2026-10-24)

- **New:** MS1 real runs A–A7 and B with E1–E4 injected ([record](evidence/ms1-fault-runs-2026-10-24.md)); focused tests added
  with each fix (each checked to fail without its fix): K5 key family, lead tool permission, finished-lead restart, zero
  money cap, transient retries (call, observe, count, measure), bounded executor stop, wake prompt and stop facts, executor
  hint and argv acceptance, relay shell cwd and output, probe strip; K3 catalog, Ollama auto connection, import families and
  removal; connections centre and picker component and browser specs; UI round 4 session view, panels menu, phone sheet,
  Models cards and render-count tests.
- **Regression envelope (local, focused per D-213):** server relay/leads/ms1-live/external-agents/connections/remote/federation
  suites 1 155 tests green at the lane merge points; web component suite 747/747; affected browser specs 68 (63 + the 5
  rewritten new-session cases) and the runtime-health spec; `ui:check` green after regenerating the catalog manifest. Hosted
  CI evidence is in PR MattoYuzuru/Guanxi#2.

## Validation protocol migration (2026-10-24)

D-213 moves final full checks to parallel hosted CI and local iteration to affected modules.
Implementation/research, **new / regression envelope** evidence, independent review and
hosted run state are tracked in [CI migration evidence](../research/2026-10-24-ci.md).
This operational slice does not close any product-stage exit. Restart from [NEXT_AGENT_PROMPT](NEXT_AGENT_PROMPT.md); the older
[restart prompt](CLAUDE_LEAD_RESTART.md) is superseded.

Short mutable tracker. Scope and exit gates live in [ROADMAP](ROADMAP.md); decisions in
[decisions/](../decisions/README.md). Statuses: `not started`, `in progress`, `blocked`,
`implemented`, `independently verified`.

The legacy Alamo tracker (Phases 0–3, slices P0-A–P3-Q, all evidence) is preserved in
[`docs/legacy/alamo/plans/PHASE_STATUS.md`](../legacy/alamo/plans/PHASE_STATUS.md). That code
is still what runs today; it is ported into the new stages rather than discarded.

## S0 — Re-foundation

| Item | Status | Evidence |
| --- | --- | --- |
| Rename Alamo → Guanxi (clean, D-101) | implemented | 250 files; no `alamo` identifier remains outside Markdown (`grep -ril alamo` over non-`.md` files is empty); Markdown mentions are historical |
| Apache-2.0, NOTICE, THIRD_PARTY_NOTICES (D-102) | implemented | `LICENSE` SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` (canonical apache.org text) |
| Research lanes 1–7 | implemented | [research](../research/README.md); ~8,000 lines with dated sources; lane 7 covers agent work methodology |
| Requirements, vision, target architecture | implemented | [REQUIREMENTS](../vision/REQUIREMENTS.md), [VISION](../vision/VISION.md), [TARGET_ARCHITECTURE](../architecture/TARGET_ARCHITECTURE.md) |
| ADR-0015–0032, owner decisions D-101–D-122 | written (ADRs are mostly `proposed`) | [decisions](../decisions/README.md) |
| Roadmap graph | written (proposed structure) | [ROADMAP](ROADMAP.md) and the canonical render [roadmap.mmd](roadmap.mmd); 46 nodes, ROADMAP↔mmd dependency check: 0 mismatches. A private interactive view exists for the owner. |
| Independent docs review | implemented | separate session with `product-agent:requirements-critic` and `architecture-agent:adversarial-architect`: 4 Critical, 12 High, 19 Medium, 13 Low; all fixed in the docs (owner approved "fix all"); design-level items attached to stages as "Before starting" obligations; clarifications recorded as D-116–D-120 |
| Markdown lint | implemented | `npm run lint:md` (markdownlint-cli2 0.18.1, repo config, raw research excluded per D-120): 0 errors |
| Dependency license gate | implemented locally | `npm run check:licenses`: 251 packages, 0 disallowed; fails on an AGPL fixture and on a package without a license (manual check); CI wiring waits for a CI pipeline |
| Commit | implemented | `a6fd314` rename, `aa257c1` license and gates, `6e6b63c` legacy archive, `3194f41` research, `be89bb9` canonical docs (review fixes included because the docs had never been committed) |
| Notification center design | implemented (docs) | ADR-0033, D-123–D-125, stage NC1, REQ-J3–J5 |
| Open questions | implemented (docs) | the owner accepted every recommended default in chat on 2026-10-20: Q-201–Q-230 and Q-233–Q-244 are D-141–D-182 in the [2026-10-20 addendum](../decisions/2026-10-20-owner-decisions-addendum.md); ADRs 0018, 0019, 0025, 0026, 0028, 0029, 0031, 0032, 0035, BRAND, REQUIREMENTS A5 and each ROADMAP stage cite the decisions; [OPEN_QUESTIONS](OPEN_QUESTIONS.md) has none open. D-157 also fixes the transcription of inflected English terms, a sub-question the recommended default did not cover. |
| Design system documentation | implemented (docs) | `docs/design/` (brand book, principles, foundations, layout and screens, components and catalog), ADR-0034–0036, D-127–D-140, `.agents/skills/guanxi-ui`, four design research lanes; palette contrast re-computed for the chosen combination (all ≥ 4.5:1 text, ≥ 3:1 UI). Owner preview page "Guanxi Glacier": <https://claude.ai/code/artifact/59348be6-49a3-4044-9a5e-a49b08daa2c1> (private) |
| Logo assets | implemented | `assets/brand/guanxi-gx-v1/` (D-126); `build.mjs` reproduces `logo.svg` byte-identically (SHA-256 `f6d5226e…ba7a`) |

### S0 regression envelope (legacy code after the rename, 2026-10-19)

- `npm run typecheck` — pass.
- `npm run test:core` — 669/669 pass (regression envelope, 0 new).
- `npm run test:web` — 244/244 component tests in 28 files pass (envelope).
- `npm run build` — pass.
- `npm run test:web:browser` — 40/40 in 5 of 7 full runs. One failure in
  `catalog-variant-install.spec.ts` (passes 6/6 in isolation) and one earlier unidentified
  failure in the first run, right after a fresh Chromium download. The SSE event name is a
  single contract constant, so the rename is not a plausible cause, but the pre-rename flake
  rate was not measured. **Residual, accepted for S0:** investigate the flaky catalog test
  before the next web slice. **Closed 2026-10-20**; see the next section.
- Environment note: Playwright 1.62.1 needed `chromium_headless_shell-1234`; installed with
  `npx playwright install chromium` from `packages/web`.

### S0 residual closed: browser gate flakes (2026-10-20)

**Status:** independently verified. Commits: fixes `3f0eaf1` and `f77780b`, review fixes
`15c30a5`, test fix `ebd061f`.

Baseline at `517e080`: 12 of 15 consecutive full `npm run test:web:browser` runs were green.
The failures came from three root causes. Two were real product bugs; the third was a mock
that depended on React StrictMode timing.

- **Catalog install dialog unmounted** (`catalog-variant-install.spec.ts`, 1 of 15). Since
  `cc40d14` the Marketplace showed a skeleton for every catalog refresh, including the one
  `onInstalled` starts after a successful variant pull. The skeleton unmounted the card that
  owns the install dialog. A DOM probe measured the success dialog with the verified digest
  at 6–10 ms before it vanished, after which focus dropped to the document. The spec passed
  only when its first poll landed in that window.

  Fix: when the catalog shows settled rows for the current basis, the post-install refresh
  re-reads both lists in place and on the same page. Basis changes, explicit Refresh and
  Retry still show the skeleton. The install revision is part of the compare evidence basis.
  After the dialog closes, focus returns to the chosen variant once the install button has
  been replaced by links.
- **Focus scheduled before the commit** (`quick-runs.spec.ts`, 2 of 15; latent in
  `attachments.spec.ts`). Focus after an async failure was scheduled with
  `requestAnimationFrame` from the async handler. When a frame ran before React committed the
  alert, there was nothing to focus yet and focus was lost. An adversarial run of the full
  gate, with top-level frames forced before commits, failed exactly these two specs and
  nothing else.

  Fix: focus moves in an effect after the commit. This covers the Quick Run retention
  failure, attachment upload completion and attachment download failure. The new fixture
  `test/browser/fixtures/frame-order.ts` is a switch that forces that frame ordering only
  around the step under test.
- **Quick Run load-failure mock depended on StrictMode timing** (`quick-runs.spec.ts:157`).
  Seen once, in run 8 of 11 at `15c30a5`; most likely also the unidentified S0 first-run
  failure. The development entrypoint runs React StrictMode, so the first load request is
  aborted and replaced. The mock failed exactly the first two requests and assumed the
  aborted one always reaches the route. The trace showed it aborted before interception, so
  Retry received the second failure.

  Fix: every initial request fails until Retry is pressed. Request counts are now asserted
  relative to the observed initial count: Retry issues exactly one request.

Evidence (**5 new / 40 + 669 + 244 envelope**):

- New: 5 component tests.
  - Four are in `catalog-pagination.test.tsx`:
    - the page 2 install keeps its page and dialog;
    - compare rows are cleared on install and again when the refresh lands, and focus is kept
      when Done comes first;
    - an install during another basis load keeps the skeleton;
    - the skeleton shows for page, query, Refresh and Retry.
  - The fifth is the download failure focus test in `attachments.test.tsx`.
- Three browser specs were strengthened:
  - catalog: the dialog must survive the committed refresh; the mocked pull is held until
    both double-click clicks land; Done and focus are now asserted;
  - quick-runs and attachments: focus is asserted under forced frame order, plus focus after
    a successful upload.

  The quick-runs request-count assertion was rewritten from an absolute 3 to "initial
  (1 or 2) + exactly 1 for Retry". It still fails on an extra or missing Retry request.
- Negative controls:
  - With the four source files reverted to `517e080` and the new specs kept, 9 of 9 browser
    runs failed.
  - With the scoped switch, quick-runs and attachments on the old components failed 6 of 6.
  - Each new component test fails against the code it guards (5 mutation checks).
- Regression envelope:
  - full gate: 25/25 consecutive green at `f77780b`; 10 of 11 at `15c30a5` (stopped after
    the StrictMode mock failure); then **25/25 consecutive green at `ebd061f`**. Each green
    run is 40/40 in about 28 s, on a clean tree, under the shared heavy-check lock.
  - `npm test`: core 669/669 and web 249/249 (244 envelope + 5 new).
  - `npm run typecheck` and `npm run build` pass.
  - `ebd061f` is the last behavioural commit; later commits change only a source comment and
    docs.
- Independent review by `frontend-agent:accessibility-reviewer`:
  - on `517e080..f77780b`: 2 major, 5 minor and 2 nit findings. Findings 2–8 were fixed in
    `15c30a5`, and a re-review confirmed all seven closed with no new regressions.
  - Its remaining notes are listed below.

Residual risks:

- The install dialog is still owned by its catalog card. If a filter hides the installed
  variant or model, or if the in-place refresh fails (the error callout replaces the cards),
  the verified result is still lost and focus can drop to the document. This predates the
  slice. A proper fix lifts the result out of the carousel.
- A real pull can finish within a double-click (for example, when the model is already
  present). The second click can then hit the success dialog's dismissable backdrop. The spec
  now holds the mocked pull, so this path is untested.
- Quick Run retention Retry sits inside the alert, which unmounts on success, so focus drops
  to the document. This predates the slice.
- Review nits, all rare:
  - `catalogSettledRef` is updated in a passive effect, which leaves a window of one task
    after a basis change;
  - the variant focus fallback can also fire when another flow installs a variant this card
    has selected while focus is on the document;
  - legacy unpaged catalog responses skip the compare evidence basis (this predates the
    slice).

## Parallel lanes infrastructure

| Item | Status | Evidence |
| --- | --- | --- |
| Browser-gate flake fixes merged into `main` | implemented | merge `6518e57` of `claude/nostalgic-jackson-673c89` (25 consecutive 40/40 runs recorded above) |
| Per-worktree ports and data | locally validated | `GUANXI_WEB_PORT`, `GUANXI_API_PORT` and `GUANXI_DATA_DIR`, with one strict parser per side (`packages/web/dev-ports.ts`, `packages/server/src/config/listen-env.ts`). Independent review (`sde-agent:implementation-reviewer`) found 1 High, 1 Medium and 3 Low issues; all are fixed in a separate commit. New: 24 parsing and default tests (12 server, 12 web); browser gate 40/40 with `GUANXI_WEB_PORT=5199` while a decoy HTTP server held `127.0.0.1:5173`; the gate pointed at the busy port exits 1 with "already used"; `GUANXI_WEB_PORT=abc` exits 1 naming the variable. Envelope: typecheck, `npm test` (681 node + 261 vitest), `npm run build`. The High finding was nested Claude worktrees without their own `node_modules` resolving main's packages; both lane worktrees got `npm ci`, and the lane rules now require it. |
| Localization browser-gate flake | implemented, independently verified, merged (`4dd331c`) | Root cause: React StrictMode cleanup can abort a fetch before Playwright intercepts it. The spec now counts fetch lifecycles plus route-level reads and advances the paused clock past timer-driven reads. 25/25 consecutive full gates; Claude review mutations (XHR, lowercase method, timer reads) all fail as intended. Evidence: [evidence/flake-localization](evidence/flake-localization.md). |
| Project-chat focus flake | implemented, independently verified, merged | Tests asserted focus synchronously while focus moves in a requestAnimationFrame effect (since `7af0ed9`); reproduced 1/96. Controlled frame ordering and effect-aware assertions, product code unchanged; 50/50 loaded runs, 5/5 full suites, 49/49 browser. Claude review mutations: 20/20 non-equivalent mutants caught after its F1 fix. Evidence: [evidence/flake-project-chat](evidence/flake-project-chat.md). |
| Fleet, compute providers and remote control (design) | accepted direction (D-185–D-193), proposed design | [ADR-0038](../decisions/0038-compute-providers-fleet-placement-and-remote-control.md); three research lanes in [2026-10-21 fleet](../research/2026-10-21-fleet/); F3, F4, U4 and K5 rescoped, F5 added (51 roadmap nodes, 0 mismatches); REQ-A7, B3, B6–B10; the real fleet replaces the Mac Mini/Studio assumptions: MacBook M5 Pro 24 GB; the dual-boot PC (Ryzen 5 3600, 32 GB, RTX 3060 12 GB) running Fedora 44 as the always-on home (`ssh fedora`, inspected 2026-10-21: 427 GB free, the owner's workstation Qwen 27B holds 10.6 GB VRAM); a Fedora laptop (16 GB, RTX 2060) without SSH yet; `keykomi` VPS as relay. |
| First Linux node (Fedora PC) | locally validated | 2026-10-21, `ssh fedora` (Fedora 44, Ryzen 5 3600, 32 GB, RTX 3060 12 GB, Node 22.23.1): `main` cloned from a bundle into `~/Projects/Guanxi`; `npm ci`, typecheck, `npm test` (UI gates 50, core 690, kernel 106, web), browser gate 49/49 and build pass after fixing the lockfile (`d973246`: the macOS-generated lock lacked `@rollup/rollup-linux-x64-gnu`, npm/cli#4828, so every Linux x64 `npm ci` broke Vite, vitest and the build). Loopback smoke: `127.0.0.1:4310` only, `/api/health` reports the RTX 3060 (CUDA) and Ollama as `unavailable` (not installed); stopped after the check. The owner's workstation (Qwen 27B on llama.cpp at `127.0.0.1:8080`, Hermes, VPN, `keykomi` SSH relay, Claude Remote Control) was left untouched; 427 GB are free, so nothing needs removing. Node 22 on this host also covers the K1 residual about older Node. |
| Second Linux node (Fedora laptop) | locally validated | 2026-10-21, `ssh asus` on the LAN (ASUS TUF A15, Ryzen 7 4800H, 15 GB, RTX 2060 6 GB, Fedora 44, Node 22.23.1, in active use by the owner): `main` at `1243d3c` cloned from a bundle; with `nice -n 10`: `npm ci` (installs `@rollup/rollup-linux-x64-gnu` from the fixed lock), typecheck, `npm test` (UI gates 50, core 690, kernel 106, web), browser gate 49/49 and build pass. The first browser run failed loudly because another application holds port 5173 on `0.0.0.0` — the per-worktree port rule worked as designed; the rerun used `GUANXI_WEB_PORT=5185`. |
| Benchmark host (Fedora PC, D-194) | implemented, locally validated | 2026-10-21: `scripts/infra/provision-bench-host.sh` run through the owner's Keychain-backed sudo helper. It created the password-locked user `guanxi-bench` (uid 1001, subordinate ids, no device groups, linger) and capped `user-1001.slice` at 8 of 12 CPU threads, `MemoryHigh` 12 GiB and `MemoryMax` 14 GiB with low CPU/IO weight. A sudoers rule lets the operator act as that user without a password. Verified: rootless Podman 5.8 with systemd cgroups v2; a container's cgroup lies under `user-1001.slice`, with no NVIDIA device nodes and uid 0 mapped inside. All six workstation services stayed active, and the llama server still holds 10.6 GB VRAM. |
| Doc-link checker (`npm run check:links`, part of `lint:md`) | implemented, verified by the integrator, merged (`e16321f`) | First DeepSeek lane: DeepSeek-V4.1-Flash at max effort in DeepSeek Harness headless (overlay `Guanxi-lanes/infra/dsh-headless.patch.yml`), about 8 minutes. Checks relative links and GitHub-style anchors and reports missing files, missing anchors, absolute machine paths, bad encoding and (integrator addition) links outside the repository. New: 21 tests; the lane's four self-mutations and the integrator's `outside-root` mutation each fail a test. The integrator also probed nested brackets, parentheses in paths, escapes, Cyrillic/emoji headings and tables. It found and fixed four broken links on `main`. Evidence: [evidence/doc-link-check](evidence/doc-link-check.md). |
| Lane rules and prompts | accepted (owner, 2026-10-20) | [lanes/](lanes/README.md): owned paths, ports, `agent-dev --resource heavy` lock, hand-off files instead of status files, merge order K1 → DS1-a → DS1-b → DS1-c |

## K1 — Kernel

| Item | Status | Evidence |
| --- | --- | --- |
| Own plugin kernel `@guanxi/kernel` (ADR-0037; Cordis rejected by D-183) | implemented, independently verified, merged into `main` | Full evidence and residuals: [evidence/K1](evidence/K1.md). Exit gate on the own kernel: 100 reload cycles with an identical census; total heap +2.17% after 50 warm-up cycles (≤ 5%); every unloaded governor, fiber and context collected; boot 37–40 ms, 81 MB idle RSS; real-HMR slot test. **119 new / 982 regression envelope.** Reviews: implementation, adversarial architecture, accessibility, then three GPT cross-family rounds (14 + 5 findings, all closed; final verdict merge). Integrator gates on `main` after the merge: typecheck, `npm test` (core + kernel, web 264), browser gate 41/41, build, lint:md, licenses (251/0). |

## K2 — Session log, inspector, egress scrubber

| Item | Status | Evidence |
| --- | --- | --- |
| One append-only single-writer event log per session; crash-safe append and replay; durable payload-free readiness backlog; `egress.scrubber` kernel service with readiness; loopback-only interim inspector and query tool (ADR-0023) | implemented, independently verified, merged into `main` | Full evidence: [evidence/K2](evidence/K2.md). In-session reviews (implementation, architecture, accessibility) plus four GPT cross-family rounds; the final scoped check closed every item with no new High (14/14 mutations caught). Integrator gates on `main` after the merge: typecheck, `ui:check`, `npm test` (web 275), browser gate 50/50, build, lint:md, licenses 358/0. Residuals named in the evidence; the `project-chat.test.tsx` focus flake seen during K2 runs is being fixed in its own lane. |

## R1 — Durable runs, hibernation and wake (single node)

| Item | Status | Evidence |
| --- | --- | --- |
| Run attempts, fenced home and resource leases, promises, timers, outbox; `waiting_children`/`wrapping_up`; restart reconciliation; signals vs promises; exactly-once wake; cancel along the chain; per-run cost ledger; shared K2 session fence (ADR-0019) | implemented, independently verified, merged into `main` | Full evidence and residuals: [evidence/R1](evidence/R1.md). Author GPT/Codex; two Claude cross-family rounds (H1 boot after unclean shutdown and H2 self-fencing after stalls fixed; a 1.89M-operation fuzzer with clock skew, zombies and stalls found 0 violations). 628 crash points. Integrator gates on `main`: typecheck, `ui:check`, licenses 437/0, `npm test` (web 299), browser gate, build. Residuals go to the R1 follow-up lane. |

## K3 — Model access

| Item | Status | Evidence |
| --- | --- | --- |
| Connection registry with provenance; encrypted vault with a node-key boundary for unattended connections only (D-145); `secret://` refs and just-in-time injection; pi-ai with the Anthropic OAuth path blocked; recorded-fixture balance probes; cost ledger; whole-server Host allowlist against DNS rebinding; vault wired to K2's `egress.scrubber` readiness | implemented, independently verified, merged into `main` | Full evidence and residuals: [evidence/K3](evidence/K3.md). Author GPT/Codex; three Claude cross-family rounds (H1–H3 and M1–M6, then N1–N8, then a final check of the K2 integration with no High). The restart → tool print → K2 event test finds zero secret matches in storage, exports, inspector and query output. Integrator gates on `main`: typecheck, `ui:check`, licenses 437/0, `npm test` (web 298), browser gate, build. |

## K4 — Native agent

| Item | Status | Evidence |
| --- | --- | --- |
| Native agent on pi-agent-core with tools, two access modes and projects; `ExecutionOwner` that owns every descendant (Linux bubblewrap with a PID namespace; macOS one `--network none` container per command on Colima; Windows refuses); egress through the sandbox-runtime proxy with node ports reserved and exact registered secret forms denied; bounded cleanup with a persistent root quarantine (ADR-0027) | partially implemented, independently verified, merged into `main` (`0e22a92`) | Full evidence and residuals: [evidence/K4](evidence/K4.md). Author GPT/Codex; Claude review 1 (merge after fixes: H1, H2, M1–M3, L4–L7), then a final Claude check with no High: 29 guard-removal probes fail as intended, 17 control-API spellings × 2 backends reach zero connections. Integrator gates on `main`: typecheck, `ui:check`, licenses 441/0, `npm test` (core 978, kernel 106, web 312), browser gate 52/52, build; Fedora core 972 + 6 macOS-only skips. Unfinished: retention, input artifacts, HTTPS positive path, UI evidence, platform envelope and R1 integration (named in the evidence). Final-check residuals R1, R3 and R4 fixed by the follow-up, merged as `a2c2f90`; see [evidence/K4-followup](evidence/K4-followup.md). |

## DS1 — Design foundations

| Item | Status | Evidence |
| --- | --- | --- |
| DS1-a: DTCG tokens, deterministic Style Dictionary build, self-hosted IBM Plex, legacy freeze ratchet, gates G1–G7 and the G17 self-test | implemented, independently verified, merged into `main` (`--no-ff`, as the ratchet requires) | Full evidence: [evidence/DS1-a](evidence/DS1-a.md). Token values are asserted against the FOUNDATIONS tables; the legacy UI's fonts and spacing are unchanged; all 32 Plex faces load from the same origin; the ratchet freezes 735 legacy keys with two owner-authorised corrections. Reviews: the lane's own reviewer, then three Claude cross-family rounds (19 + 9 findings closed; final verdict merge). Integrator gates on `main` after the merge: typecheck, `ui:check`, `npm test` (now including the UI gates; web 264), browser gate 48/48, build, lint:md, licenses (358/0). Follow-ups moved to DS1-c. |
| DS1-b: `@guanxi/ui` components, catalog, signed approvals, G10–G16 | implemented, independently verified, merged into `main` (`7de9e6c`) | Full evidence and residuals: [evidence/DS1-b](evidence/DS1-b.md). Author Claude; GPT cross-family checks through round 5; the last High (generated-root scripts outside the approval hash) verified by the integrator with the reviewer's regressions and a fix-removal mutation. Integrator gates on `main`: typecheck, `ui:check`, licenses 521/0, `npm test` (UI gates 51, catalog 70, core 1007, kernel 106, web 314, UI 17), browser gate 65/65, `ui:check:browser`, build. Key custody moves to DS2. |
| DS1-c: lint ratchet and codemod | implemented, independently reviewed, merged (`a07d3d7`) | [evidence/DS1-c](evidence/DS1-c.md): review fixes, 89 gate + 6 codemod tests, 65 mocked browser regressions. Remaining U1 colour debt is explicit; a green ratchet does not mean zero suppressions. |

## Repository presentation and documentation (2026-10-21)

Repository presentation review (2026-10-21): GitHub About now has an English early-alpha
description and ten topics. Website temporarily links to the README status because the
configured domain failed DNS resolution in the local check; public DNS availability was not
independently established. Releases remain visible; Deployments and empty Packages are hidden
from the home page. This does not hide infrastructure or change deployment access.

Documentation reconciliation: README now records the merged own kernel and DS1-a; the
navigation includes ADR-0037/0038; VISION reflects D-193's uncapped fleet; the architecture and
client ADR distinguish the planned phone relay from execution. No deployment or new hosting
decision was made.

- **New:** 0 product tests; seven Markdown files reconciled in `977e945`.
- **Regression envelope:** `npm run lint:md` passed (103 files, 0 errors);
  `git diff --check` passed. Product tests and the browser regression gate were not rerun for
  this documentation-only change.
- **Independent verification:** a separate read-only reviewer inspected
  `1243d3c..977e945` against ADR-0037/0038, D-186/187/193, existing K1/DS1-a evidence,
  package sources and the lane table; new relative links and heading fragments resolve;
  no actionable findings. GitHub metadata readback and UI visibility checks were the author's
  direct observations, outside the reviewer's local scope.
- **Residuals:** public website and phone relay remain undeployed by this task; existing
  Russian legacy docs and raw research remain preserved, not translated by this slice.

## Next stages

| Stage | Status | Notes |
| --- | --- | --- |
| K1 Kernel | implemented, merged | see the K1 section above |
| DS1 Design foundations | implemented, reviewed, all three parts merged | see the DS1 section above and the integrated-main audit below |
| DS2 Approval signing helper | reviewed implementation merged locally (`03c655b`); candidate and post-merge full gates pass at `5e9bbfe` | [evidence/DS2](evidence/DS2.md); production helper installed and build/code-sign checks pass locally; owner-present key creation/signing remains unverified. Installation does not prove the full signing gate. |
| NC1 Notification center | backend core and notification center UI integrated (rules, inbox, actions, delivery planning, producers, OS adapters, opt-in OS delivery, REST, status-strip entry and page) | slices NC1-a…f and [NC1-ui](lanes/NC1-ui.handoff.md); real action ports (`wake_leads` needs a run-to-connection index), push, settings UI, an unread-count endpoint remain |
| K2 Session log | implemented, merged | see the K2 section above |
| K3 Model access | implemented, merged | see the K3 section above |
| K4 Native agent | partial; queue-v3 Q0 integrated and independently accepted (2026-10-23) | [Q0 hand-off](lanes/K4-queue-v3.handoff.md); Q1 restricted reader, Q2 producer, whole-buffer paths and wider UI/platform exits remain. Earlier privacy/encoding/Linux-proxy evidence: [input](evidence/K4-input-artifacts.md), [Linux repair](lanes/K4-linux-proxy-path.handoff.md). |
| R1 Durable runs | implemented, merged; follow-up residuals 1–3 merged; external lead hibernation/wake (LW) and atomic `complete(…, cost)` integrated 2026-10-23 | see the R1 section above and [evidence/r1-followup](evidence/r1-followup.md) |
| K5 External agents | partial; boot reconciliation of stale admission holders by proof (LW, 2026-10-23); reviewed durable same-node admission and atomic learning integrated locally (`1b6f495`) | [K5 evidence](evidence/K5.md), [admission handoff](lanes/K5-durable-admission.handoff.md). Repository 37 new / 66 inherited; independent 105 includes two outside checks. Cleanup uncertainty retains occupancy. Real vendor captures, effective implicit bare, Claude quota producer and distributed admission remain. |
| B1 Bench base | bounded foundation, process/K2 retention and separate fixture repairs integrated locally (`1b6f495`) | [B1 evidence](evidence/B1.md), [process handoff](lanes/B1-trial-binding.handoff.md), [integration handoff](lanes/F2-integration.handoff.md). Independent OS/retention repairs closed; bench 137 passes in the candidate. Two newly added cleanup/finalization regressions have separate red/fix/review evidence. Stock paid execution, real corpus/images, billing and five seeds remain open. |
| X1 Repo map and FTS | independently reviewed and integrated locally (`1b6f495`); actual Fedora62/62 passes | [X1 handoff](lanes/X1.handoff.md). Exact c777 source passes62 local Colima Linux cases, zero skips, with documented nested-bwrap permission limits. Candidate d861 passes all eight commands. [Current Fedora](evidence/Fedora-2026-10-22.md) main3e4840bb five-file X1/kernel envelope passes62/62, zero skips, as dedicateduid1001. The separate native/core startup failure is repaired in45491863; actual214 has208 pass/6 Darwin-only skips. Production/rootless untrusted execution and wider platform/runtime proof remain unearned. |
| R2 Relay executor | operational local runtime integrated (R2-op, 2026-10-23): opt-in llama-server with exact `/apply-template`+`/tokenize` counter, loaded-window observation and owned checkouts | [R2-op hand-off](lanes/R2-op.handoff.md); not yet exercised against a real llama-server; resident model memory is invisible to the governor (residual); quality/long-run gates remain. Earlier: [R2 evidence](evidence/R2.md). |
| U1 Shell, layout, modes | integrated 2026-10-23: workspace states, mounted shell, status closure, primitive readiness, glossary, new-session screen, finished-unseen, ephemeral side chat | [integration](lanes/U1-integration.handoff.md), [session features](lanes/U1-session-features.handoff.md); 112 CSS suppressions and owner signatures for six `review` components remain |
| F1 Federation base | implemented, independently verified, merged (`e2fdd66`) | see [evidence/F1](evidence/F1.md) |
| R3 Judge + ETA | ETA/signals and opt-in cascade integrated; replay (R3-b) and ETA calibration (R3-c) scorers integrated 2026-10-23 | [R3-b](lanes/R3-b.handoff.md), [R3-c](lanes/R3-c.handoff.md); gates evaluate only on recorded corpora; a privacy-reviewed observation journal is needed to record real runs; night J3 wake rate remains |
| F2 Remote attempts | offers, renewable dispatch, remote cost ledger (F2-c) and relay inference on another node (F2-d) integrated 2026-10-23 | [F2-c](lanes/F2-c.handoff.md), [F2-d](lanes/F2-d.handoff.md); fixture-validated only; real two-host run, TLS between hosts, residency lease, toolful remote steps and a remote-relay judge remain |
| B3 Relay benchmark | offline evidence validator integrated (B3-a); no measurement; now an MS2 gate with a smoke cohort first (D-219) | [B3-a hand-off](lanes/B3-a.handoff.md); every gate stays `unevaluated` until a real cohort runs on a non-Mac node (D-194) |
| V1 Dictation | backend core and glossary editor UI integrated (matcher, store, eval metrics, whisper.cpp adapter with D-157 consent, REST, `/settings/voice/glossary`) | owner eval recordings, more STT adapters, `voice.flag_term` remain; exit gate needs owner recordings |
| WG1 Work ledger | core integrated (evidence-derived status, strip, query, export); REST via MS2 | `project` mode stays off until the WL A/B; board UI, `work.query` agent tool remain |
| WG2 Tracker sync | core integrated (GitHub/Jira adapters on fixtures, business-field protection, rate limits) | plugin packaging per P1, credentials UI, polling scheduler, live fixtures remain |
| U3 Accounts | authorization core integrated (`can()`, grants, remote-bind guard; D-155, D-190); route wiring and boot bind gate integrated (wave 8) | Better Auth, wiring `can()` into routes, remote bind at boot remain |
| P1 Plugin platform | cores integrated (skills/AGENTS.md loading, T1 plugin manager with crash recovery, MCP client) | K4 sandbox wrapper for MCP, kernel boot wiring, agent tools, UI remain |
| C1 Agent browser | policy core integrated (origin policy, site grants) | playwright-core browser host, streamed pane, cookie scrubber, injection tests remain |
| all others | not started | see [ROADMAP](ROADMAP.md) dependencies |

## Integration coordination audit (2026-10-21)

See [evidence/coordination-2026-10-21](evidence/coordination-2026-10-21.md).
The audit reconciles merged DS1-c/R2/K5 and completed worker handoffs, records fresh main
regression gates, and keeps K4/K5/R2/B1/DS2/U1 residuals open. No unreviewed lane is
closed by a percentage estimate.

### Historical continuation candidates (before the current integration)

- K4 follow-up 2: merged as `8006cd8` after full integrator gates.
  [Evidence](evidence/K4-followup-2.md) separates 5 new review repairs / 33 targeted envelope,
  original feature evidence and full regression counts. Source lint, links and licenses pass.
- DS2: merged locally as `03c655b`; [full candidate gates](evidence/DS2.md) pass.
  All eight post-merge gates pass at clean `5e9bbfe`; actual hardware signing remains pending. Repairs are 4 new / 43 targeted envelope.
- X1: `codex/x1-parent-read-boundary` at `647c5d0`, repair and integration-conflict review closed;
  5 new / 49 indexing envelope, plus seven kernel boot tests = 61 total, 60 pass / 1 Linux-only
  skip. All-workspace typecheck, links and licenses pass. Repaired-source Linux checks remain.

This earlier snapshot predates the `1b6f495` integration above. Its original targeted
evidence does not stand in for the later combined checks. Continuation work is tracked in
[evidence/coordination-2026-10-22](evidence/coordination-2026-10-22.md); historical receipts and
limits remain in the [previous audit](evidence/coordination-2026-10-21.md).
