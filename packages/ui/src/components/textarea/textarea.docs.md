---
id: textarea
level: primitive
states: [default, filled, focus-visible, invalid, disabled]
tokens: []
since: 0.1.0
---

# Textarea

## Purpose

A multi-line text field.

## When to use

- Comments, descriptions and other free text longer than one line.

## When not to use

- The session prompt: use the Composer pattern (stage U1), which adds scope chips and the
  context ring.
- Single-line values: use Input.

## Anatomy and variants

A native `textarea` that shares the Input surface and adds vertical resizing. Three rows by
default.

## States

default, filled, focus-visible, invalid and disabled.

## Accessibility

- Always has a name: a visible `label` element or `aria-label`.
- `invalid` sets `aria-invalid`; pair it with a visible message.
- Resizing never hides the focus ring.

## Content and i18n

Placeholders describe the expected content in one sentence. Pass translated text.

## Motion

Border colour changes use `--motion-duration-fast`. Nothing moves.

## Do / Don't

- Do let the field grow with its content where the layout allows.
- Don't limit length silently; show the limit and its source.
