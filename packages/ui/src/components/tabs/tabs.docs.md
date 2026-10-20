---
id: tabs
level: primitive
states: [default, hover, focus-visible, disabled-tab]
tokens: []
since: 0.1.0
---

# Tabs

## Purpose

Switches between views of the same object, such as Chat, Trace and Changes of one session.

## When to use

- Two to seven sibling views that share one context.

## When not to use

- Navigation between screens: use the navigation sidebar.
- Steps that must be completed in order: use a step flow.

## Anatomy and variants

Root, List (with an accent underline indicator), Tab and Panel, from Base UI. One underline
variant.

## States

default, hover, focus-visible and disabled-tab.

## Accessibility

- `tablist`, `tab` and `tabpanel` roles; arrow keys move between tabs and select them
  (automatic activation, `activateOnFocus` on by default).
- The list has a name (`aria-label`) when no visible heading names it.
- The active tab changes text colour and the underline, not colour alone.

## Content and i18n

Short nouns in sentence case. Pass translated text; the list scrolls instead of truncating.

## Motion

The indicator slides over `--motion-duration-moderate`; under reduced motion it jumps.

## Do / Don't

- Do keep panel content mounted only when it is cheap; otherwise render on demand.
- Don't nest tabs inside tabs.
