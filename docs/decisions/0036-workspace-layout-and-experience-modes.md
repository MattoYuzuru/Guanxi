# ADR-0036: Workspace layout, blocks and experience modes

**Status:** accepted direction (owner decisions D-131–D-133); proposed design · **Date:** 2026-10-20
**Extends:** [ADR-0022](0022-plugin-trust-tiers-ui-slots-and-design-tokens.md) (slots),
[ADR-0026](0026-clients-desktop-web-mobile.md) (clients).

## Context

The owner wants every block placeable anywhere (sidebars, top, a centre grid of several blocks,
floating, popout), blocks added and hidden, status lines extended, layouts saved, two density
presets, and two experience modes (Developer and Visual). Only Dockview and FlexLayout cover that
feature list; neither offers free keyboard docking, which WCAG 2.2 (SC 2.5.7, 2.1.1) requires.

## Decision

1. **Engine:** Dockview (`dockview-core`, `dockview-react`, MIT) behind a thin
   `WorkspaceLayout` adapter so FlexLayout (MIT) can replace it by changing one adapter.
   `dockview-enterprise` (proprietary) is on the license deny list and never imported.
2. **Zones:** left, right, top, bottom, centre grid, floating, popout. The navigation sidebar is a
   fixed-content zone the user can move left or right, collapse or hide; its four core entries
   always exist (D-131).
3. **Blocks** are contributions to a keyed slot `workspace.block`:

   ```ts
   interface BlockContribution {
     id: string;                 // "guanxi.core/terminal"
     title: LocaleKey;
     icon: string;               // Lucide name
     modes: ("developer" | "visual")[];
     defaultZone: "left" | "right" | "top" | "bottom" | "center";
     multiInstance: boolean;
     keepAlive: boolean;         // terminal, browser
     minSize?: { w: number; h: number };
     card?: ComponentRef;        // compact rail card
     pane: ComponentRef | { mcpApp: string };  // T2 plugins render as MCP Apps
   }
   ```

   Unloading a plugin removes its blocks; saved layouts keep a placeholder.
4. **Accessibility:** "Move block to…" from the block menu, command palette and keyboard; F6 and
   Shift+F6 cycle zones; every move is announced; drag previews respect reduced motion.
5. **Layout documents** (`guanxi.layout/1`): scope (account, optional project, mode, device
   class), density, base preset, engine state, block map with plugin versions and a priority for
   narrow screens, hidden blocks, status-line items, `rev`, `updatedAt`, `updatedBy`. Resolution
   order: device override → project + mode → account + mode → built-in. Several named layouts per
   scope. Popout and floating window geometry is device-local and never replicated. Replication
   is whole-document last-writer-wins by `(rev, updatedAt, device)`; the losing copy is kept as
   "Recovered layout". Documents are validated with Zod; unknown blocks become placeholders;
   engine major upgrades migrate or fall back to the built-in layout; safe mode ignores plugin
   blocks; no secret values in `params`.
6. **Modes:** Developer and Visual each have their own active layout; switching never deletes the
   other. Defaults per LAYOUT_AND_SCREENS §4–5 (D-132, D-133).
7. **Density** presets are token sets and never move blocks.
8. **Phone:** no docking; blocks become a stacked tab list by priority.

## Validation (U1 spike exit criteria before the engine is locked)

1. Left, right and bottom zones work from locked groups using free APIs only.
2. "Move block to…" works by keyboard and pointer without dragging and is announced.
3. A popout works in the sandboxed Electron renderer through a same-origin popout page.
4. Terminal and Browser blocks keep their state across move, float and popout.
5. A layout with 30 blocks restores within the U1 performance budget.

## Evidence

[04 agent browser and layout](../research/2026-10-20-design/04-agent-browser-and-layout.md)
§§6–8; [01 harness UI patterns](../research/2026-10-20-design/01-harness-ui-patterns.md) §5;
WCAG 2.2 SC 2.1.1, 2.4.3, 2.5.7.
