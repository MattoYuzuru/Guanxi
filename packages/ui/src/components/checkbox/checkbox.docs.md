---
id: checkbox
level: primitive
states: [unchecked, checked, indeterminate, hover, focus-visible, disabled]
tokens: []
since: 0.1.0
---

# Checkbox

## Purpose

Turns one option on or off inside a form or a list where the change is applied later.

## When to use

- Options in a form that is saved with a button.
- Selecting rows in a list (indeterminate for a partly selected group).

## When not to use

- A setting that takes effect at once: use Switch.
- One choice out of several: use Radio (stage U1) or Select.

## Anatomy and variants

A Base UI checkbox with a check or minus glyph, and an optional visible label that makes the
whole row clickable.

## States

unchecked, checked, indeterminate, hover, focus-visible and disabled.

## Accessibility

- Exposes `role="checkbox"` with `aria-checked` (`mixed` when indeterminate).
- Has a name from the visible label or `aria-label`.
- A 24 px target even without a label; checked state changes fill, border and glyph.

## Content and i18n

Labels describe the "on" state in sentence case, without a trailing full stop.

## Motion

Fill changes use `--motion-duration-fast`. The glyph appears without movement.

## Do / Don't

- Do use the label prop rather than a separate text node.
- Don't use a checkbox to start an action.
