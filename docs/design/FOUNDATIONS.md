# Foundations

**Status:** accepted structure (D-127–D-129); colour values follow D-201 (working palette Porcelain +
Cobalt, **pending owner approval**); radii, elevation and graphics tiers follow D-200–D-206 · **Updated:** 2026-10-23

These are the values the token source (`packages/ui/tokens/`, ADR-0034) is generated from.
Feature code and plugins use **semantic** names only (right-hand columns), never the raw steps.
Evidence: [03 typography and identity](../research/2026-10-20-design/03-typography-and-identity.md),
[02 design-system tooling](../research/2026-10-20-design/02-design-system-tooling.md) §§3, 7,
[2026-10-23 redesign research](research/2026-10-23-redesign.md).

**Palette swaps are token-only (D-201).** The ramps, accent and status colours below are generated
by `packages/ui/tokens/palettes/generate.mjs` (three candidates; the catalog's `palette-preview`
shows them) and written by `apply.mjs <candidate>`, which also rewrites these tables; then
`npm run tokens:build` and `apply.mjs --measure`. Step 1 is the session pane (white in light, a
deep neutral in dark); step 2 is the chrome tone the panes float on.

## 1. Colour

### 1.1 Neutral ramps

Twelve steps per theme: 1 raised surface · 2 canvas · 3–5 fills (rest, hover, pressed) ·
6–8 borders (7 = decorative divider, below 3:1 on purpose) · 9 control border (≥ 3:1) ·
10 muted text (≥ 4.5:1) · 11 secondary text (≥ 7:1) · 12 primary text.

| Step | Light (Porcelain) | Dark |
| --- | --- | --- |
| 1 | `#FFFFFF` pane | `#16191D` pane |
| 2 | `#EFF3F8` canvas | `#0D1014` canvas |
| 3 | `#EAEEF3` | `#1E2126` |
| 4 | `#E4E8ED` | `#24272C` |
| 5 | `#DCE0E5` | `#2A2D32` |
| 6 | `#D4D8DD` | `#32363B` |
| 7 | `#C7CBD0` | `#3E4146` |
| 8 | `#A7ABB0` | `#52555B` |
| 9 | `#84888C` | `#66696F` |
| 10 | `#696C70` | `#81858B` |
| 11 | `#4B4E52` | `#A5A9AF` |
| 12 | `#15191D` ink | `#EBF0F8` paper |

Measured contrast (WCAG 2.2, 2026-10-23): light text 15.85:1, muted 4.74:1, control border
3.20:1 on the light canvas; dark text 16.66:1, muted 5.14:1, control border 3.46:1 on the dark canvas.
The "pane-*" pairs check the same floors on the session pane (step 1).

### 1.2 Accent and status

| Role | Light | Dark | Contrast on canvas (light / dark) |
| --- | --- | --- | --- |
| accent (cobalt) | `#285DD2` | `#739DEF` | 5.25 / 7.08 |
| text on accent fill | `#FFFFFF` | `#0D1014` | 5.86 / 7.08 |
| success | `#17793A` | `#5DB673` | 4.92 / 7.63 |
| warning | `#965C00` | `#E29E47` | 4.92 / 8.37 |
| danger | `#C23332` | `#EE7D74` | 4.94 / 7.10 |
| info | `#0070A1` | `#5EACD8` | 4.92 / 7.60 |

Status colours mean the same thing in every theme. A status is never shown by colour alone:
it always pairs with a label, an icon or a shape (run-status dots use fill, ring and dash).

### 1.3 Semantic tokens

Semantic colour names follow the MCP Apps host vocabulary, so untrusted plugin UI in iframes
gets the same values without translation (ADR-0022): `--color-background-{primary, secondary,
tertiary, inverse, ghost, info, danger, success, warning, disabled}`, `--color-text-…`,
`--color-border-…`, `--color-ring-…`. Tailwind utilities use short aliases (`bg-surface`,
`bg-canvas`, `text-muted`, `border-control`) mapped to those variables; the default Tailwind
palette is removed so `bg-red-500` does not exist.

**Interaction fills** (added 2026-10-20 for DS1-b; derived from the steps above):

| Role | Light | Dark | Rule |
| --- | --- | --- | --- |
| `background-hover` | step 4 | step 4 | hover on neutral fills and ghost controls |
| `background-pressed` | step 5 | step 5 | pressed or active neutral fills |
| `background-ghost` | transparent | transparent | ghost controls at rest |
| `background-accent-hover` | `#2655BC` | `#84A9F1` | accent mixed 12% toward ink (light) or white (dark) |
| `background-accent-pressed` | `#234DA7` | `#95B5F3` | accent mixed 24% the same way |

