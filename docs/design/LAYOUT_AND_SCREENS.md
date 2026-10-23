# Layout and screens

**Status:** accepted direction (D-131–D-137, D-139; shell, modes and composer revised by
D-202–D-207); built in stages U1, NC1, C1 and the UI-redesign lane · **Updated:** 2026-10-23

Evidence: [01 harness UI patterns](../research/2026-10-20-design/01-harness-ui-patterns.md) §5,
[04 agent browser and layout](../research/2026-10-20-design/04-agent-browser-and-layout.md) §§6–8.
Layout engine and persistence: [ADR-0036](../decisions/0036-workspace-layout-and-experience-modes.md).

## 1. State vocabulary

Every surface declares these states, built once as patterns and reused everywhere.

| State | Rule |
| --- | --- |
| empty | One sentence and one primary action; never a blank panel. |
| loading | A skeleton with the final geometry; spinners only for operations under about 2 s. |
| streaming | A live marker; follow the tail until the user scrolls up; never invent elapsed time or a percentage. |
| error | What failed, the source, the time and the next action; copyable details. |
| offline / unreachable | Last known data with its age ("as of 14:02, 6 min ago") and the named state (`home_unreachable`, `node_unreachable`, `judge_unavailable`); network actions disabled with a reason. |
| unknown | "Unknown" plus the source that would answer it, never a guess. |
| degraded | Partial data with a list of what is missing. |
| estimated | A visible "estimated" badge when Guanxi meters or infers a value. |

## 2. Shell

The window is the chrome tone; the main surface is a white pane floating on it (D-200).

