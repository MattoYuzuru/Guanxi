# Lane DS1-a — Tokens, fonts and the first gates

**Status:** ready · **Updated:** 2026-10-20 · **Runs in:** GPT (Codex CLI), reasoning xhigh ·
**Worktree:** `/Users/yuzuru/Projects/Guanxi-lanes/ds1-a` · **Branch:** `lane/ds1-a-tokens` ·
**Ports:** `GUANXI_WEB_PORT=5182`, `GUANXI_API_PORT=4382`

Paste everything below the line into a new Codex session started in the worktree.

---

You are implementing lane DS1-a of stage DS1 (Design foundations) of Guanxi, an Apache-2.0,
local-first, multi-model agent harness. Two other lanes run at the same time: K1, the kernel
spike, and DS1-b, the `@guanxi/ui` components, catalog and approvals. Stay inside your owned
paths.

Read first, in order:

1. `AGENTS.md`
2. `docs/plans/lanes/README.md` (lane rules: worktree, ports, shared lock, hand-off file)
3. `docs/plans/WORKFLOW.md`
4. `docs/decisions/0034-design-system-tokens-catalog-and-gates.md`
5. `docs/design/FOUNDATIONS.md` (every value you generate comes from here), `docs/design/BRAND.md`
6. `docs/design/COMPONENTS_AND_CATALOG.md` §5 (gate table)
7. `docs/research/2026-10-20-design/02-design-system-tooling.md` (DTCG, Style Dictionary, gates)
   and `03-typography-and-identity.md` (IBM Plex self-hosting)
8. `docs/plans/ROADMAP.md`, section DS1
9. `.agents/skills/guanxi-ui/SKILL.md`

Goal: a deterministic token pipeline and the fast gates, so that every later UI change is
checked by machines rather than by taste.

Scope:

- **Token source.** DTCG 2025.10 token sources in `packages/ui/tokens/`, built from
  FOUNDATIONS:
  - neutral ramps, the Glacier light theme (frost canvas `#EBF4F5`) and the brand-ink dark
    theme (`#182322`);
  - verdigris accent (`#187363` light / `#78CAB7` dark) and status colours shared across
    themes;
  - type scale for IBM Plex Sans and Mono, spacing, radius, elevation;
  - glass levels Glass, Tinted and Solid, motion durations and easings, two densities, and
    two high-contrast themes.
- **Resolver and build.** A resolver script for themes and modes, a Style Dictionary 5.x build
  with exact pinned versions, and committed generated outputs: CSS custom properties, a Tailwind
  v4 theme layer and a typed TS map. One command regenerates them, `npm run tokens:build`.
- **Fonts.**
  - IBM Plex Sans and Mono are self-hosted from the upstream release files (not the npm
    `@ibm/plex*` packages, which have a telemetry postinstall, and never a CDN).
  - Ship `unicode-range` slices and `OFL.txt`, and add a `THIRD_PARTY_NOTICES.md` entry.
  - Script companions are optional packs; ship none of them now.
- **Logo.** Copy the logo assets from `assets/brand/guanxi-gx-v1/` into `packages/ui` with
  their source noted.
- **Gate runner.** A gate runner under `packages/ui/gates/` with a registry other lanes can
  append to.
  - `npm run ui:check` runs the fast gates and emits JSON.
  - The G17 self-test runs every gate against its seeded violation.
  - Implement gates G1–G7 (tokens valid, generated output fresh, contrast, variables resolve,
    no literal classes, no literal CSS values, no literal motion), each with a seeded violation
    that makes it fail.
- **Legacy freeze.**
  - Fix the two undefined variables `--warning` and `--focus` in `packages/web` by mapping them
    to the new semantic tokens; this is your only edit in `packages/web`.
  - Freeze the remaining legacy literal uses for G5–G7 in an allow-list file that may only
    shrink.
  - Do not rewrite legacy class names; lane DS1-c owns the codemod.
- **Contrast.** Contrast pairs come from FOUNDATIONS §1. G3 must reproduce the measured ratios
  recorded there:
  - light theme: text 14.43:1, muted 4.72:1, control border 3.51:1;
  - dark theme: text 14.61:1, muted 7.01:1, control border 4.09:1;
  - verdigris: 5.12:1 light and 8.39:1 dark.

  If they don't match, stop and report the difference.

Owned paths:

- `packages/ui/tokens/**`, `packages/ui/fonts/**`, `packages/ui/brand/**`, `packages/ui/gates/**`
  and generated output under `packages/ui/generated/**`;
- `packages/ui/package.json`;
- the root `package.json` scripts `tokens:build` and `ui:check`;
- `THIRD_PARTY_NOTICES.md` entries for Plex;
- the variables fix in `packages/web/src/**/*.css`.

Lane DS1-b also creates files in `packages/ui/src/components/**`; do not touch them.

Non-goals:

- components, stories, Storybook or the catalog (DS1-b);
- ESLint (DS1-c);
- any screen redesign;
- new token values not in FOUNDATIONS. If a value is missing, propose it in the hand-off;
  never invent it.

Exit gate (each item needs an assertion that fails when violated):

- G17 green: every seeded violation fails its gate.
- G4 reports zero unresolved variables in `packages/web` and `packages/ui`.
- G2 fails when a generated file is edited by hand.
- G3 passes for every listed pair in every theme, including high contrast at 7:1.
- The built web app makes zero font requests to any non-local origin. Prove it with a
  Playwright network assertion in `packages/web/test/browser/`.
- `npm run typecheck`, `npm test`, `npm run test:web:browser`, `npm run build`,
  `npm run lint:md` and `npm run check:licenses` pass. Run the heavy ones through
  `agent-dev run --resource heavy`.

Independent verification:

- Before hand-off, run a separate review pass over your own diff, in a fresh context if your
  harness allows it: correctness, determinism of the build, licence of every copied file.
- Fix findings in separate commits.
- The integrator then arranges a cross-family review.

Finish with `docs/plans/lanes/DS1-a.handoff.md` as described in the lane rules. Conventional
commits on `lane/ds1-a-tokens` only; do not push.
