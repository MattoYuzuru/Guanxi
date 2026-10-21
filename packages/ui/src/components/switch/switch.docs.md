---
id: switch
level: primitive
states: [off, on, hover, focus-visible, disabled]
tokens: []
since: 0.1.0
---

# Switch

## Purpose

Turns a setting on or off with immediate effect.

## When to use

- Settings that apply at once, such as keep-awake or Developer mode.

## When not to use

- Options saved later with a button: use Checkbox.
- Destructive or costly changes: use a Button with a confirmation that states the effect.

## Anatomy and variants

A Base UI switch with a track and a thumb, and an optional visible label.

## States

off, on, hover, focus-visible and disabled.

## Accessibility

- Exposes `role="switch"` with `aria-checked`.
- Has a name from the visible label or `aria-label`.
- "On" changes fill, border and thumb position, not colour alone; 24 px target.

## Content and i18n

The label names the setting in its "on" form. Pass translated text.

## Motion

The thumb slides over `--motion-duration-fast`. Under reduced motion the thumb jumps to its
new position without travel, and the fill changes with it.

## Do / Don't

- Do apply the change immediately and show its result.
- Don't pair a switch with a Save button.
