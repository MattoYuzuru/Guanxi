# ADR-0034: Design system — tokens, catalog, approvals and gates

**Status:** accepted direction (owner decisions D-127–D-138); proposed design · **Date:** 2026-10-20
**Extends:** [ADR-0022](0022-plugin-trust-tiers-ui-slots-and-design-tokens.md) §§4–5.

## Context

Many agents will build Guanxi UI in parallel. Without one source of visual truth and checks
that fail, the UI drifts: the legacy web package already has a blue accent unrelated to the
brand, 683 `[var(--x)]` arbitrary-value class uses (133 backgrounds), two CSS variables that are used but never defined
(`--warning`, `--focus`) and no lint setup. The owner wants a brand book, style guide, tokens, a
UI kit, a live catalog with an approval loop inside the product, and deterministic checks.

## Decision

1. **Documents** in [`docs/design/`](../design/README.md): BRAND, PRINCIPLES, FOUNDATIONS,
   LAYOUT_AND_SCREENS, COMPONENTS_AND_CATALOG. They are the source the tokens, catalog and
   skill are built from.
2. **Tokens** authored in W3C DTCG 2025.10 JSON (colours in OKLCH with a hex fallback), with one
   DTCG Resolver file for the modifiers `theme` (light, dark, light-hc, dark-hc), `density`
   (compact, comfortable) and `motion` (full, reduced). Built with Style Dictionary 5.7
   (Apache-2.0) through a small resolver-expansion script until Style Dictionary reads resolver
   files; Terrazzo is the fallback validator. Outputs, generated and committed: CSS variables, a
   Tailwind v4 theme that removes the default palette, TypeScript types, MCP Apps variables and a
   flat JSON for the catalog and the skill. Semantic colour names follow the MCP Apps vocabulary.
3. **Values** are those in FOUNDATIONS: Glacier light ramp, brand-ink dark ramp, verdigris
   accent, shared status colours, IBM Plex, glass recipe with three levels, motion tokens.
4. **`@guanxi/ui`** (`packages/ui`) holds primitives (copied in once from shadcn/ui on Base UI,
   MIT), patterns and blocks' cards and panes. Features and plugins import only from it.
5. **One story source, two catalogs:** portable CSF 3 stories, docs and review records per
   component feed both Storybook (MIT; developer, test and agent harness, including its MCP
   addon) and an in-product catalog under Settings → Developer, visible with Developer mode on.
6. **Lifecycle** `draft → review → approved → deprecated`, with `stale` derived from source and
   snapshot hashes. Approvals are recorded by the app in `review.json` and signed with an owner
   key held in the OS keychain (public key in the repository); agents cannot forge them.
   Approvals are written only from a source checkout; release builds show the catalog read-only.
   Unapproved or stale components block releases only; drafts never ship on product screens
   (D-138).
7. **Gates G1–G17** (COMPONENTS_AND_CATALOG §5), each with a seeded violation that must fail, run
   by `npm run ui:check` and `npm run ui:check:browser`. Visual baselines are produced only in a
   pinned Playwright Docker image. Legacy violations are frozen with ESLint bulk suppressions that
   may only shrink. `check:licenses` also denies proprietary add-ons (for example
   `dockview-enterprise`).
8. **Agent guidance:** the `guanxi-ui` Agent Skill (`.agents/skills/guanxi-ui/`) and a short
   `packages/ui/AGENTS.md` describe the decision ladder, commands and review checklist; rules
   that can be checked live in linters, not in prose.
9. **Fonts** are self-hosted from IBM's upstream WOFF2 releases with `unicode-range` slices and
   their `OFL.txt`; never fetched from a CDN at runtime.

## Invariants

- Feature and plugin code references semantic tokens only.
- Every exported `@guanxi/ui` component has a story per declared state, docs and a review record.
- No `approved` record exists without a valid owner signature over its current hashes.
- Every gate fails on its seeded violation.

## Consequences

Agents get a fast, deterministic answer to "is this UI right?" and the owner reviews visually in
the app he uses. Costs: a resolver script to maintain until upstream support lands; Storybook's
MCP addon and manifest are previews; one approver means approval debt can pile up (visible in the
catalog filters, blocking only releases).

## Validation

- G17 passes (all seeded violations fail their gates).
- Today's undefined `--warning` and `--focus` are caught by G4 before they are fixed.
- A theme switch recolours every catalog story and a T2 iframe plugin without code changes.
- An agent-written `approved` record fails G12.

## Evidence

[02 design-system tooling](../research/2026-10-20-design/02-design-system-tooling.md),
[03 typography and identity](../research/2026-10-20-design/03-typography-and-identity.md),
[01 harness UI patterns](../research/2026-10-20-design/01-harness-ui-patterns.md); W3C DTCG
Format, Color and Resolver modules 2025.10; MCP Apps specification (2026-01-26); WCAG 2.2.
