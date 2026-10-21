---
id: status-pill
level: pattern
states: [running, waiting, hibernating, finished, error, unknown]
tokens: []
since: 0.1.0
---

# StatusPill

## Purpose

Shows the state of a run, session or agent with a word and a shape.

## When to use

- Session lists, run headers, sub-agent cards and the activity view.

## When not to use

- Static classification: use Badge.
- Progress with a known amount: use a progress bar or meter.

## Anatomy and variants

A pill with a status dot and a label. Dots: filled for running, finished and error (error is
square), a ring for waiting, a dashed ring for hibernating and unknown.

## States

running, waiting, hibernating, finished, error and unknown.

## Accessibility

- The label is real text; the dot is `aria-hidden`.
- Status is never colour alone: shape and text differ for every state.
- Unknown is a designed state ("Unknown"), never a blank.

## Content and i18n

Default labels are localized; override with a translated label for a more specific state,
such as "Waiting for review".

## Motion

Running pulses the dot's opacity over `--motion-loop-duration`. Under reduced motion the dot is
static; the word carries the state.

## Do / Don't

- Do place it where the state changes are visible without opening the run.
- Don't animate any other state.
