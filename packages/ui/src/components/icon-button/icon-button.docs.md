---
id: icon-button
level: primitive
states: [default, secondary, hover, focus-visible, pressed, disabled, tooltip-open]
tokens: []
since: 0.1.0
---

# IconButton

## Purpose

A compact control whose meaning is carried by a Lucide icon, with a required name and tooltip.

## When to use

- Toolbars, row actions and the status strip where text would not fit.
- Toggles such as pin or follow-tail (`pressed`).

## When not to use

- The main action of a surface: use Button with text.
- An icon whose meaning is not widely understood: add text.

## Anatomy and variants

A Button primitive with only an icon, wrapped in a Tooltip whose text is the `label`. Variants:
`ghost` (default) and `secondary`. Sizes: `md` (density control height, square) and `sm`
(24 px).

## States

default, secondary, hover, focus-visible, pressed, disabled and tooltip-open.

## Accessibility

- `label` is the accessible name (`aria-label`) and the tooltip text; it is required by type.
- The icon is `aria-hidden`.
- Toggles expose `aria-pressed` and change both colour and border, not colour alone.
- Minimum target 24 × 24 px.

## Content and i18n

The label is a short verb phrase: "Open settings", "Pin session". Pass translated text.

## Motion

Colour changes use `--motion-duration-fast`. The tooltip follows Tooltip motion.

## Do / Don't

- Do pick the Lucide icon that names the action, at 18 px.
- Don't draw a Guanxi logo in an icon slot.
- Don't omit the label; the type system and G14 reject it.

## In a labelled list

Inside a phone overflow sheet an IconButton shows its label as text beside the icon and has no
tooltip. The accessible name does not change.
