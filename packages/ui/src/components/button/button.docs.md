---
id: button
level: primitive
states: [default, secondary, ghost, danger, hover, focus-visible, active, disabled, loading, with-icon]
tokens: []
since: 0.1.0
---

# Button

## Purpose

Starts an action on the current surface: save, run, open, delete.

## When to use

- One `primary` button for the main action of a surface; `secondary` for the rest.
- `ghost` inside dense rows and toolbars where a border would add noise.
- `danger` for a user's own destructive action, after the surface states what it discards.

## When not to use

- Navigation to another screen: use a link.
- An icon without text: use IconButton, which carries a name and a tooltip.
- Toggling a setting: use Switch or Checkbox.

## Anatomy and variants

A Base UI button with optional leading icon and a text label. Variants: `primary`, `secondary`
(default), `ghost`, `danger`. Sizes: `md` follows the density control height (28 px compact,
32 px comfortable); `sm` keeps the 24 px minimum target.

## States

default, secondary, ghost, danger, hover, focus-visible, active (pressed), disabled, loading
and with-icon. Loading keeps the button focusable, sets `aria-busy` and shows a spinner next
to the text.

## Accessibility

- A native `button` with the visible text as its name.
- Focus ring from `--color-ring-primary`, visible in forced colours.
- Disabled buttons are not focusable; loading buttons stay focusable so focus is not lost.
- Minimum target 24 × 24 px in both densities.

## Content and i18n

Verb first, sentence case, no trailing punctuation: "Save changes", "Delete project". Pass
translated text; the loading label defaults to the button text.

## Motion

Colour changes use `--motion-duration-fast` with the standard easing. The loading spinner
rotates only under full motion; under reduced motion it is a static glyph next to the text.

## Do / Don't

- Do keep one primary button per surface.
- Do say what a destructive action discards before it runs.
- Don't restyle colour or type through `className`; add a variant instead.
- Don't use a disabled button without saying why nearby.
