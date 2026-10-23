---
id: provenance-label
level: pattern
states: [fresh, aged, unknown, estimated]
tokens: []
since: 0.1.0
---

# ProvenanceLabel

## Purpose

States where a number came from and when it was observed: the source in mono, then the absolute time,
separated by spacing rather than a glyph (D-202). It never shows a relative age (D-203).

## When to use

- Next to every context size, quota, balance, ETA, fit, energy or machine value (principle 1).
- In offline states: "as of 14:02, 6 min ago".

## When not to use

- Values the user typed: they need no provenance.

## Anatomy and variants

The source in the mono face, then the observation time (HH:MM) in a `time` element whose
`dateTime` and title hold the exact time. Optional "estimated" Badge and a confidence label.

## States

fresh (HH:MM), aged (older than `staleAfterSeconds`, shown as "as of HH:MM" in the warning tone),
unknown and estimated.

## Accessibility

- The separator dot is hidden from assistive technology.
- Unknown is spelled out, with the source that would answer it.
- Age is plain text; no colour-only staleness signal.

## Content and i18n

Ages use `Intl.RelativeTimeFormat` in the active locale; sources are machine values and stay
untranslated.

## Motion

None. Ages update without animation.

## Do / Don't

- Do show unknown instead of 0.
- Don't round an estimate into a fact; keep the badge.
