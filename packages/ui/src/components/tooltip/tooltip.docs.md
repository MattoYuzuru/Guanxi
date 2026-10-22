---
id: tooltip
level: primitive
states: [closed, open]
tokens: []
since: 0.1.0
---

# Tooltip

## Purpose

Names an icon-only control or adds one short fact to a trigger on hover and keyboard focus.

## When to use

- Every icon-only control (IconButton adds one automatically).
- A short clarification such as the full value behind a truncated label.

## When not to use

- Content the user must read to complete a task: put it on the surface.
- Interactive content: use Popover.
- Status that needs attention: use a toast or the inbox.

## Anatomy and variants

Provider (shared delay), Root, Trigger and Content. Content is a small inverse surface with no
arrow, positioned by Base UI and mounted in the nearest portal container.

## States

closed and open.

## Accessibility

- Opens on hover and keyboard focus; Escape closes it.
- Never the only place where information lives.
- The trigger keeps its own accessible name; the tooltip repeats or adds to it.
- An open popup has `role="tooltip"` and a stable ID referenced by its trigger's
  `aria-describedby`. The wrapper removes its added reference on close and preserves
  caller-provided description IDs.

## Content and i18n

One short phrase, sentence case, no trailing full stop. Pass translated text.

## Motion

Fades in over `--motion-duration-moderate` with a `--motion-distance-sm` offset; the offset is
zero under reduced motion.

## Do / Don't

- Do keep it under one line where possible.
- Don't put links or buttons inside a tooltip.
