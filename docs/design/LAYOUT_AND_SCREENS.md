# Layout and screens

**Status:** accepted direction (D-131–D-137, D-139); built in stages U1, NC1, C1 and later ·
**Updated:** 2026-10-20

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

- **Navigation sidebar** — New, Projects, Models, Settings, then plugin entries, then the session
  list (grouped by project, state or date; status dots for running, waiting for you,
  hibernating, finished-unseen and error; pinned items). The user can move it left or right,
  collapse it to a rail or hide it; the four core entries always exist and stay reachable from
  the command palette (D-131). Glass material.
- **Status strip** (top, extensible by status items): breadcrumb, Developer | Visual switch,
  machine chip, worst quota window, keep-awake and power, inbox count, command palette. Any status
  item can be promoted to a block.
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

## 4. Experience modes (D-132)

| | Developer | Visual |
| --- | --- | --- |
| Centre | chat with Changes; terminal at the bottom | chat with Artifacts and product preview; Browser |
| Right | Context, Plan, Processes, Environment, Files | Plan, Artifacts, Sub-agents |
| Code | diffs, files, terminal, trace | a summary only ("3 files changed, tests green") with "Show in Developer" |

Switching mode swaps the active layout document; it never deletes the other mode's layout.

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
| E1 | New session | The logo, project picker (projects may have no folder), prompt box, access mode, model or role preset picker, microphone, attachment, a **Run options** disclosure (machine, worktree, branch, effort, budget, judge, ledger mode), chips only for non-default values, recent projects. The composer adapts to the selected models' input modalities. |
| W1 | Session workspace | Header (title, project, machine, Chat \| Trace view, share, child-agent pills); transcript; dock lanes above the composer (goal bar, ledger strip, prompt queue, steering); composer with the context ring; the blocks around it. |
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
| T2 | Developer area | Visible only with Developer mode on (D-137): live component catalog with every state, theme, density, contrast and transparency regime; approvals; token inspector; slot map; plugin inspector; event-log tail; feature flags. |

## 7. Implementation status (U1 session features, 2026-10-23)

- **E1 New session** is implemented at `/agent` (`packages/web/src/features/new-session`): project picker with
  folder state, composer with Enter to start, connection, model ID, access mode, a Run options disclosure
  (folders, network hosts, local context, attachment ids, protected paths), chips for non-default values,
  recent projects (per browser, opaque ids), and the loading, empty, error, `node_unreachable` and degraded
  states. Not built: microphone, model or role presets, and the machine, worktree, branch, effort, budget,
  judge and ledger options, because no node API accepts them yet.
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
