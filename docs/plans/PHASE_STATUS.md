# Stage status

**Status:** implemented tracker · **Updated:** 2026-10-19
**Current stage:** S0 Re-foundation — committed 2026-10-20 (`a6fd314`..`be89bb9`); review
fixes applied but not re-reviewed; next: K1 Kernel spike

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
  before the next web slice.
- Environment note: Playwright 1.62.1 needed `chromium_headless_shell-1234`; installed with
  `npx playwright install chromium` from `packages/web`.

## Next stages

| Stage | Status | Notes |
| --- | --- | --- |
| K1 Kernel spike | not started | first slice; prompt in [NEXT_AGENT_PROMPT](NEXT_AGENT_PROMPT.md) |
| NC1 Notification center | not started | after K3, R1 and U1 |
| K2, K3, U1 | not started | can start in parallel after K1 |
| all others | not started | see [ROADMAP](ROADMAP.md) dependencies |
