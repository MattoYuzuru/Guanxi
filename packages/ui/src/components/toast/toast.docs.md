---
id: toast
level: primitive
states: [info, success, warning, error, with-action]
tokens: []
since: 0.1.0
---

# Toast

## Purpose

A brief, non-blocking notice for something that needs the user now.

## When to use

While the app is focused, only for `input_required`, critical errors and the 10% and 5% quota
thresholds (D-136). Everything else goes to the badge and the notification center.

## When not to use

- As the only record of an event: every toast is mirrored in the inbox.
- For progress or success of routine work: update the surface instead.
- For agent approvals: access modes never prompt.

## Anatomy and variants

Toaster (provider, portal and viewport) renders at most two toasts (`limit`), each with a tone
icon, Title, Description, optional Action and a Close button. Tones: `info`, `success`,
`warning`, `error`.

## States

info, success, warning, error and with-action.

## Accessibility

- The viewport is a named region; toasts are announced politely, `error` with high priority.
- Tone is carried by icon and title, not colour alone.
- Close has a localized name and tooltip; timers pause on hover and focus.

## Content and i18n

Title says what happened in a few words; the description adds the next step. One action at
most, named with a verb. Pass translated text.

## Motion

Enters over `--motion-duration-medium` with a `--motion-distance-sm` rise and leaves over
`--motion-duration-fast`; reduced motion keeps only the fade.

## Do / Don't

- Do mirror every toast in the notification center.
- Don't show more than two at once.
