---
id: status-item
level: pattern
states: [default, value, unknown, warning, badge, open]
tokens: []
since: 0.1.0
---

# StatusItem

## Purpose

Shows one machine or harness fact in the status strip as an icon (device, memory, quota,
keep-awake, power, runtime, inbox) with a tooltip and a short popover anchored to it (D-202).

## When to use

- Status facts that are glanceable and need detail only on demand.
- A value worth seeing at all times: pass `value` and it sits next to the icon in bold.

## When not to use

- Primary actions: use Button or IconButton.
- Long explanations or forms: link to the page that owns them from the popover.

## Anatomy and variants

A ghost trigger (icon, optional value, optional count or dot) inside a Tooltip and a Popover.
The popover has a title, facts as a key/value list (`gx-popover-facts`) and a provenance line
(`gx-popover-footnote`). Tones: neutral, unknown, accent, success, warning, danger.

## States

default, value, unknown, warning, badge and open.

## Accessibility

- The trigger's name combines label and value ("Memory: 16.8 GB"), or says "Unknown".
- The tooltip repeats the label on hover and focus; the popover opens on click, Enter or Space
  and returns focus on Escape.
- Tone never carries meaning alone: the popover states it in words.

## Content and i18n

Labels are nouns ("Memory"); values are machine values with thin units ("16.8 GB"). Provenance
follows BRAND: source and observation time. No decorative middle dots.

## Motion

The popover uses the shared pop transition; under reduced motion it only fades.

## Do / Don't

- Do render unknown as unknown, with the source that would answer it.
- Don't add a Refresh button to a popover; the data stays current by itself (D-203).