- **Navigation sidebar** — New, Projects, Models, Settings (icon and label; icon only in the rail),
  then plugin entries, then the session list (grouped by pinned, today, yesterday, earlier; status
  dots for running, waiting for you, hibernating, finished and error, with status and provenance
  as the row's description; a quiet mark for finished-unseen; pin on hover). It sits on the chrome,
  not on glass. The user can move it left or right, collapse it to a rail or hide it from the
  sidebar menu in the strip or the customisation popover; the four core entries always exist and
  stay reachable from the command palette (D-131). The list refreshes by itself; no Refresh button
  and no "fetched at" caption (D-203).
- **Status strip** (top, one row, borderless; D-202): the sidebar menu, the brand mark and the page
  name at the left; at the right, icon status items with tooltips and anchored popovers — device,
  memory (available memory as the value; total, available, free pages and pressure in the
  popover), runtime (Ollama state with what to do, admission, models, host telemetry), quota,
  keep-awake and power (unknown until a node reports them), and the inbox (tray icon with an unread
  badge) — then the customisation popover, the light/dark toggle (D-205) and the palette button
  with its shortcut. There is no Developer | Visual switch (D-204). Any status item can later be
  promoted to a block.
- **Customisation popover** (D-204): density, sidebar side and width, motion, follow the system
  theme, and Max graphics (D-206), as icon segments and switches.
- **Notification center** (ADR-0033) — one inbox with filters (Unread, Waiting for you, Running,
  Quota, Errors, project) and typed actions.
- **Command palette** — sessions, commands, models, settings, blocks, "Move block to…".
- **Toasts** — only for `input_required`, critical errors and the 10% and 5% quota thresholds
  while the app is focused; at most two; always mirrored in the inbox (D-136). OS notifications
  when the app is in the background; phone push for the same events.

## 3. Workspace layout

- **Zones:** `left`, `right`, `top` and `bottom` (collapsible columns and rows), `center` (a grid
  of groups — several blocks visible at once), `floating` windows and `popout` windows.
- **Blocks** are plugin contributions (built-in blocks are core plugins). Each block has a
  compact **card** for rails and a full **pane**; it declares the modes it belongs to, its
  default zone, whether several instances may exist and whether it keeps running while hidden.
- **The user owns the layout:** drag, or use "Move block to…" from the block menu, the command
  palette or the keyboard (F6 cycles zones); float, pop out, hide, add, reset. Moves are announced
  to screen readers.
- **Layouts** are saved documents: an account default per mode, optional per-project overrides,
  several named layouts, window geometry kept per device (D-131).
- **Density** presets change spacing and type, never block positions.
- **Phone (PWA):** no docking; blocks become a stacked tab list ordered by the layout's priority.

## 4. Experience modes (superseded by D-204)

D-132's Developer and Visual modes are retired: the product has one interface, visual from the
start. The workspace still reads the per-mode layout documents it stored (no data migration is
needed) but uses one and offers no mode choice; density and other presentation preferences live
in the customisation popover.

## 5. Blocks

Visible by default (D-133): Context, Changes, Plan, Processes, Environment, Files, Terminal,
Artifacts, Browser, Sub-agents. One click away: Quota and cost, Connectors, Board, Notifications,
Status, Activity.

| Block | Card | Pane | Notable states |
| --- | --- | --- | --- |
| Context | ring with %, window size and its source | breakdown by system, tools, skills, MCP, history, attachments; compaction and handoff history | unknown when the model reports no window |
| Quota and cost | worst window (5-hour, weekly, balance) and the run's cost | every connection with forecasts (ADR-0033) | estimated; age of the last observation |
| Plan | current item, "4 of 9", blockers | run ledger with acceptance commands, evidence links, derived status (ADR-0032) | mode off; "verification requested" |
| Changes | files changed with +/− | scopes (uncommitted, branch, last turn, commit), batched line comments, per-hunk stage and revert, PR and CI checks | live during the run; git unavailable |
| Files | worktree and changed count | tree, flat search, changed-only, by type, worktree compare; opens files in viewers or an external editor | "Project has no folder"; cached remote tree with age |
| Terminal | open terminals with running or exit badges | tabbed terminals on the chosen machine; collapsing keeps processes alive | ended with exit code; machine unreachable |
| Processes | "3 containers · 1 browser · 2 shells" with a CPU sparkline | process tree per agent and sub-agent: shells, Docker containers, browser contexts, dev servers with ports, leases; CPU, RAM, GPU, network; Open and Finished tabs; Stop, Kill, Open logs or URL | unknown attribution; container runtime unreachable |
| Environment | machine, OS, branch, access mode | node metrics, leases, ports, keep-awake hold, power source, battery, per-agent energy estimate with confidence (D-134) | node unreachable |
| Artifacts | files, images and reports produced | gallery and list with preview and image editor; open in folder | "Nothing produced yet" |
| Browser | current page or preview URL | the agent browser pane: watch, take over, hand back (ADR-0035) | connection refused with the port's lease owner; `input_required` for captcha or 2FA |
| Sub-agents | child agents and their states | lineage tree with role, model, machine, cost, handoff count | lead "asleep, wakes on …" |
| Connectors | MCP servers, skills and tools with health | per-project enablement, tool budget, sandbox profile | off by default |
| Board | project work strip | the work ledger board (ADR-0032) | mode off |

Users may stop or kill processes from the Processes pane in either access mode: access modes
limit agents, not the user's own actions.

## 6. Screens

| ID | Screen | Purpose and contents |
| --- | --- | --- |
| E1 | New session | D-207: the composer centred on an empty pane, opening in the current (most recent) project; the project picker above it; the permission mode at its lower left; model, connection and context at its lower right; **Run options** behind one button (folders, hosts, attachments, protected paths; later machine, worktree, branch, effort, budget, judge, ledger mode); chips only for non-default values. The composer adapts to the selected models' input modalities. |
| W1 | Session workspace | Header (title, status, icon buttons for trace and session info with anchored popovers); transcript; dock lanes above the composer (goal bar, ledger strip, prompt queue, steering); the composer docked at the bottom after the first prompt (D-207) with the context at its lower right; the blocks around it. |
| W2 | Transcript | Tool rows collapsed by default with three views (normal, thinking, verbose); renderers keyed by tool name or MIME type; compaction and handoff markers as rows; voice-origin marks on prompts. |
| W3 | Trace inspector | Turn-aware ledger and timing overview with a record inspector (tokens, cost, duration, input, output, connection, machine). Reasoning hidden with a reason where it is not stored. |
| W4 | Side chat | A floating or docked chat that reads the session; ephemeral and labelled so, with "Save to session log" and "Send to main" (D-135). |
| P1 | Projects | Folder or "no folder", default models and roles, run policy, glossary, linked tracker. |
| P2 | Board | Work ledger projection (ADR-0032). |
| P3 | Activity | Every run across sessions and machines with status, ETA with confidence and cost. |
| P4 | Fleet | Per-machine cards: CPU, RAM, GPU, disk, power, battery, keep-awake, sessions, containers, leases. |
| M1 | Models | Catalog search by modality, fit with source and confidence, downloads with bytes, speed, ETA and resume, loaded models per machine. |
| M2 | Model workbench | Every parameter with recommended values; media preview and editor. |
| C1 | Connections | Keys, subscription agents and services with health, balances, windows and limits; secrets shown only as references; the **Browser** page lists site grants with source, last use and live-sync indicator (ADR-0035). |
| T1 | Settings | General, Appearance (theme, density, transparency, motion, fonts per role), Voice and glossary, Notifications (channels, quiet hours), Machines, Accounts, Plugins, Developer. |
| T2 | Developer area | Visible only with the developer-area switch on (D-137; not a product mode): live component catalog with every state, theme, density, contrast and transparency regime; approvals; token inspector; slot map; plugin inspector; event-log tail; feature flags. |

## 7. Implementation status (U1 session features, 2026-10-23)

- **E1 New session** is implemented at `/agent` (`packages/web/src/features/new-session`) in the D-207 layout
  (UI-redesign lane): the composer centred on the pane, the current project preselected (most recent existing, or
  the only one), the access mode at the composer's lower left, connection, model ID (installed-model suggestions for a
  local runtime) and the context window at its lower right, Run options (folders, network hosts, attachment ids,
  protected paths) behind one button, chips for non-default values, one hint naming the first missing input, and the
  loading, empty, error, `node_unreachable` and degraded states; failed choice reads recover by themselves. Not
  built: microphone, model or role presets, and the machine, worktree, branch, effort, budget, judge and ledger
  options, because no node API accepts them yet (effort appears once an adapter declares it).
