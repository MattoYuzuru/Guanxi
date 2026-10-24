---
id: composer
level: pattern
states: [empty, typing, running, disabled, docked]
tokens: []
since: 0.1.0
---

# Composer

## Purpose

The prompt box of a session (D-207): where the user writes, and where scope lives — permission
mode at the lower left; model, effort and context at the lower right; Send or Stop at the end.

## When to use

- New session (centred) and an active session (docked at the bottom).
- Chat threads and side chats that send a prompt to a model or agent.

## When not to use

- Plain multi-line form fields: use Textarea.
- Search: use the command palette input.

## Anatomy and variants

A form styled as a floating pane: optional header (attachments, non-default chips), an
auto-growing borderless text area, and a footer with leading and trailing slots and a round
action button. Layouts: `centered` (taller, larger text) and `docked`.

## States

empty, typing, running (Stop replaces Send), disabled and docked.

## Accessibility

- The text area has a name; the host passes `describedBy` for the reason sending is blocked.
- Enter sends, Shift+Enter adds a line, composition input never sends.
- Send stays focusable while blocked so its description can be read; Stop is a separate label.
- The whole card shows the focus ring when the text area has keyboard focus.

## Content and i18n

Placeholder is a short instruction ("Describe the task"); Send and Stop labels default to
`ui.composer.*` keys.

## Motion

Only colour changes; the text area grows without animation.

## Do / Don't

- Do keep only non-default options visible as chips in the header.
- Don't put glass behind the prompt text; the composer is opaque.
