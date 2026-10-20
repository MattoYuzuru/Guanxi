# Brand book

**Status:** accepted (D-101, D-126, D-127–D-130) · **Updated:** 2026-10-20

## Name

- **Guanxi** — from Chinese 關係 / 关系, "relationships, connections": models, machines and
  people working through a web of connections. Pronounced roughly *gwan-shee*.
- Written **Guanxi** in running text: capital G, no inner capitals, no hyphen. The command and
  package prefix is `guanxi`.
- The Chinese form in brand use is **關係** (traditional, D-130). It appears in the lockup, the
  About screen and exported reports, always as outlined artwork, never as live text that depends
  on installed fonts.

## Logo

Source: [`assets/brand/guanxi-gx-v1/`](../../assets/brand/guanxi-gx-v1/README.md) (concept 05,
vector edition v1, reproducible with `build.mjs`).

- **Construction.** An open lowercase `g` whose descender sweeps into a long diagonal at about
  49°, and a detached `x` arm at about 47°. The diagonal is the connection; the gap between arm
  and diagonal is a relation that is not a fusion. That gap is the most recognisable feature and
  must never close.
- **Files.** `logo.svg` (ink on transparent), `logo-inverse.svg` (ivory, for dark surfaces),
  `logo-mono.svg` (`currentColor`), `app-icon.svg` (ivory symbol on an ink rounded square,
  corner radius 21.9%), `favicon.svg` (wider arm gap for small sizes), `png/` exports.
- **Clear space.** One *arm unit* on every side: the height of the detached arm, about 0.32 of
  the symbol height. The same unit separates symbol and wordmark in a lockup.
- **Minimum size.** 20 px tall on screen (6 mm in print). Below 32 px use `favicon.svg`. Never
  below 16 px.
- **Colour.** Ink `#182322` on light surfaces; ivory `#F4F2E9` on dark surfaces. The mark is
  never recoloured with the accent or a status colour.
- **On glass.** Ink on light glass or ivory on dark glass, only where the surface behind stays
  within neutral steps 1–5 of its theme (at least 7:1 against the mark). Over busy content, put
  the mark on the app tile.
- **Never:** add gradients, glow, outlines or shadows; rotate or skew; change proportions; close
  the arm gap; place it inside an icon slot; set a live-font "Guanxi" beside it in production.

### Wordmark

The current wordmark is a system-font preview, not a deliverable. The production wordmark is
outlined from IBM Plex Sans and hand-adjusted to echo the logo diagonal; Guanxi draws it and the
owner approves it in the catalog (D-177), with a type designer reconsidered before a public
release. Until then, product UI shows the symbol alone, or the symbol with the product
name as ordinary UI text.

## Brand colours

| Name | Value | Use |
| --- | --- | --- |
| Ink | `#182322` (`oklch(0.245 0.016 189)`) | logo, light-theme text, dark-theme canvas |
| Ivory | `#F4F2E9` (`oklch(0.960 0.012 96)`) | logo on dark surfaces only — never a UI canvas, because cream with a serif display and a terracotta accent is the most common AI-generated look |
| Verdigris | `#187363` light / `#78CAB7` dark | the single UI accent: primary actions, selection, focus |
| Frost | `#EBF4F5` | light-theme canvas |

Full palettes and their contrast values are in [FOUNDATIONS](FOUNDATIONS.md).

## Boundaries

- Guanxi does not imitate DeepSeek Harness, Claude, ChatGPT or any other product's identity:
  no blue-violet gradients, no copied wordmark styling, no animated conic rings.
- Other vendors' logos appear only to identify a connection (for example in the Connections
  list), at icon size, from their official assets or simple-icons (CC0, trademarks remain
  theirs), and never imply endorsement.

## Voice and tone

Guanxi talks like a calm, competent colleague who shows their sources.

- **Plain and specific.** "Claude 5-hour window: 10% left, resets 14:40" — not "You're running
  low!". Name things by what the user recognises: *runs*, *machines*, *connections*, *blocks*,
  not internal names like *attempt fence* or *op-log*.
- **Truth over confidence.** Say where a number comes from and how old it is ("estimated",
  "as of 14:02, 6 min ago", "unknown — the model does not report its window"). Never round an
  unknown to zero.
- **Active voice; controls say what happens.** Buttons are verbs ("Wake leads", "Stop run",
  "Save to session"); the confirmation echoes the verb ("Leads woken").
- **Errors explain and offer the next step.** What failed, where, when, and what to do:
  "mac-studio is unreachable since 14:02. The run keeps going there; Guanxi reconnects on its
  own." No apologies, no vague "Something went wrong".
- **No hype, no emoji in product text,** no exclamation marks except in a user's own content.
- **Numbers.** Tabular figures; thin units with a space (`41 s`, `124k tokens`, `38 W`);
  thousands separators by locale; relative time for under a day, absolute time after that.
- **Languages.** English is the source; Russian is curated, not machine-translated. Strings go
  through locale keys only (AGENTS.md). Product terms keep one translation everywhere (the
  glossary is rebuilt in English in stage U1).
- **Machine values** (paths, hashes, IDs, model names, timings in logs) are set in the mono face
  and never as decoration.