- **Finished-unseen** status is derived from the node's durable run state and log head against the head this
  browser last showed (`features/shell/seen.ts`); it has no timers and needs a session-list read to update.
- **W4 Side chat** is implemented as a docked panel on native sessions
  (`features/side-chat`), ephemeral by construction, with Save to session log and Send to main. See the
  [native-agent README](../../packages/server/src/native-agent/README.md#ephemeral-side-chat-u1) for the node
  seam. The floating placement and legacy Chat threads are not built.
- **Voice glossary editor** (T1 "Voice and glossary") is implemented at `/settings/voice/glossary`
  (`packages/web/src/features/voice`), linked from Settings and the command palette: account-wide and
  per-project entries, create and edit (canonical term, spoken forms, language, case and ending flags),
  deactivate, reactivate, one-click revert, a newest-first revision history and a live preview built on
  `apply-preview` that highlights replacements and shows the glossary revision hash. It has the loading,
  empty, error, `node_unreachable` and degraded (project list unavailable) states. Not built: search or
  paging of entries (the node has neither), import and export, learned-candidate review (V2), and a
  project-page entry point.

## 8. Implementation status (NC1 notification center UI, 2026-10-23)

- The **notification center** is implemented at `/notifications` (`packages/web/src/features/notifications`) and
  reachable from the status strip's Inbox item (unread count, a polite live region for arrivals) and the command
  palette. It reads the MS2 routes through one shared store, so the strip's count and the Unread list are derived from
  the same rows. It shows state (unread, read, acted, snoozed, expired), severity as text plus a shape, and for every
  row the fact's source, observation time and confidence. Mark read, snooze (presets, until the window resets, or a
  chosen time) and the typed actions run from it; every action button except Mark read is enabled only while the node
  reports it `available`, and Offline means the node did not answer, not the browser's network flag; `not_configured` and `not_exposed`
  actions are shown disabled with the reason. Action requests carry an `Idempotency-Key` that is reused only when the
  outcome was unknown. Loading, empty, error, offline and paging states are covered.
- Not built: filters by kind, project or "waiting for you" (the wire has no such fields), mark all read and a toast for
  `input_required` and the 10% and 5% thresholds (no node API or push channel), `add_prompt`, `choose_action` and
  `raise_budget` (not exposed on the wire), a floating panel (the center is a route), and settings for channels and
  quiet hours.

## 9. Implementation status (UI-redesign lane, 2026-10-23)

- **Shell:** white panes floating on the chrome; one borderless status strip of icon status items with popovers;
  customisation popover; light/dark toggle; Max graphics canvas behind the chrome (off by default). The runtime bar,
  the Ollama banner and the Developer/Visual chips are gone; health, runtime samples, the session list and the inbox
  update quietly and recover by themselves.
- **W1 native session:** header with status, trace and session-info icon buttons; progress (plan, queue, latest
  response) in the scrolling column; the composer docked at the bottom.
- **Chat threads:** the shared composer docked with auto-approve at its lower left and model and context at its lower
  right; trace, chat info and new chat as icon buttons; per-message details behind an info icon.
- **Phone (under 640 px of shell width):** the navigation is a drawer over an inert page, the status strip is one row
  with a single overflow control for the status items, and touch screens show no ⌘K keycaps.
- Not built in this lane: the fleet map (D-209) and provider models in the picker (D-208, the picker's suggestion list
  is generic).
