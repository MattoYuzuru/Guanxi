# Foundations

**Status:** accepted values (D-127–D-129); built as DTCG tokens in stage DS1 · **Updated:** 2026-10-20

These are the values the token source (`packages/ui/tokens/`, ADR-0034) is generated from.
Feature code and plugins use **semantic** names only (right-hand columns), never the raw steps.
Evidence: [03 typography and identity](../research/2026-10-20-design/03-typography-and-identity.md),
[02 design-system tooling](../research/2026-10-20-design/02-design-system-tooling.md) §§3, 7.

## 1. Colour

### 1.1 Neutral ramps

Twelve steps per theme: 1 raised surface · 2 canvas · 3–5 fills (rest, hover, pressed) ·
6–8 borders (7 = decorative divider, below 3:1 on purpose) · 9 control border (≥ 3:1) ·
10 muted text (≥ 4.5:1) · 11 secondary text (≥ 7:1) · 12 primary text.

| Step | Light (Glacier, frost) | Dark (brand ink) |
| --- | --- | --- |
| 1 | `#F3FCFE` | `#0F1A19` |
| 2 | `#EBF4F5` canvas | `#182322` canvas |
| 3 | `#E2EBED` | `#1F2A29` |
| 4 | `#DAE3E5` | `#25302F` |
| 5 | `#CEDCDE` | `#2C3837` |
| 6 | `#C5D2D4` | `#34403F` |
| 7 | `#B3C1C3` | `#414D4C` |
| 8 | `#94A1A3` | `#54615F` |
| 9 | `#768385` | `#798281` |
| 10 | `#626E70` | `#A3ADAC` |
| 11 | `#445051` | `#C3CDCC` |
| 12 | `#182322` ink | `#EEF5F6` frost |

Measured contrast (WCAG 2.2, 2026-10-20): light text 14.43:1, muted 4.72:1, control border
3.51:1 on the light canvas; dark text 14.61:1, muted 7.01:1, control border 4.09:1 on ink.

### 1.2 Accent and status

| Role | Light | Dark | Contrast on canvas (light / dark) |
| --- | --- | --- | --- |
| accent (verdigris) | `#187363` | `#78CAB7` | 5.12 / 8.39 |
| text on accent fill | `#F3FCFE` | `#182322` | 5.49 / 8.39 |
| success | `#2B7440` | `#7CCD8E` | 5.11 / 8.43 |
| warning | `#925B0C` | `#F0BA59` | 5.05 / 9.12 |
| danger | `#BA362E` | `#FD8C7E` | 5.14 / 7.09 |
| info | `#236997` | `#83BFEC` | 5.31 / 8.16 |

Status colours mean the same thing in every theme. A status is never shown by colour alone:
it always pairs with a label, an icon or a shape (run-status dots use fill, ring and dash).

### 1.3 Semantic tokens

Semantic colour names follow the MCP Apps host vocabulary, so untrusted plugin UI in iframes
gets the same values without translation (ADR-0022): `--color-background-{primary, secondary,
tertiary, inverse, ghost, info, danger, success, warning, disabled}`, `--color-text-…`,
`--color-border-…`, `--color-ring-…`. Tailwind utilities use short aliases (`bg-surface`,
`bg-canvas`, `text-muted`, `border-control`) mapped to those variables; the default Tailwind
palette is removed so `bg-red-500` does not exist.

### 1.4 Themes

`light`, `dark`, `light-hc`, `dark-hc`. High-contrast variants raise text and control borders to
at least 7:1 and 4.5:1, use 1 px solid borders and a solid material; they are computed in DS1 and
checked by the contrast gate. `system` follows the OS; `prefers-contrast: more` selects HC;
`forced-colors` uses system colours.

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

- **Grid:** 4 px. Spacing scale 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64. Density changes the
  base `--spacing` and type sizes, never the layout.
- **Radius** grows with the layer: inline (chips, tags, kbd) 6 · controls 10 · panels and cards
  16 · glass layers, sheets and dialogs 20 · app tile 21.9%.
- **Borders:** 1 px. Decorative dividers use step 7; control boundaries step 9.
- **Elevation:** 0 canvas (step 2) · 1 raised (step 1 with a 1 px rule, no shadow) · 2 popover
  (glass with `0 1px 2px` and `0 8px 24px` shadows in ink at 8–10%) · 3 dialog (strong glass with
  a scrim of ink at 32%, never a blurred scrim). Shadows use ink, never pure black.

## 4. Glass material (D-127)

| | Light | Dark |
| --- | --- | --- |
| Fill | step 1 at 72% opacity | step 3 at 70% opacity |
| Backdrop | `blur(20px) saturate(1.15)` | same |
| Ice edge | inset top highlight, white at 65% | white at 8% |
| Ink seam | 1 px bottom rule, ink at 10% | black at 32% |
| Grain | static 128 px fractal-noise tile, 4–6% opacity, soft-light blend | 5–7% |

- **Where:** sidebar, title strip, dock lanes above the composer, composer, command palette,
  menus, popovers, toasts. Never on reading surfaces. At most three glass surfaces visible; no
  glass on glass.
- **Levels** in Settings → Appearance: **Glass** (default), **Tinted** (fill about 90%, smaller
  blur, less grain), **Solid** (no blur, no grain, step-1 fill and a step-8 border).
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

Rules: streaming text appends instantly and auto-scroll is instant; numbers update without
count-up; timeline insertions never animate layout; never animate blur in or out. Under reduced
motion (OS or Settings → Motion: system, reduced, full) distances and spatial durations become 0,
fades are capped at `fast`, looping indicators become a static glyph with text. CSS only; the
Motion library (MIT) may be added later only behind `@guanxi/ui/motion` for board drag and
reorder.

## 6. Icons

- **Lucide** (ISC), 24 px grid, rendered at 16 / 18 / 20 px with stroke 1.75 and
  `absoluteStrokeWidth`.
- Guanxi-specific icons are drawn on Lucide's grid and rules: connection/relay (two nodes joined
  by a 45° line with a gap, quoting the detached arm), fleet machine, lease, hibernating lead,
  judge, handoff.
- Icons never imitate the logo, and the logo never sits in an icon slot.
- Every icon-only control has an accessible name and a tooltip.

## 7. Density

| | Compact | Comfortable |
| --- | --- | --- |
| Body text | 13 px | 14 px |
| Control height | 28 px | 32 px |
| Row height (lists, trees, tables) | 26 px | 32 px |
| Panel padding | 8 px | 12 px |

Defaults (D-131): the chat and new-session screens are comfortable; dense panes (processes,
terminal, trace, board, files) are compact. The user can switch everything to one preset. Hit
targets stay at least 24 px in both.
