---
id: popover
level: primitive
states: [closed, open]
tokens: []
since: 0.1.0
---

# Popover

## Purpose

Shows a small interactive surface next to its trigger: run options, a filter, a detail.

## When to use

- Secondary settings tied to one control, such as the Run options disclosure.
- Rich detail behind a chip that the user may act on.

## When not to use

- A list of commands: use Menu.
- A decision that blocks work: use Dialog.
- One line of help: use Tooltip.

## Anatomy and variants

Root, Trigger, Content (glass), Title, Description and Close, from Base UI. Content mounts in
the nearest portal container so it inherits the theme of its surface.

## States

closed and open.

## Accessibility

- The trigger exposes `aria-expanded` and `aria-controls`; Escape closes and focus returns.
- Content is a dialog named by its Title.
- Glass keeps text at 4.5:1 or better over the worst-case backdrop; Solid material under
  reduced transparency and high contrast.

## Content and i18n

Title in sentence case; one short description. Pass translated text.

## Motion

Enters over `--motion-duration-medium` with a `--motion-distance-sm` offset and leaves over
`--motion-duration-fast`; reduced motion removes the offset.

## Do / Don't

- Do keep one level: no popover inside a popover.
- Don't place glass on glass; Content is the only glass layer it adds.
