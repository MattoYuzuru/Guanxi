---
id: empty-state
level: pattern
states: [default]
tokens: []
since: 0.1.0
---

# EmptyState

## Purpose

Fills a surface that has nothing to show yet with one sentence and one action.

## When to use

- Lists, panes and blocks with no items: no sessions, no artifacts, no change requests.

## When not to use

- Loading: use a skeleton with the final geometry.
- Errors: use ErrorState.
- Unknown values: use ProvenanceLabel's unknown state.

## Anatomy and variants

An optional decorative icon, one sentence and one primary action, centred in the surface.

## States

default.

## Accessibility

- The sentence is plain text; the icon is hidden.
- The action is a real Button with its own name.

## Content and i18n

One sentence that says what is missing ("No sessions in this project yet."), and an action
that fixes it ("New session"). Pass translated text.

## Motion

None.

## Do / Don't

- Do offer the one action that fills the surface.
- Don't leave a panel blank.
