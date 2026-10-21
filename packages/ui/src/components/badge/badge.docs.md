---
id: badge
level: primitive
states: [neutral, accent, info, success, warning, danger]
tokens: []
since: 0.1.0
---

# Badge

## Purpose

A short static label that classifies something: a status word, a tag, "estimated".

## When to use

- Classifying rows and cards with one or two words.
- Marking a value as estimated, new or deprecated.

## When not to use

- Run or session status: use StatusPill, which adds a shape.
- Anything clickable: use Button or a Chip (later).

## Anatomy and variants

An inline `span` with the inline radius (6 px). Tones: `neutral` (default), `accent`, `info`,
`success`, `warning`, `danger`.

## States

neutral, accent, info, success, warning and danger. A badge has no interactive states.

## Accessibility

- Plain text; the word carries the meaning, the tone only reinforces it.
- Tinted fills keep text at 4.5:1 or better in every theme.

## Content and i18n

One or two words in sentence case. Pass translated text.

## Motion

None.

## Do / Don't

- Do keep the word meaningful without colour.
- Don't use more than one badge tone to mean the same thing.
