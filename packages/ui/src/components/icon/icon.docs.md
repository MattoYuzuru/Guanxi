---
id: icon
level: primitive
states: [set, sizes, domain]
tokens: []
since: 0.1.0
---

# Icon

## Purpose

One registry of semantic icon names for the whole product (FOUNDATIONS §6, D-202): status items,
icon buttons, navigation and composer controls name an icon here instead of importing a glyph.

## When to use

- Inside IconButton, StatusItem, menu items and navigation rows.
- Next to a value to say what kind of value it is (memory, quota, power).

## When not to use

- As the only content of a control without a name: IconButton supplies the name and tooltip.
- As the logo: the brand mark comes from the brand module and never sits in an icon slot.

## Anatomy and variants

An inline SVG on the 24 px grid, rendered at 12–24 px with a constant 1.75 px stroke
(`absoluteStrokeWidth`). Lucide (ISC) supplies common glyphs; Guanxi draws domain glyphs on the
same grid: unified memory, free memory pages, relay, lease and hibernating lead.

## States

set (every registered name), sizes (12 to 24 px) and domain (the Guanxi-drawn glyphs).

## Accessibility

- Decorative by default (`aria-hidden`).
- With `label`, the icon becomes `role="img"` with that name.
- Never the only carrier of meaning: status pairs it with text, a tooltip or a shape.

## Content and i18n

Labels are translated strings from the host; icon names are machine identifiers.

## Motion

None. Icons never spin; looping indicators use Spinner.

## Do / Don't

- Do add a new semantic name here rather than importing Lucide in a feature.
- Don't recolour an icon to carry status alone.
