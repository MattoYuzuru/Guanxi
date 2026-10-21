---
id: input
level: primitive
states: [default, filled, hover, focus-visible, invalid, disabled, read-only]
tokens: []
since: 0.1.0
---

# Input

## Purpose

A single-line text field.

## When to use

- Names, URLs, numbers and short free text.

## When not to use

- Multi-line text such as prompts: use Textarea.
- A choice from a known list: use Select.
- Secrets: use the secret reference flow, never a plain field that echoes a value.

## Anatomy and variants

A Base UI input with one border, the control radius and the density control height. One
variant; width fills the container.

## States

default, filled, hover, focus-visible, invalid, disabled and read-only.

## Accessibility

- Always has a name: a visible `label` element or `aria-label`.
- `invalid` sets `aria-invalid`; pair it with a visible message linked through
  `aria-describedby`. The border change is not the only signal.
- The placeholder is an example, never the label.

## Content and i18n

Labels are nouns in sentence case. Placeholders start with "For example". Pass translated text.

## Motion

Border colour changes use `--motion-duration-fast`. Nothing moves.

## Do / Don't

- Do show the error message next to the field.
- Don't disable a field without saying why.
