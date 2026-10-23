---
id: kbd
level: primitive
states: [default, combo]
tokens: []
since: 0.1.0
---

# Kbd

## Purpose

Shows a keyboard key or shortcut next to the action it triggers, so users learn shortcuts as
they work (the command palette button, menu items).

## When to use

- Beside a control or menu item that has a shortcut.
- In tooltips and help text that name a key.

## When not to use

- As a button: it is not interactive.
- For code or machine output: use the mono face in a code element.

## Anatomy and variants

A `kbd` element holding one nested `kbd` per key, each a small white keycap with a hairline and
a one-pixel bottom edge.

## States

default (one key) and combo (several keys).

## Accessibility

- Rendered as nested `kbd`, which screen readers announce as keyboard input.
- The host passes keys in the platform's words when a glyph is ambiguous.

## Content and i18n

Keys are machine values (`⌘`, `Ctrl`, `K`); the host chooses them per platform.

## Motion

None.

## Do / Don't

- Do keep shortcuts short: one modifier and one key.
- Don't use a keycap for decoration.
