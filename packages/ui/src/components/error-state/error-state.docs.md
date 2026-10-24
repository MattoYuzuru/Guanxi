---
id: error-state
level: pattern
states: [default, with-details, acting]
tokens: []
since: 0.1.0
---

# ErrorState

## Purpose

Explains a failure where it happened: what failed, the source, the time and the next action.

## When to use

- A pane, list or block whose data could not load or whose operation failed.

## When not to use

- Field validation: show the message next to the field.
- Transient notices: use a toast (and the inbox).

## Anatomy and variants

An alert surface with an icon and title, a source and time line, an optional details
disclosure with a copy button, and the next action.

## States

default, with-details and acting (the action is loading). The action tells the user what to do
(D-203): it is never a bare Retry, since transient failures recover by themselves.

## Accessibility

- `role="alert"` so the failure is announced once when it appears.
- Status is carried by the title and icon, not the border colour alone.
- Copy result is announced through a status region; failure to copy says what to do.
- `timeMeaning="observed"` explicitly labels a client observation time. The default remains
  an occurrence time; callers must supply a real timestamp, never a render-time estimate.
- Copy feedback belongs to the current details and clears when the supplied details change.

## Content and i18n

Title says what failed in plain words ("Could not load the model list"). Source and details
are machine values and stay untranslated; the action is a verb.

## Motion

None beyond the action button.

## Do / Don't

- Do include the source and time so the user can tell a stale error from a new one.
- Don't show a stack trace without a disclosure.
