# Owner decisions — 2026-10-20

**Status:** accepted · **Date:** 2026-10-20 · **Decisions:** D-123–D-140
**Extends:** [2026-10-19 addendum](2026-10-19-owner-decisions-addendum.md).

The owner asked for a notification center that warns before API balances or subscription
usage windows run out and lets them act from the notification, and decided what to do with
the chosen logo.

| ID | Topic | Decision |
| --- | --- | --- |
| D-123 | Quota alert thresholds | Default alerts at 20%, 10% and 5% remaining for every usage window (5-hour, weekly, daily, monthly) and balance, each once per window instance, plus a forecast alert when the burn rate exhausts the quota before the reset or before dependent runs finish. Configurable per connection. See [ADR-0033](0033-notification-center-and-quota-alerts.md). |
| D-124 | Automatic reactions | Guanxi reacts on its own (switch a role to a fallback connection, pause background runs) only when the run's policy names that reaction; otherwise it recommends an action in the notification. |
| D-125 | Delivery channels | In-app notification center, operating-system notifications and phone push. Other channels (Telegram, email) are not planned now; they can come later as plugins. |
| D-126 | Logo | The chosen logo, concept 05 (`guanxi-gx-v1`), lives in `assets/brand/guanxi-gx-v1/` with its reproducible build scripts; stage U1 wires it into the design system. |

## Design system and workspace (later the same day)

The owner asked for a full design system before agents build UI at scale: brand book, style
guide, design principles, tokens, a UI kit, a live component catalog with an approval loop,
and checks that keep many agents consistent. Four research lanes informed the answers
([research](../research/README.md), 2026-10-20 design lanes).

| ID | Topic | Decision |
| --- | --- | --- |
| D-127 | Visual direction | **Glacier — ink and ice.** Ink text, a frost canvas, frosted glass with a faint static grain **only on floating layers** (sidebar, title strip, composer, menus, popovers, toasts); reading surfaces (transcript, diff, code, terminal, tables) stay opaque. Appearance offers Glass, Tinted and Solid; the OS "reduce transparency" setting selects Solid. No hue-gradient blobs; not a copy of DeepSeek Harness's identity. |
| D-128 | Colour | Accent **verdigris** (the logo ink with chroma). Dark theme canvas is the **exact brand ink** `#182322`. Status colours are shared across themes. Ivory `#F4F2E9` stays a logo colour, not a UI canvas. |
| D-129 | Typography | **IBM Plex**: Plex Sans for UI and prose, Plex Mono only for machine values (code, logs, IDs, paths, timings), Plex script companions (Arabic, Hebrew, Devanagari, Thai, JP, KR, SC, TC) as optional packs. Fonts are self-hosted from upstream files, never from the npm packages (telemetry `postinstall`) or a CDN at runtime. |
| D-130 | Chinese name | The brand uses **關係** (traditional characters), drawn as outlines, not set in a live font. |
| D-131 | Density and layout | Two density presets (comfortable, compact) that never move blocks. The layout is user-owned: any block can go to any zone (left, right, top, bottom, centre grid, floating, popout), blocks can be added, hidden and resized, status lines extended, layouts saved. The navigation sidebar can move left or right, collapse or hide, but its four core entries (New, Projects, Models, Settings) always exist; plugins never rearrange the layout. Layouts: an account default plus per-project overrides. |
| D-132 | Experience modes | **Developer** (IDE-like: files, diffs, terminal, processes, trace) and **Visual** (artifacts, diagrams, product preview, browser). Visual mode shows a code-free summary ("3 files changed, tests green") with "show in Developer". |
| D-133 | Right-drawer defaults | Visible by default: Context, Changes, Plan, Processes, Environment, Files, Terminal, Artifacts, Browser, Sub-agents. Quota and cost live in the status strip and are one click away as a block. |
| D-134 | Energy | Exact per-machine power, battery and load; per-agent energy as an estimate with a confidence label. |
| D-135 | Side chats | Ephemeral by default, labelled as such, with "Save to session log" and "Send to main". |
| D-136 | Toasts | While the app is focused, toasts only for `input_required`, critical errors and the 10% and 5% quota thresholds; at most two at once; everything else goes to the badge and the inbox. |
| D-137 | Component catalog | A live catalog inside the product under Settings → Developer, shown only when Developer mode is on; Storybook as the developer and agent harness; both read the same story files. |
| D-138 | Approvals | The owner approves components in the in-app catalog. An approval is recorded in the repository by the app, bound to the component's source and snapshot hashes, and signed with an owner key the app keeps in the OS keychain (no git commit signing required). Unapproved or stale components block **releases only**; draft components may not ship on product screens. |
| D-139 | Agent browser | Guanxi's browser is the **agents' browser plus product preview**, not a daily browser: Chromium run by the node service, shown as a pane the user can watch and take over. |
| D-140 | Site sessions | Agents get site access per site: by logging in inside the Guanxi browser, or through the **Guanxi Bridge** extension in the user's Chrome that shares one site's session after the user grants it (revocable in one click), or by delegated control of the live Chrome. Bookmarks and history import from files; passwords come from a password manager by reference. No bulk cookie import and no reading of browser secret stores in core. |
