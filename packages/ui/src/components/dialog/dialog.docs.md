---
id: dialog
level: primitive
states: [closed, open, destructive]
tokens: []
since: 0.1.0
---

# Dialog

## Purpose

Interrupts the flow for a decision or a short task that must finish before the user goes on.

## When to use

- Confirming the user's own destructive action, after stating what it discards (principle 14).
- A short form that belongs to no surface, such as renaming a session.

## When not to use

- Asking an agent's permission: access modes never prompt (D-111, D-118).
- Information the user may want next to their work: use a pane or Popover.
- Notifications: use the inbox or a toast.

## Anatomy and variants

Root, Trigger, Content (strong glass over an ink scrim at 32%, never a blurred scrim), Title,
Description, Footer and Close, from Base UI. Content has a corner close IconButton.

## States

closed, open and destructive (a confirmation whose primary action is `danger`).

## Accessibility

- `dialog` role named by Title and described by Description.
- Modal by default: focus moves in, is trapped, and returns to the trigger; Escape closes.
- The close button has a localized name; the footer's cancel action comes first.
- Catalog stories render non-modally so several states can sit side by side.

## Content and i18n

Title as a question for confirmations ("Delete this session?"); the description states what
is discarded and what stays. Buttons repeat the verb ("Delete session", "Keep session").

## Motion

Enters over `--motion-duration-slow` with a `--motion-distance-md` offset and leaves over
`--motion-duration-medium`; reduced motion removes the offset and caps durations at
`--motion-duration-fast`. Blur never animates.

## Do / Don't

- Do say what is discarded before a destructive action runs.
- Don't open a dialog from a dialog.
- Don't use a dialog for agent approvals.