Text on accent stays ≥ 4.5:1 on every accent state (measured: light 6.76 / 7.80, dark 8.10 /
9.24); the contrast gate checks these pairs. State colours change with `duration.fast`.

### 1.4 Themes

`light`, `dark`, `light-hc`, `dark-hc`. High-contrast variants raise text and control borders to
at least 7:1 and 4.5:1, use 1 px solid borders and a solid material; they are computed in DS1 and
checked by the contrast gate. `system` follows the OS; `prefers-contrast: more` selects HC;
`forced-colors` uses system colours.

The stored preference defaults to `system` (D-205). The theme button in the chrome swaps light and
dark only: it sets the explicit opposite of the theme on screen, drawn as a sun or a moon icon,
never an emoji or a Unicode glyph. "Follow the system" lives in the customisation popover.

### 1.5 Data visualisation

Eight categorical slots, used in order, each ≥ 3:1 against its canvas; models keep the same colour
everywhere; series are labelled directly; beyond six series use labels, dashes or small multiples.

| Slot | Name | Light | Dark |
| --- | --- | --- | --- |
| 1 | ink-teal | `#017272` | `#5EBDB9` |
| 2 | ochre | `#CA7401` | `#F2AF48` |
| 3 | cobalt | `#174F9E` | `#5894E0` |
| 4 | cinnabar | `#CC3E35` | `#EF6856` |
| 5 | plum | `#6D2C5A` | `#F3AAD3` |
| 6 | moss | `#599940` | `#549A44` |
| 7 | umber | `#816422` | `#EDE091` |
| 8 | slate | `#68889F` | `#6E8B9A` |

Never let slots 4 and 6 be the only difference between two series (deuteranopia).

## 2. Typography (D-129)

| Role | Face | Size and weight |
| --- | --- | --- |
| UI text, prose | IBM Plex Sans (variable) | 13 px compact / 14 px comfortable body; 500 for labels, 600 for headings |
| Headings | IBM Plex Sans | 15 / 18 / 22 / 28 / 36 px, weight 600, `text-wrap: balance` |
| Machine values | IBM Plex Mono | 12–13 px, weight 400 (600 for emphasis); ligatures off in logs and diffs |
| Numbers that change | either face | `font-variant-numeric: tabular-nums` |

- Line height 1.5 for UI text, 1.6 for long prose, 1.6–1.7 for code.
- A value that updates in place sits in a fixed slot: the status strip's values reserve
  `--layout-status-value` (3.75 rem, eight tabular digits at 12 px; DTCG dimensions are px or rem
  only), so a changing number never moves its neighbours.
- Fact lists (label and value pairs) give the label column a minimum of `--layout-fact-label`
  (8.5 rem), so lists stacked in one card share a value column.
- Mono is for values a machine produced (paths, hashes, IDs, model names, timings, token counts)
  and code — never for decoration or small labels.
- Long prose stays under about 72 characters per line.

### 2.1 Scripts and fallbacks

Plex Sans and Mono cover Latin, Cyrillic and Greek. Other scripts use OS faces first, then
optional Plex companion packs, then Noto:

- Arabic → Plex Sans Arabic; Hebrew → Plex Sans Hebrew; Devanagari → Plex Sans Devanagari;
  Thai → Plex Sans Thai;
- Chinese, Japanese, Korean → OS faces (PingFang, Hiragino, Microsoft YaHei/JhengHei, Malgun),
  then Plex Sans SC/TC/JP/KR packs (Plex Sans KR has no Hanja, so Han text falls through to SC/TC).

Messages carry a `lang` attribute so Han unification picks the right regional glyphs. Users can
prepend their own family per role (text, code, terminal) in Settings.

### 2.2 Loading

Self-host WOFF2 files from IBM's upstream releases (not the `@ibm/plex-*` npm packages, which run
a telemetry `postinstall`), split by script with `unicode-range`; preload only the two Latin
slices; never fetch fonts from a CDN at runtime. Each font's `OFL.txt` ships next to it and is
listed in `FONTS.md`. Script packs beyond Latin, Cyrillic and Greek are optional downloads (a
data-only plugin).

## 3. Spacing, radius, borders, elevation

- **Grid:** 4 px. Spacing scale 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64. The base
  `--spacing` unit stays 4 px in both densities so the grid holds; density changes only the
  semantic size tokens in §7, never the layout.
- **Container widths** (`max-w-*`, `w-*`): 3xs 16rem, 2xs 18rem, xs 20rem, sm 24rem, md 28rem,
  lg 32rem, xl 36rem, 2xl 42rem, 3xl 48rem, 4xl 56rem, 5xl 64rem, 6xl 72rem, 7xl 80rem. This is
  Tailwind's scale, kept as Guanxi tokens so existing layouts do not change.
