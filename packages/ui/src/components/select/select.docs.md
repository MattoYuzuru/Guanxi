---
id: select
level: primitive
states: [placeholder, selected, open, invalid, disabled]
tokens: []
since: 0.1.0
---

# Select

## Purpose

Chooses one value from a short, known list.

## When to use

- Five to fifteen options, such as a model, a theme or a provider.

## When not to use

- Long or searchable lists: use Combobox (later) or the ModelPicker pattern.
- Two options: use Switch or a segmented control.

## Anatomy and variants

Root, Trigger (with value and a chevron), Content (glass), Group, GroupLabel and Item with a
check indicator, from Base UI. The list aligns under the trigger and scrolls natively.

## States

placeholder, selected, open, invalid and disabled. The open story includes a disabled item.

## Accessibility

- Trigger is a `combobox` with `aria-expanded`; the list is a `listbox` with `option` items.
- Has a name from a visible label or `aria-label`; `invalid` sets `aria-invalid`.
- Type-ahead and arrow keys move through items; Escape closes and focus returns.

## Content and i18n

Item labels are nouns; machine values such as model names use the mono face in product code.
Pass translated text.

## Motion

Same as Popover: `--motion-duration-medium` in, `--motion-duration-fast` out, no offset under
reduced motion.

## Do / Don't

- Do show the current value, never an empty trigger.
- Don't put actions inside the list.
