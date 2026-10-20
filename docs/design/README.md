# Guanxi design system

**Status:** accepted direction (owner decisions D-127–D-140); tokens and components are
implemented in stage DS1 · **Updated:** 2026-10-20

This folder is the brand book and style guide that every person and agent building Guanxi UI
follows. It is the source the catalog, the lint gates and the `guanxi-ui` skill are built from.

| Document | Owns |
| --- | --- |
| [BRAND](BRAND.md) | name, logo and its usage, 關係 lockup, brand colours, voice and tone, copy rules |
| [PRINCIPLES](PRINCIPLES.md) | sixteen design principles, each with how to tell it is broken |
| [FOUNDATIONS](FOUNDATIONS.md) | tokens: colour, type, spacing, radius, elevation, glass material, motion, icons, density, themes |
| [LAYOUT_AND_SCREENS](LAYOUT_AND_SCREENS.md) | shell, zones, blocks, experience modes, screen inventory and the state vocabulary |
| [COMPONENTS_AND_CATALOG](COMPONENTS_AND_CATALOG.md) | component inventory, folder convention, catalog, approval lifecycle, gates |

Decisions: [ADR-0034](../decisions/0034-design-system-tokens-catalog-and-gates.md) (tokens,
catalog, approvals, gates), [ADR-0035](../decisions/0035-agent-browser-and-site-sessions.md)
(agent browser), [ADR-0036](../decisions/0036-workspace-layout-and-experience-modes.md)
(layout and modes). Evidence: [2026-10-20 design research](../research/2026-10-20-design/).
Visual reference: the "Guanxi Glacier" preview page the owner reviewed (private link in
[PHASE_STATUS](../plans/PHASE_STATUS.md)); the tokens in FOUNDATIONS win over the preview.

## How to use this folder

- **Building UI:** load the `guanxi-ui` skill
  ([`.agents/skills/guanxi-ui/SKILL.md`](../../.agents/skills/guanxi-ui/SKILL.md)), find an
  existing component in the catalog, and follow the decision ladder there.
- **Changing a token or adding a component:** follow
  [COMPONENTS_AND_CATALOG](COMPONENTS_AND_CATALOG.md); new components start as `draft`.
- **Reviewing UI:** use the checklist at the end of COMPONENTS_AND_CATALOG and the
  "broken when" lines in PRINCIPLES.

## What exists today

The legacy web package (`packages/web`) predates this system: hand-written CSS variables, a blue
accent, 683 `bg-[var(--x)]` class uses, two undefined variables (`--warning`, `--focus`) and no
ESLint or stylelint. Stage DS1 builds the token pipeline, `@guanxi/ui`, the catalog and the
gates, and freezes existing violations in a ratchet that may only shrink. Until DS1 lands, new
UI work should already use the vocabulary and values defined here.
