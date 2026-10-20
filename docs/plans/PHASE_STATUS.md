# Stage status

**Status:** implemented tracker · **Updated:** 2026-10-20
**Current stage:** S0 Re-foundation — committed 2026-10-20 (`a6fd314`..`be89bb9`); review
fixes applied but not re-reviewed; next: wave 1 of [parallel lanes](lanes/README.md) (K1, DS1-a,
DS1-b; DS1-c after K1 and DS1-a merge)

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
| Lane rules and prompts | accepted (owner, 2026-10-20) | [lanes/](lanes/README.md): owned paths, ports, `agent-dev --resource heavy` lock, hand-off files instead of status files, merge order K1 → DS1-a → DS1-b → DS1-c |

## K1 — Kernel

| Item | Status | Evidence |
| --- | --- | --- |
| Own plugin kernel `@guanxi/kernel` (ADR-0037; Cordis rejected by D-183) | implemented, independently verified, merged into `main` | Full evidence and residuals: [evidence/K1](evidence/K1.md). Exit gate on the own kernel: 100 reload cycles with an identical census; total heap +2.17% after 50 warm-up cycles (≤ 5%); every unloaded governor, fiber and context collected; boot 37–40 ms, 81 MB idle RSS; real-HMR slot test. **119 new / 982 regression envelope.** Reviews: implementation, adversarial architecture, accessibility, then three GPT cross-family rounds (14 + 5 findings, all closed; final verdict merge). Integrator gates on `main` after the merge: typecheck, `npm test` (core + kernel, web 264), browser gate 41/41, build, lint:md, licenses (251/0). |

## Next stages

| Stage | Status | Notes |
| --- | --- | --- |
| K1 Kernel | implemented, merged | see the K1 section above |
| DS1 Design foundations | in progress (DS1-a and DS1-b in review fixes; DS1-c after DS1-a merges) | [lanes/](lanes/README.md) |
| DS2 Approval signing helper | not started | after DS1 (D-184) |
| NC1 Notification center | not started | after K3, R1 and U1 |
| K2, K3 | ready (wave 2 lanes) | [lanes/K2](lanes/K2.md), [lanes/K3](lanes/K3.md); U1 after DS1 |
| all others | not started | see [ROADMAP](ROADMAP.md) dependencies |