- **Radius** grows with the layer: inline (chips, tags, kbd) 6 · controls 8 · panels, panes and cards
  12 · glass layers, menus, popovers, sheets and dialogs 14 · app tile 21.9% (D-200: tighter,
  concentric radii; a child never has a larger radius than its parent).
- **Focus ring:** 2 px solid `ring-primary` (the accent) with a 2 px offset, outside the
  element; in forced colours the system `Highlight` colour. Never removed without a visible
  replacement.
- **Layers (z-index):** base 0 · sticky headers 10 · docked panes and dock lanes 20 · floating
  and popout windows 30 · popovers, menus and the command palette 40 · scrim 49 · dialogs and
  sheets 50 · toasts 60 · tooltips 70. Components use these tokens only; nothing invents a
  z-index.
- **Borders:** 1 px. Decorative dividers use step 7; control boundaries step 9.
- **Elevation:** 0 canvas (step 2, the chrome tone) · 1 pane (step 1 with a 1 px
  `border-secondary` hairline and the `elevation.pane.shadow` stack: ink at 4% `0 1px 2px` and
  5% `0 6px 20px` in light, black at 32% and 24% in dark) · 2 popover (glass with `0 1px 2px` and
  `0 8px 24px` shadows in ink at 8–10%) · 3 dialog (strong glass with a scrim of ink at 32%, never
  a blurred scrim). Shadows use ink in light, never pure black; dark uses black because ink is
  the light text colour there. Raised controls may add `elevation.control.shadow` (one 1 px layer)
  and an `elevation.highlight` inner top edge (white at 70% light, 6% dark).
- **Hairlines:** `border-secondary` (step 6, Tailwind `border-hairline`) separates panes and rows
  decoratively and is deliberately below 3:1; control boundaries keep `border-control` (step 9).

## 4. Glass material (D-127)

| | Light | Dark |
| --- | --- | --- |
| Fill | step 1 at 72% opacity | step 3 at 70% opacity |
| Backdrop | `blur(20px) saturate(1.15)` | same |
| Ice edge | inset top highlight, white at 65% | white at 8% |
| Ink seam | 1 px bottom rule, ink at 10% | black at 32% |
| Grain | static 128 px fractal-noise tile, 5% opacity, soft-light blend (tunable 4–6%) | 6% (tunable 5–7%) |

- **Where:** command palette, menus, popovers, tooltips' neighbours, toasts and dialogs (D-200).
  The sidebar and the status strip sit directly on the chrome tone; panes and the composer are
  opaque (they hold reading text). In Max graphics the chrome shows the shader instead
  (§8). Never on reading surfaces. At most three glass surfaces visible; no glass on glass.
- **Levels** in Settings → Appearance: **Glass** (default), **Tinted**, **Solid**. Values per
  level (the Tinted values are the ones in the owner-reviewed preview):

| Level | Fill (light / dark) | Backdrop | Grain (light / dark) |
| --- | --- | --- | --- |
| Glass | step 1 at 72% / step 3 at 70% | `blur(20px) saturate(1.15)` | 5% / 6% |
| Tinted | step 1 at 90% / step 3 at 90% | `blur(12px) saturate(1.15)` | 3.5% / 4.5% |
| Solid | step 1 / step 3 at 100%, plus a step-8 border | none | none |

- **Strong glass** (elevation 3: dialogs and sheets, over the 32% ink scrim) is denser, so text
  on it keeps contrast whatever is behind the scrim:

| Level | Fill (light / dark) | Backdrop | Grain |
| --- | --- | --- | --- |
| Glass | step 1 at 90% / step 3 at 88% | `blur(24px) saturate(1.15)` | as the level |
| Tinted | step 1 at 96% / step 3 at 96% | `blur(12px) saturate(1.15)` | as the level |
| Solid | same as Solid glass | none | none |

- **Automatic Solid** when the OS asks to reduce transparency (the desktop shell reads it natively
  and sets `data-reduce-transparency`, because Safari lacks the CSS media query), under increased
  contrast or forced colours, on battery saver, or when GPU compositing is off.
- **Contrast** is checked against the worst case behind the glass (white, black and a saturated
  backdrop): ≥ 4.5:1 for text, ≥ 3:1 for boundaries.

## 5. Motion

