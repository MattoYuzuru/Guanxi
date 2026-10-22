---
id: menu
level: primitive
states: [closed, open]
tokens: []
since: 0.1.0
---

# Menu

## Purpose

Lists commands for one object behind a trigger: rename, duplicate, export, delete.

## When to use

- Three or more actions that do not fit as buttons.
- Row and block actions ("Move block to…" lands here in stage U1).

## When not to use

- Choosing a value: use Select.
- Navigation: use links.

## Anatomy and variants

Root, Trigger, Content (glass), Item (`default` or `danger`), Group, GroupLabel and Separator,
from Base UI. Items may start with a 16 px Lucide icon.

## States

closed and open. The open story includes a disabled item and a danger item.

## Accessibility

- `menu` and `menuitem` roles, arrow-key navigation, typeahead, Escape closes and focus returns
  to the trigger.
- Disabled items stay readable and may receive keyboard focus, matching Base UI's menu
  navigation. They expose `aria-disabled` and cannot activate with Enter, Space or a pointer.
  Focus lets a user discover the unavailable command; it does not enable that command.
- Danger items use text and an icon, not colour alone.

## Content and i18n

Verb-first labels in sentence case, no trailing ellipsis unless the item opens a dialog.

## Motion

Same as Popover: `--motion-duration-medium` in, `--motion-duration-fast` out, no offset under
reduced motion.

## Do / Don't

- Do group related items and separate destructive ones.
- Don't hide the only way to do something inside a menu.
