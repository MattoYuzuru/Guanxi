---
id: workspace-chrome
level: pattern
states: [default, empty, placeholder, error, loading, phone, draft, toolbar, mover]
tokens: [panel-padding, font-text-size, color-background-primary, color-text-primary]
since: 0.1.0
---

# WorkspaceChrome

## Purpose

Hosts workspace controls, opaque block frames, the move dialog and phone tab navigation.

## When to use

Session workspaces whose block content and lifetime are managed by WorkspaceLayout.

## When not to use

General settings forms, transcript rows or a replacement for the docking adapter.

## Anatomy and variants

The discriminated `kind` selects toolbar, pane, mover, phone or state. Controls compose the
existing Button, Input, Textarea, Menu, Dialog, EmptyState and ErrorState components. Pane drafts are
controlled by the host and do not execute commands or navigate.

## States

Default pane; empty pane; unavailable block placeholder; error with retry; phone tab list.
Loading reserves the known toolbar/content geometry with a static, noninteractive skeleton;
the saved docking grid is unknown before hydration. Pane descriptions are supporting text,
not empty collections. Real empty content has one meaningful action.
Controlled terminal draft; toolbar with save; open move dialog. Toolbar actions expose disabled while persistence is pending. Move choices are named menus.

## Accessibility

Every control receives translated labels. The mover uses Dialog focus containment and
restoration. Phone tabs use vertical arrow keys, Home/End and roving focus. The host must
supply matching tab panels, live announcements and F6 zone navigation.
Structured errors include observed source/time and safe details. Legacy `kind="state"`
error/action props remain accepted; without supplied facts their alert renders no invented
source or time. Loading cannot be combined with an error or action. Its status is named and
the geometry is hidden from assistive technology.

## Content and i18n

All copy comes from translated props. Unknown data is an explanatory sentence, never a number.

## Motion

No spatial animation. Existing primitives obey reduced-motion tokens.

## Do / Don't

- Do keep reading surfaces opaque and pane content host-owned.
- Don't use terminal drafts as executable input or invent process telemetry.
