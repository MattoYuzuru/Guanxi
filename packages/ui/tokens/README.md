# Token pipeline

Values come from [FOUNDATIONS](../../../docs/design/FOUNDATIONS.md), including its
2026-10-20 material and density addendum. Sources use DTCG 2025.10. Colour objects contain
OKLCH and an equivalent six-digit sRGB fallback; conversion uses pinned `colorjs.io`.

`guanxi.resolver.json` orders base sets, theme, density and motion. `resolve.mjs` supports
the authored subset (local files and same-document set references); it rejects unsupported
reference forms, unknown modes, source traversal and cycles. Modifiers merge before token
aliases resolve. Style Dictionary 5.7.0 resolves aliases and formats each of the 16 contexts.

From the repository root:

```bash
npm run tokens:build
npm run ui:check --silent
npm run test:gates --workspace @guanxi/ui
```

Generated and committed under `packages/ui/generated/`: `tokens.css`, `theme.css`,
`tokens.ts`, `mcp-apps-variables.ts`, `tokens.flat.json`. G2 regenerates in memory and compares
every byte without writing files. The build writes no timestamp or absolute source path.
Dependency versions are exact in `packages/ui/package.json`; the integrator regenerates the
root lockfile at merge, per lane rules.

Import `tokens.css` for runtime variables; import `theme.css` after Tailwind's theme for
semantic utilities. The theme removes the default palette and supplies `bg-canvas`,
`bg-surface`, `text-foreground`, `text-muted`, `border-control`, semantic radii, size and
spacing utilities, and `duration-fast` / `delay-fast` / `ease-standard` families. Raw
primitive colours have no theme utilities. The legacy app imports only the runtime variables
for its `--warning` and `--focus` compatibility mappings; DS1-c owns its utility migration.
Runtime font variables are `--font-family-sans` and `--font-family-mono`; runtime CSS does not
declare bare `--spacing` or Tailwind's font-family names. Only the theme layer maps those
names. A production-build comparison with the token import removed asserts unchanged legacy
body/mono fonts and spacing. The theme also resets shadow, blur, tracking, leading, font-weight
and default-transition namespaces, then maps supported semantic replacements and defaults.
The compiled-theme browser assertion checks actual font, 8 px spacing and 21.9% radius:
font utilities avoid self aliases, spacing uses the 4 px grid variable, and the app-tile ratio
is converted to a CSS percentage.

Root attributes: `data-theme=light|dark|light-hc|dark-hc|system`,
`data-density=compact|comfortable`, `data-motion=full|reduced`, and
`data-material=glass|tinted|solid`. An absent theme attribute uses Light or the legacy `.dark`
class; explicit `system` follows OS colour scheme. Increased contrast, reduced motion,
reduced transparency and forced colours have generated overrides. The shell can set
`data-reduce-transparency`, `data-battery-saver` or `data-gpu-compositing=off` for Solid.
`data-elevation=3` selects strong material. This package exports recipes; components apply
`--material-background`, `--material-backdrop`, `--material-grain` and `--material-border`.
Glass/Tinted have no decorative border; their separate `--material-edge` and
`--material-seam` colours follow the white/ink/black recipe. Only Solid has the step-8 border
(raised for HC); controls use their independently checked control token.

HC foregrounds use the existing step-11 neutral (rather than introducing unapproved hues).
Text, control borders, accent/status roles and categorical slots then exceed 7:1. HC series
need direct labels/dashes because their neutral colour is shared. HC material is Solid.
Glass text and control tokens deliberately use primary text so they pass the eight extreme
backdrops; decorative seams are not control boundaries. Elevation-2 shadows use ink at the
two specified opacity endpoints (8%, 10%); elevation-3 uses the specified 32% ink scrim.

No persisted data schema changes. Rollback is a revert of this package and the legacy CSS
import/mappings; the legacy palette and class names are otherwise preserved.
