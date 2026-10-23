---
id: segmented-control
level: primitive
states: [default, icons, focus-visible, disabled]
tokens: []
since: 0.1.0
---

# SegmentedControl

## Purpose

Chooses one of two to five options that apply at once, such as density, sidebar side or
graphics tier, without opening a menu (D-204 customisation area).

## When to use

- A small set of mutually exclusive presentation choices.
- Icon-only in compact chrome, with each label as name and tooltip.

## When not to use

- More than five options or options that need explanation: use Select.
- An on/off setting: use Switch.

## Anatomy and variants

A recessed track (pressed fill, 8 px radius, 2 px padding) holding segments; the selected
segment is a raised white chip with the inner highlight and the control shadow. Variants: text,
icon and text, icon only.

## States

default, icons (icon only), focus-visible and disabled.

## Accessibility

- A Base UI radio group: arrow keys move the selection, Tab leaves the group.
- The group has a name; icon-only segments use their label as the accessible name and tooltip.
- Each segment keeps a 24 px minimum target.

## Content and i18n

Short nouns or adjectives in sentence case, passed translated by the host.

## Motion

Colour and shadow change with `--motion-duration-fast`; nothing slides.

## Do / Don't

- Do keep labels to one word where possible.
- Don't mix icon-only and labelled segments in one control.
