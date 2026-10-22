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
primitive colours have no theme utilities. The web app imports both public stylesheets,
`@guanxi/ui/tokens.css` and `@guanxi/ui/theme.css`. DS1-c removed the temporary local bridge,
including all ten aliases present at its baseline. Legacy runtime colours and font overrides
remain migration debt; `--warning` and `--focus` retain their compatibility mappings.
The web app then imports Tailwind's default-priority theme for frozen legacy utilities that
U1 has not migrated yet. It restores missing type/radius/material classes without overriding
explicit generated tokens. G5 still compiles against the generated-only theme and rejects
new uses of those defaults. The UI package has no such compatibility import.
Runtime font variables are `--font-family-sans` and `--font-family-mono`; runtime CSS does not
declare bare `--spacing` or Tailwind's font-family names. Only the theme layer maps those
names. A production-build comparison with the design-system CSS imports removed asserts unchanged legacy
body/mono fonts and spacing. The theme also resets shadow, blur, tracking, leading, font-weight
and default-transition namespaces, then maps supported semantic replacements and defaults.
Container widths from FOUNDATIONS §3 live at `layout.container.*`; the theme resets
`--container-*` and maps the documented scale to these tokens for `w-*` and `max-w-*`.
The `--text-shadow-*` namespace stays reset. Off-scale arbitrary widths still fail G5.
The compiled-theme browser assertion checks actual font, 8 px spacing and 21.9% radius:
font utilities avoid self aliases, spacing uses the 4 px grid variable, and the app-tile ratio
is converted to a CSS percentage.

Interaction fills, the focus ring and layers follow FOUNDATIONS' 2026-10-20 addendum:
`color.background.{hover,pressed}` are ramp steps 4 and 5, `color.background.ghost` is
transparent, and `color.background.accent-{hover,pressed}` mix the accent 12% and 24% toward
ink (light) or white (dark). High-contrast themes apply the same rule to their accent (step
11). The contrast manifest checks text on both accent states. `focus.ring.{width,offset}` are
2 px; `layer.*` holds the z-index scale (base 0 … tooltip 70) as unitless numbers.

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

## Semantic animation manifest

`motion-animations.json` is an authored, strict companion manifest, not a DTCG token set and
not part of `guanxi.resolver.json`. Each entry allows exactly `utility`, `keyframes`, `duration`,
`easing` and `iterations`; `utility`, `keyframes`, `duration` and `easing` are required, while
`iterations` may be omitted and then defaults to `1`. Identifiers use
`/^[a-z][a-z0-9-]*$/`, utility and keyframe names are unique, durations must resolve to an
existing `motion.duration.*` token of type `duration`, easings to an existing
`motion.easing.*` token of type `cubicBezier`, and a present `iterations` value is `infinite` or
a positive integer. An explicit `null` is not accepted and does not default. Unknown fields,
aliases outside those namespaces, duplicate names and unsupported types fail the build closed.
The manifest is read through the build's `options.read` when provided, so gate context
overrides and negative fixtures are observed instead of bypassed by an absolute disk read.

The build emits deterministic `--animate-*` entries into `generated/theme.css`:
`--animate-fade-up`, `--animate-pulse-soft`, `--animate-sheen` and `--animate-spinner`. The
declarations contain only the keyframe name plus `var(--motion-duration-*)` and
`var(--motion-easing-*)`, with `infinite` only for the looping entries. Generated output is
never hand-edited. In this slice the utilities are consumed by the legacy web compatibility
classes, not by `@guanxi/ui` Spinner or StatusPill, which remain static; they are not yet a
cross-host component animation API. The keyframes still live in `packages/web/src/index.css`,
so future reuse must first verify keyframe ownership and reduced-motion loop removal.

No persisted data schema changes. Rollback is a revert of this package and the legacy CSS
import/mappings; the legacy palette and class names are otherwise preserved.