| Token | Value | Use |
| --- | --- | --- |
| `duration.instant` | 0 ms | theme and density switches, streaming append |
| `duration.fast` | 100 ms | hover and press colours, toggles, status-chip colour |
| `duration.moderate` | 150 ms | tool-call and reasoning expand, tooltips, menus |
| `duration.medium` | 200 ms | popovers, toast enter, panel slide |
| `duration.slow` | 300 ms | dialogs, large inspector panes |
| `duration.slower` | 400 ms | rare full-surface transitions |
| `easing.standard` | `cubic-bezier(0.2, 0, 0, 1)` | most transitions |
| `easing.enter` | `cubic-bezier(0, 0, 0, 1)` | elements appearing |
| `easing.exit` | `cubic-bezier(0.3, 0, 1, 1)` | elements leaving (one step shorter than enter) |
| `easing.emphasized` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | new-session and first-run moments only |
| `easing.linear` | linear | progress, spinners |
| `distance.sm/md/lg` | 4 / 8 / 16 px | translate offsets |
| `duration.loop` | 1000 ms | one turn of a spinner or other looping indicator (linear) |

Rules: streaming text appends instantly and auto-scroll is instant; numbers update without
count-up; timeline insertions never animate layout; never animate blur in or out. Under reduced
motion (OS or Settings → Motion: system, reduced, full) distances and spatial durations become 0,
fades are capped at `fast`, looping indicators become a static glyph with text. CSS only; the
Motion library (MIT) may be added later only behind `@guanxi/ui/motion` for board drag and
reorder.

The generated theme utilities `animate-spinner`, `animate-pulse-soft`, `animate-fade-up` and
`animate-sheen` compose the accepted `motion.duration.*` and `motion.easing.*` tokens from
`packages/ui/tokens/motion-animations.json`. In this slice they are consumed by the current web
compatibility classes (`.anim-spin`, `.anim-pulse-soft`, `.anim-fade-up`, `.sheen`); they are
not a complete cross-host or public `@guanxi/ui` animation-component API. The package's Spinner
and StatusPill remain static. Their keyframes currently live in `packages/web/src/index.css`;
any future component or host reuse must verify keyframe ownership and reduced-motion loop
removal before consuming the utilities. Streaming text and its caret never animate; the caret
is a static accent block. The web reduced-motion branches remove animation entirely, because a
zero duration alone would not stop an infinite loop.

## 6. Icons

- **One registry:** `Icon` in `@guanxi/ui` maps semantic names (`device-laptop`, `memory-unified`,
  `keep-awake`, `inbox`, `permission-read` …) to glyphs. Features never import Lucide.
- **Lucide** (ISC), 24 px grid, rendered at 12–24 px (16 by default) with stroke 1.75 and
  `absoluteStrokeWidth`.
- Guanxi-specific icons are drawn on Lucide's grid and rules. Implemented: unified memory (one
  die with CPU and GPU cores over a shared pool), free memory pages (a dashed page in front of a
  full one), connection/relay (two nodes joined by a 45° line with a gap), lease and hibernating
  lead. Still to draw: fleet machine, judge, handoff.
- Status and controls prefer an icon with a tooltip or an anchored popover to a labelled
  bordered button (D-202); values next to an icon carry the visual weight.
- Icons never imitate the logo, and the logo never sits in an icon slot.
- Every icon-only control has an accessible name and a tooltip.

## 7. Density

| | Compact | Comfortable |
| --- | --- | --- |
| Body text | 13 px | 14 px |
| Control height | 28 px | 32 px |
| Row height (lists, trees, tables) | 26 px | 32 px |
| Panel padding | 8 px | 12 px |
| Gap between items in a pane | 8 px | 12 px |
| Base `--spacing` unit | 4 px | 4 px |

Defaults (D-131): the chat and new-session screens are comfortable; dense panes (processes,
terminal, trace, board, files) are compact. The user can switch everything to one preset. Hit
targets stay at least 24 px in both.

## 8. Graphics tiers (D-206)

| Tier | Root attribute | What it adds |
| --- | --- | --- |
| Static (default) | `data-graphics="static"` | The full design: panes, hairlines, shadow stacks, glass on floating layers, the grain tile. No animation beyond the motion tokens. |
| Max graphics | `data-graphics="max"` | One WebGL canvas behind the chrome with a slow gradient field in the accent and chrome hues (never blue-violet). Muted chrome text takes the secondary tone while it runs, and the field strength (0.26 light, 0.30 dark) is capped so secondary text keeps 4.5:1 over its brightest colour (tested). Half-resolution rendering, about 30 fps, held still for 600 ms after input, paused while the page is hidden. |

Max graphics is opt-in from the customisation popover. It never sits behind reading text (panes
stay opaque), never blocks input, and falls back to Static under reduced motion, reduced
transparency, increased contrast, forced colours, battery saver or when WebGL is unavailable.
The OS reduced-motion preference always wins over the in-app motion setting. A lost GPU context
stops the field until the browser restores it, and the context is released when the layer goes.
