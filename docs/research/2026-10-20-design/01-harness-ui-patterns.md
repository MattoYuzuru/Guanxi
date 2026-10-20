# Harness UI patterns — survey and screen inventory for Guanxi

**Status:** research (proposed input for stage U1; nothing here is accepted or implemented) ·
**Date:** 2026-10-20 · **Sources accessed:** 2026-10-20 unless noted

**Scope:** Claude Code desktop (Code tab) and claude.ai; ChatGPT desktop/web with Codex (cloud, app,
IDE, CLI); DeepSeek Harness (DSH) web/desktop UI; OpenCode desktop/web; Cursor; Zed agent panel;
Goose desktop; Conductor; Warp; LM Studio; JetBrains AI Assistant and Junie; Apple Liquid Glass
guidance and the accessibility settings that apply to translucent materials.

**Inputs from Guanxi:** [VISION](../../vision/VISION.md) (principle 8, "simple first screen"),
[REQUIREMENTS](../../vision/REQUIREMENTS.md) sections D, F, G and J,
[ADR-0022](../../decisions/0022-plugin-trust-tiers-ui-slots-and-design-tokens.md) (slots and tokens),
[ADR-0026](../../decisions/0026-clients-desktop-web-mobile.md) (Electron shell and new-session screen),
[ADR-0032](../../decisions/0032-work-ledger-board-and-tracker-sync.md) (ledger and board),
[ADR-0033](../../decisions/0033-notification-center-and-quota-alerts.md) (notification center).

**Legend:** **[V]** means verified in a primary source listed under [Sources](#sources): official
docs, a changelog, a product's own repository, or design guidelines. **[I]** means inferred, or
backed only by a secondary source or a search snippet. Numbers in square brackets point to the
source list.

**How the evidence was gathered:**

- DSH was read from a shallow clone of `deepseek-ai/deepseek-harness` at commit `687f282`
  (2026-10-17) [1]. All DSH CSS values below are quoted from that commit.
- The other products were read from their docs and changelogs. None of them publishes design
  tokens, so their density, typography, colour and motion cells are marked "not documented" unless
  a source says otherwise.
- The Claude Code desktop rows also use what the app's own session-control tool surface exposed
  to this agent on 2026-10-20 [25]. That source is first-hand but is not a public document.

---

## Contents

1. [Summary](#1-summary)
2. [Per-product tables](#2-per-product-tables)
3. [DeepSeek Harness: how the "glacier" look is built](#3-deepseek-harness-how-the-glacier-look-is-built)
4. [The owner's wishes against the products](#4-the-owners-wishes-against-the-products)
5. [Consolidated screen inventory for Guanxi](#5-consolidated-screen-inventory-for-guanxi)
6. [Interaction principles](#6-interaction-principles)
7. [What to borrow and what to avoid](#7-what-to-borrow-and-what-to-avoid)
8. [Accessibility for translucent materials](#8-accessibility-for-translucent-materials)
9. [Open questions for the owner](#9-open-questions-for-the-owner)
10. [Sources](#sources)

---

## 1. Summary

**Converged patterns.** By October 2026 the agent-harness products have settled on one shape:

- A **left session list** grouped by project, state or date, with status dots and unread markers.
- A **centre transcript** with the composer pinned at the bottom.
- A **right-side area of panes or cards**: changes/diff, terminal, browser/preview, plan,
  tasks, files.
- A **composer whose control row carries the run's scope**: environment (local, worktree, cloud,
  SSH), folder or project, permission mode, model and effort, and a context or usage ring.

These products show it: Claude Code desktop [18], Codex in the ChatGPT app [27][30][31], Cursor
[47][48][51], Conductor [65][69], Zed [56], DSH [6][8][12]. **[V]**

**Patterns that recur in at least three products [V]:**

| Pattern | Products |
| --- | --- |
| A context indicator next to the composer that opens a categorized breakdown | Cursor [51], Warp [72], Claude [18], DSH [12] |
| A queue for the next prompt that is separate from "send now / steer" | Cursor [47], Zed [56], Warp [72], DSH [12], Claude [18] |
| A goal or objective bar above the composer, with pause, resume, edit and clear | Codex [35], Conductor [69], DSH [14], Cursor `/goal` [47] |
| Side chats that read the main thread but do not write to it | Claude `/btw` [18], Cursor `/side` and `/btw` [47], Codex `/side` [34] |
| Line comments on a diff that go back to the agent as one batch | Claude [18], Conductor [70], Warp [76], Codex [36] |
| An activity or notification inbox with Unread, Running and Waiting filters, OS alerts on completion, and status badges on tabs or rows | Codex [29], Warp [77], Goose [62], OpenCode [44] |
| A keep-awake setting | Claude [19], Codex [35], Cursor [55], Zed `prevent_idle_sleep` [56] |

**Gaps that nobody fills.** No surveyed product documents:

- a per-agent process view (containers, browser sessions, child processes);
- per-agent energy or battery attribution;
- a fleet-wide view across machines;
- a native work board whose status comes from evidence rather than from the agent.

These gaps are Guanxi's opening, and they match REQ-B4, REQ-C9, REQ-C10 and REQ-J1. **[I]**

**Recommended headline inventory [I]:**

- **Four sidebar destinations:** New, Projects, Models, Settings (REQ-F3).
- **Two global overlays:** Notification center and Command palette.
- **One session workspace:** the transcript, plus a **right drawer built from blocks** (small
  cards) that can expand into **docked panes**.
- **Two project-level views:** Board and Processes/Fleet.
- **Developer area** at the far end of Settings, holding the live component catalogue.

[Section 5](#5-consolidated-screen-inventory-for-guanxi) lists each surface with its states.

---

## 2. Per-product tables

These tables are split into three topic groups so they stay readable. "n/d" means not documented
in the sources fetched. Every cell is **[V]** unless it is marked **[I]**.

### 2.1 Layout, entry screen and side panels

| Product | Layout | Entry / empty session | Side panels |
| --- | --- | --- | --- |
| **Claude Code desktop** (Code tab) | Three app tabs: Chat, Cowork, Code. **Left sidebar:** sessions, "+ New", Customize, and a Scheduled section. Sessions can be grouped by date, project, state or custom, and sorted by recency, name or created date. Pinned and Routines sections [18][25]. **Split view**, and panes can pop out into their own windows [18][25]. | **Prompt box:** greyed suggestion text that Tab accepts, and a "+" menu for files, commands, connectors and plugins. **Row under the box:** Environment (Local, SSH or Cloud), project folder with a Worktree toggle, Mode, and Model with a usage ring [18]. | A **session rail** of cards (Changes, Environment) that can be hidden. **Pane types:** chat, diff, browser, terminal, file, plan, tasks, subagent, PR and artifact [18][25]. Panes can be dragged, resized and popped out [18]. |
| **claude.ai** | Sidebar with Projects and Artifacts tabs. Chat and Cowork share one home since 2026-07-07 [24]. | n/d beyond the composer. | An **artifact panel** beside the chat with view-code, copy and download. Drafts open beside the chat with highlight-to-edit (2026-06-12) [22][24]. |
| **ChatGPT + Codex app** (merged 2026-07-09) | **Sidebar:** New chat, Recents, chats grouped under Projects, and pinning [26][28]. A **Chat/Work toggle** sits above the composer [27]. | **Under the composer:** Local, Worktree or Cloud; a base branch; and a permission control with "Ask for approval", "Approve for me" and "Full access" [30][31][32]. Composer predictions (beta, from 2026-10-09) [33]. | **Review pane** with scopes Unstaged, Staged, Commit, Branch and Last turn [36]. **Terminal drawer** [37]. Header actions: Hand off, Create branch here, Open [30]. |
| **Codex CLI / IDE** | IDE-sidebar extension in VS Code, Cursor and Windsurf [38]. CLI `/agents` "Command Center", where `p` pins a task [34]. | The CLI `/status` shows model, approval policy, writable roots and remaining context [34]. | n/d |
| **DeepSeek Harness** | **AppFrame** with three columns. The left sidebar collapses to a 56 px rail [6][14]. The right column gives way before the centre does [6]. | **Composer:** workspace picker, model and effort control, permission preset (Read Only, Workspace Write or Full access), context meter, Send. One persistent Lexical editor survives switching between "no session" and "session" [12][14]. | The **right Sidebar is a docking kit**: a split tree of tabbed panes. It has Normal and Fullscreen presentations (fullscreen is automatic below 768 px). **Tab types:** Files, Terminal, Browser, Document preview, Plan, Schedule, Review [8][13][14]. |
| **OpenCode desktop/web** | Tab-centric. Session tabs show unread indicators, and there are vertical tabs and side-panel tabs (v2.0.29–2.0.30) [44]. The web server runs on loopback; there is a PWA install and a "See Servers" view [43][44]. | Build and Plan agents, switched with Tab [45]. The model picker shows free models by default (v2.1.0) [44]. | Review panel, browser panel and terminal panel [44]. Issue #52348 reports that terminal, files and review are unavailable until the first message [46] **[I: snippet]**. |
| **Cursor** | Agent **sidepane** (Cmd+I), plus a separate **Agents Window** that spans several workspaces, with search and a Diffs view [47][48]. | **Mode** dropdown and Shift+Tab cycling. **Cloud** selector under the input. **Context ring** [49][50][51]. | **Diffs** view, side chats, and Canvases for cloud agents (2026-10-16) [48][55]. |
| **Zed** | A dockable **agent panel** with a Threads Sidebar grouped by project [56]. | Model selector with favourites, a **Profile** (tool set) selector, `@`-mentions, and an expand-editor control [56]. | **Review Changes** multibuffer; a "follow agent" toggle makes the editor track the files the agent touches [56]. |
| **Goose desktop** | **Sidebar pages:** Home, Chat, Recipes, Apps, Scheduler, Extensions, Settings. The sidebar can be **Tile or List**, placed **left, right, top or bottom**, and set to **Push or Overlay**. Items can be reordered or hidden [60]. | **Welcome:** provider quick setup [61]. **Home:** a prompt input with dictation; a **directory switcher at the bottom** [61][62]. | n/d |
| **Conductor** | **Sidebar:** workspaces, one git worktree each. Archived workspaces move to History [65][66]. | **New workspace** from a branch, PR, GitHub issue or Linear issue. **Composer:** per-agent model, Plan mode, Fast mode, thinking level [66][69]. | **Diff Viewer.** The **Checks** tab shows git status, PR, CI, deployments, review threads and todos [70][71]. |
| **Warp** | Terminal panes. **Conversation Panel** on the left with Active and Past [72]. **Agent Management Panel** for local and cloud runs [78]. | One **universal input** for shell and agent, with an autodetect label. A **toolbelt** (model, voice, images, cwd and branch chips) that can be reordered and hidden [73]. | **Code Review panel** [76]. A **pill bar** of child agents above the agent header [78]. |
| **LM Studio** | Chat with nested folders and split view [81]. Discover tab (⌘2) [82]. | User mode shows only chat; Developer mode exposes parameters [80]. | Advanced Configuration sidebar driven by presets [85]. |
| **JetBrains AI / Junie** | AI Chat **tool window** on the right toolbar [86]. | **Chat or Agents** mode, model selector, "Add attachment" [86]. Junie offers Default, Plan and Goal modes, with Safe, Auto or Brave risk levels [88]. | A changed-files pane with per-file revert and Rollback [88]. |

### 2.2 Progress, tool calls, diffs and background work

| Product | Progress / plan | Tool-call rendering | Diffs | Background / parallel work |
| --- | --- | --- | --- | --- |
| **Claude Code desktop** | Plan and Tasks panes (their rendering is n/d) [18]. A goal-style status is n/d. | **Transcript views**, cycled with Ctrl+O: Normal (tool calls collapsed), Thinking, Verbose [18][25]. | Diff pane (Cmd+Shift+D): click a line to comment, Cmd+Enter submits all comments. `/code-review` card with "Fix this one" and "Apply fixes". PR card with CI, Auto-fix and Merge when ready [18]. | Parallel sessions with **worktrees** under `.claude/worktrees` [18]. Scheduled local and cloud tasks with run history [19]. |
| **claude.ai** | n/d | n/d | n/d | Cowork; "parallel cloud threads" in the new Projects beta [23][24]. |
| **ChatGPT + Codex app** | A **goal progress row** above the composer with pause, resume, edit and clear. `/plan` mode [34][35]. | n/d in the app. | Review pane: inline comments, stage or revert by file or hunk, `/review` that can run "Detached", PR review submission [36]. | Worktrees under `$CODEX_HOME/worktrees` (the newest 15 are kept, with a snapshot before deletion). Cloud tasks [30][32]. |
| **DeepSeek Harness** | **Todo dock** above the composer (idle, ongoing and done markers). **GoalBar.** Plan opens in the right sidebar for review [12][14]. | `ui-tool` renders each call through the keyed slot `tool.call.toolview`, with a generic card as fallback. **Trajectory** tab: a turn-aware ledger, a timing overview and a record inspector (tokens, duration, input, output) [9][14]. In-flight rows never invent a duration [9]. | **Changed-files card** at the end of a turn (with line counts) that opens a review tab [14]. File-diff palette tokens [3]. | **Jobs** header control: live jobs with a ticking duration and expandable output; settled jobs folded below [13]. **Subagent** lineage in the header [14]. |
| **OpenCode** | Plan agent [45]. | n/d | Per-turn timeline of changed files with line counts (opt-in, v2.0.30) [44]. The review panel does not update live [46] **[I]**. | Subagent cost rolls up into the session [44]. |
| **Cursor** | Plan Mode writes a markdown plan, editable before build. **Structured to-dos** with dependencies are shown inline [49][52]. | Checkpoints in the timeline [47]. | Live diff during the run; Review → Find Issues; Bugbot [47][53]. | **Cloud agents** in a VM on their own branch, producing screenshots, video and logs, with remote-desktop takeover. Local↔cloud handoff [50][48]. |
| **Zed** | n/d | Streaming tool indicators. Permission cards with "Always for <pattern>" [56][57]. | **Per-hunk accept/reject** in a multibuffer [56]. | ACP external agents (Claude, Codex, OpenCode and others) [58]. |
| **Goose** | Recipes [64] **[I: snippet]**. | Allow/Deny inline on write tools [59]. | n/d | Scheduler page [60]. |
| **Conductor** | **Goal bar** with objective, status, **token budget**, and pause, resume, edit, clear [69]. | n/d | Unified diff with per-commit filtering. **Line comments become composer attachments** [70]. | **One worktree per task**, with a per-workspace port `CONDUCTOR_PORT` [66][68]. |
| **Warp** | **Task list chip**: ● current, ✔ done, ○ not started, ■ cancelled; popup shows "4 of 6" [74]. | Blocks. Inline step-completion markers [74]. | Hunk-by-hunk review: Accept, Refine, Edit [75]. Batched review comments [76]. | **Agent Management Panel** with Working, Blocked, Canceled, Failed and Success, and filters for source, day, creator and status [78]. |
| **LM Studio** | — | — | — | The Developer tab's **server toggle** [84]. |
| **JetBrains / Junie** | Plan mode waits for approval [88]. | A command widget with "Open in editor" [88]. | Click a modified file to see its diff. Revert per file or Rollback all [88]. | n/d |

### 2.3 Terminal, notifications, usage and visual language

| Product | Terminal | Notifications | Context / usage | Density, type, colour, material, motion |
| --- | --- | --- | --- | --- |
| **Claude Code desktop** | Terminal pane (Ctrl+`) with tabs, opened in the session's folder [18]. | An OS notification when a session finishes and is not in view [18]. | The usage ring shows **context (per session) and plan usage (shared across Claude)** [18]. **Keep computer awake** lives in Settings › This computer › System [19]. | n/d |
| **claude.ai** | — | A notice when a session or weekly limit is near, then "Now using credits" [21]. | Settings › Usage [21]. 5-hour and weekly windows [20]. | n/d |
| **ChatGPT + Codex app** | A terminal drawer that the agent can read [37]. | **Activity view** behind a bell (Cmd+Opt+U) with Unread, Running and Waiting, filtered by Work, Chat, Pinned and Scheduled. OS alerts set to never, background only, or always. Floating "Pets" show status [29]. | Remaining Work usage in the sidebar [26]. **"Prevent sleep while running"** (Mac) [35]. | n/d |
| **Codex CLI / IDE** | — | n/d | A rate-limit footer item [33]. | n/d |
| **DeepSeek Harness** | Terminal tab in the right sidebar. Collapsing the sidebar keeps commands running; closing the tab terminates the process [13]. | Toasts [16]. Session completion reminders in `ui-session` [14]. | Context meter in the composer [12]. | **Bluish neutrals, 0.5 px hairlines, superellipse corners, blur(40px) saturate(150%) menus, macOS sidebar vibrancy** — see §3 [2]–[7]. |
| **OpenCode** | Terminal panel [44]. | Unread tab indicators; Option+Shift+↑/↓ jumps to unread [44]. | Context tokens and accumulated cost, including subagents [44]. | n/d |
| **Cursor** | Uses your **native terminal**, with a Focus button to watch and take over [54]. | Slack and iOS [50][55]. | **Context ring**; the tray splits usage into System prompt, Tools, Rules, Skills, MCP, Subagents, Summary and Conversation [51]. "Keep this computer awake" for iOS remote control [55]. | n/d |
| **Zed** | — | Desktop notification and sound when the agent is done or waiting [56]. | Token count next to the profile. "Context Compacted" entry. A banner near the limit [56]. `prevent_idle_sleep` [56]. | n/d |
| **Goose** | — | **Status dots** on sessions: blue spinner (running), green (finished unseen), red (error) [62]. | n/d | Sidebar layout is configurable [60]. |
| **Conductor** | Terminal and **Run button** per workspace [68]. | n/d | Token budget in the goal bar [69]. | n/d |
| **Warp** | Native terminal [73]. | **Toasts** (at most 2), a **mailbox** with All, Unread and Errors, **tab badges**, OS alerts [77]. | A **context indicator** that stays hidden below 20% and turns red near the limit, with "View breakdown" [72]. | n/d |
| **LM Studio** | — | n/d | The **memory estimate before load** updates with context length and GPU offload sliders; a warning appears with an "override guardrails" option (v0.3.27) [83]. | n/d |
| **JetBrains / Junie** | Embedded terminal in the plugin [89]. | n/d | n/d | Follows IDE themes **[I]**. |

**Reading of the tables [I]:**

- Every serious harness now puts the run's **scope controls in the composer**: where it runs, what
  it may do, which model, how full the context is.
- Every harness puts **evidence of work** (diff, checks, terminal, preview) in a side area that can
  be dismissed.
- The leaders differ mainly in two ways:
  - Whether side surfaces are **fixed cards** (Claude's session rail) or a **docking tree**
    (DSH's dockkit, Claude's draggable panes).
  - Whether background work is shown **per session** (DSH Jobs, Claude Tasks) or **across sessions**
    (Codex Activity, Warp Agent Management, Conductor workspaces).

---

## 3. DeepSeek Harness: how the "glacier" look is built

The owner reads the DSH look as "glacier, frosted glass, rough gloss, ice". In the source [1] it
comes from six concrete techniques. None of them is a texture or noise layer: the source has no
`feTurbulence`, grain or noise asset. **[V by search of the clone]**

### 3.1 Native vibrancy behind a thin, tinted sidebar

- **The Electron window is itself translucent [7] [V].** On macOS it uses
  `vibrancy: 'sidebar'`, `visualEffectState: 'active'` and `backgroundColor: '#00000000'`, with
  `titleBarStyle: 'hiddenInset'` and the traffic lights placed at (16, 18).
  - `active` keeps the frost from washing out when the window loses focus.
  - While the window is minimized or hidden, the app swaps in an opaque fill, to work around
    Electron issue #25368.
  - The welcome window uses `vibrancy: 'menu'` on macOS and `backgroundMaterial: 'acrylic'` on
    Windows.
- **The sidebar column paints only a tint over that vibrancy [6] [V]:**
  - The light theme mixes the sidebar token (neutral-bluish-50, `rgb(249,250,251)`) at 97% with
    `rgb(122 155 240)` (periwinkle), then sets the result to 40% opacity.
  - A vertical gradient goes from **`rgb(122 155 240 / 0.10)`** (blue) at the top, fading out by
    35%, to **`rgb(143 137 184 / 0.09)`** (grey-violet) rising at the bottom.
  - The dark theme drops the blue cast (it reads purple over dark fills), uses a 50% fill, and
    keeps the two washes at 0.08 and 0.07.
- **The centre column stays opaque [6] [V].** It uses `--dsw-alias-bg-base`: white in light, and
  `rgb(21,21,23)` in dark. Reading surfaces never sit on glass. The right column also paints the
  opaque base so no glass shows through while panels slide.

### 3.2 Frosted floating surfaces

Menus, popovers, hover cards, the todo dock, the context meter, the queue dock and the goal bar
all use one material [4][2] [V]:

- **Filter:** `--dsw-menu-backdrop-filter: blur(40px) saturate(150%)`. The saturation boost makes
  colours behind the glass glow faintly instead of turning grey.
- **Fill:** `--dsw-menu-surface-fill` is `rgba(248,249,250,0.58)` in light and
  `rgba(67,69,74,0.45)` in dark [3].
- **macOS overlays without an opaque backing** fall back to a 94% fill (`--dsw-specific-menu`), so
  text behind them does not bleed through [3].
- **Modal masks are not blurred** (`--dsw-mask-blur: none`). They use dark masks of 0.24–0.48
  alpha [3][4].
- A theme spec test rejects any feature that overrides the material [2].

### 3.3 Hairlines instead of borders ("rough gloss")

- Elevated surfaces set `border: 0` and draw a **0.5 px stroke as the first box-shadow layer**,
  followed by two very faint glows [4] [V]:

  ```css
  --dsw-elevation-panel: 0 0 0 0.5px <stroke>, 0 3px 8px rgba(0,0,0,.03), 0 0 16px rgba(0,0,0,.02);
  ```

- **Stroke colours** come from an alpha ladder: light `rgba(0,0,0,.04/.10/.12/.16)`, dark
  `rgba(255,255,255,.06/.12/.16/.20)` [3].
- **Dark mode relies on the stroke alone.** The glows are nearly invisible there, so the
  separation comes from the edge. This is the main source of the "ice edge" feel. **[I]**
- **Flat dividers are also 0.5 px**, which Chromium paints as one device pixel. A spec test
  rejects wider neutral borders [2].

### 3.4 Superellipse corners

- **Radius scale:** 4, 8, 12, 16, 20 and 28 px (panel) [5].
- **Corner shape:** on supporting engines every element gets `corner-shape: superellipse(1.5)`,
  which sits between a circle and a squircle [5] [V].
- Full-round shapes opt back into `round`, and a spec test enforces that pairing [2].
- The result is "soft-cut ice" rather than plain rounded rectangles. **[I]**

### 3.5 Cold palette

- **Neutrals are "neutral-bluish":**
  - backgrounds: `rgb(249,250,251)` (light) and `rgb(21,21,23)` (dark);
  - layers: `rgb(35,35,36)`, `rgb(44,44,46)` and `rgb(53,54,56)` [3].
- **The light brand primary is near-black bluish** `rgb(15,17,21)`; the dark one is near-white [3].
- **The accent is a "deepseek" blue ramp** around `rgb(65,118,230)`. Focus rings are `#4176E6`
  (light) and `#7AAAFF` (dark) [3][16].
- **Hover layers in light mode carry a blue-slate tint** (`rgba(38,49,72,0.06)`), not grey [3].
- **Shimmer** for activity labels: black at 30% in light, white at 45% in dark, plus a blue
  "deep-diving" sweep [16].

### 3.6 Quiet motion

- **Timing:** one curve, `cubic-bezier(0.4,0,0.2,1)`, with durations of 100, 200 and 300 ms [5]
  [V].
- **Layout motion:** the frame's column-grid change and the panel `translateX` ride the same curve
  [6].
- **Reduced motion:** 46 CSS modules handle `prefers-reduced-motion`. Only AppFrame handles
  `prefers-reduced-transparency`, where it swaps the thin tint for a **90%-opaque fill** [6] [V].
- **The onboarding card** is the one decorative piece [17]:
  - `backdrop-filter: blur(32.6px)` with a 32 px radius;
  - an accent-tinted shadow;
  - a **conic-gradient border masked to a 2 px ring** whose angle animates.

### 3.7 What Guanxi should take from this, and what it must not copy

- **Take the recipe.** It is generic technique: vibrancy only on the navigation layer, an opaque
  reading layer, one frosted material token for floating surfaces, hairline-in-shadow elevation,
  superellipse corners, a reduced-transparency fallback. The code is MIT [1].
- **Do not copy the identity.** That means:
  - the `deepseek-*` blue ramp and its exact values;
  - the Montserrat brand wordmark styling;
  - the specific periwinkle and violet sidebar washes;
  - the conic onboarding ring;
  - and anything that, together, reads as DeepSeek Harness.
- **Why not:** DSH's brand guidelines say not to use the "DeepSeek Harness" mark or official brand
  materials in ways that suggest endorsement [15] [V]. Guanxi also has its own logo (D-126) and
  needs a palette of its own. **[I]**
- **The proposed Guanxi variant [I]:**
  - **Hue:** derive the hue from the `guanxi-gx-v1` logo, not from blue.
  - **Expose the material as tokens** in DTCG: `material.glass.fill`, `material.glass.blur`,
    `material.glass.saturate`, `material.glass.fallback`.
  - **Optional grain:** if the owner wants "rough" rather than "gloss", add a 2–3% SVG noise layer
    as a theme-plugin option. DSH does not do this.

---

## 4. The owner's wishes against the products

| Owner wish | Closest precedent | Gap and Guanxi direction |
| --- | --- | --- |
| **Minimal entry screen** (logo, project, prompt, access mode, model, mic, paperclip) with more settings and filters | Claude Code row: environment, folder with worktree, mode, model with ring [18]. Codex: Local/Worktree/Cloud plus branch [30]. Warp's toolbelt can be reordered and hidden [73]. Goose's welcome screen [61]. | Keep REQ-D2's seven elements visible. Put the rest (node/machine, worktree, role routing, effort, budget, run policy) behind **one "Run options" disclosure** whose chips show only non-default values (Warp-style toolbelt editing) **[I]**. |
| **Right drawer of small, customizable blocks** | Claude's session rail cards [18]. DSH dockkit tabs and splits [8]. Goose's configurable sidebar [60]. | Combine them: a **rail of blocks** (a `list` slot) where each block can **expand into a docked pane** (a `keyed` slot). Users can reorder, hide, pin and save layouts per project **[I]**. |
| **Files panel with several formats** | DSH Files tab plus document preview with renderer choice [13]. Claude's file pane [18]. | Tree, flat list, changed-only and by-type views; open in the Guanxi viewer or an external editor **[I]**. |
| **Side chats** | Claude `/btw` [18], Cursor `/side` [47], Codex `/side` [34]. | Read-only access to the parent, writes nothing back by default, with an explicit "send to main" action **[I]**. |
| **Background tasks** | DSH Jobs [13], Claude Tasks pane [18], Codex Activity [29], Warp Agent Management [78]. | One **Activity** list across sessions and machines, built from durable runs (ADR-0019) **[I]**. |
| **Keep-computer-awake toggle** | Claude [19], Codex [35], Zed [56], Cursor [55]. | Per-machine, and shown as a held state, with the same caveat Claude states: a closed lid still sleeps [19]. |
| **Battery and energy use** | None found. | **New.** Show per machine, from node metrics (ADR-0031). Attribute to an agent only with a confidence level (REQ-N1) **[I]**. |
| **htop-like per-agent process view** | DSH Jobs [13] and Warp's child pills [78] are the nearest. Nobody shows containers or browsers. | **New.** A process tree per run: shell processes, Docker containers, browser sessions, dev servers, ports, plus CPU, RAM and GPU, with Open and Finished tabs **[I]**. |
| **Integrated terminal** | Claude [18], Codex [37], DSH [13], Conductor [68]. | Terminal block and pane. Keep processes alive when the pane collapses (DSH behaviour) [13]. |
| **Notification center** | Codex Activity [29], Warp mailbox [77]. | ADR-0033 inbox: a bell, filters and typed actions. |
| **Work board** | Warp task chip [74], Cursor to-dos [52], Conductor Checks [71]. None has a board with derived status. | ADR-0032 board as a projection, plus a 300-token strip in the session **[I]**. |
| **Models section** | LM Studio Discover with load guardrails [82][83]. | REQ-G1/G3 workbench with fit estimates that carry provenance. |
| **Settings with a far-away developer area and live component catalogue** | DSH's ui-primitives catalogue (in its docs) [11]. Storybook in OpenCode's packages [42]. | Settings › **Developer** as the last item, hidden until Developer mode is turned on (as in LM Studio's User/Developer split [80]). It hosts the live catalogue rendered from the tokens **[I]**. |

---

## 5. Consolidated screen inventory for Guanxi

This whole section is a proposal **[I]**. It is grounded in sections 2–4 and in REQ-D/F/G/J.

### 5.1 State vocabulary

Every surface below declares these states. Write them as design-system primitives once, then reuse
them everywhere.

| State | Rule |
| --- | --- |
| **empty** | One sentence plus one primary action. Never a blank panel. |
| **loading** | A skeleton with the final geometry. Spinners only for operations under about 2 s. |
| **streaming** | A live marker. Follow the tail until the user scrolls up (DSH Trajectory behaviour [9]). Never invent an elapsed time or percentage. |
| **error** | What failed, the source, the time, and the next action. Copyable detail. |
| **offline / unreachable** | Last known data with an age ("as of 14:02, 6 min ago") and the named state from REQ-N3 (`home_unreachable`, `node_unreachable`, `judge_unavailable`). Actions that need the network are disabled with a reason. |
| **unknown** | REQ-N1: "unknown" with the source that would answer it, instead of a guess. |
| **degraded** (where relevant) | Partial data with a list of what is missing. |

### 5.2 Global shell

| ID | Surface | Purpose | Contents | States and notes |
| --- | --- | --- | --- | --- |
| S1 | **Left sidebar** (`list` slot, REQ-F3) | Navigation | New, Projects, Models, Settings, then plugin entries. Below them, the session list: grouping by project, state or date; status dots for running, waiting, finished-unseen and error; pinned items. Collapses to a rail. | **empty:** "No sessions yet". **offline:** a dot on the machine badge. Plugins add entries but never reorder the core four. |
| S2 | **Title / status strip** | Global glanceable state | Machine selector (fleet), quota mini-meter (the worst window), **keep-awake indicator**, power source and battery, notification bell with unread count, command palette trigger. | **offline:** the machine chip shows `unreachable` with its age. **unknown:** battery on a desktop is hidden, not shown as "0%". |
| S3 | **Notification center** (overlay, ADR-0033) | One inbox | Rows with kind, severity, subject, facts with provenance, and typed actions. Filters: Unread, Running, Waiting for you, Quota, Errors, by project. Snooze. | **empty:** "All caught up". **streaming:** new rows animate in, and only when motion is allowed. **offline:** shows the queued local rows. |
| S4 | **Command palette** | Keyboard reach | Sessions, commands, models, settings, blocks. | **loading:** results stream in by source. |
| S5 | **Toasts** | Transient events | At most two at once; pause on hover; click to jump (Warp pattern [77]). | Always mirrored into S3, so nothing is lost. |

### 5.3 New session (entry) and session workspace

**E1 — New session / empty session (REQ-D2)**

- **Purpose:** start work with minimum friction.
- **Contents:**
  - the logo;
  - the project picker (including projects without a folder);
  - the prompt box;
  - access mode (Full access or Read-only);
  - the model picker (single model or role preset);
  - the mic and the paperclip;
  - a **"Run options"** disclosure for machine/node, worktree on or off, branch, effort, budget,
    judge and ledger mode;
  - chips for any value that is not the default;
  - an optional strip of recent projects and suggested prompts.
- **States:**
  - **loading:** the model list is a skeleton, but the prompt box is usable at once.
  - **offline:** only local models are offered; remote ones are greyed out with a reason.
  - **error:** a connection health chip on the model.
  - The composer adapts to modality (REQ-G2).

**W1 — Session workspace**

- **Purpose:** the main working view.
- **Contents:**
  - a header (title, project, machine, a view toggle Chat | Trace | Board-strip, share, the
    **child-agent pill bar**);
  - the transcript;
  - **dock lanes above the composer**: goal bar, ledger strip (current item, next item, blockers),
    prompt queue, steering;
  - the composer with a **context ring** that opens a breakdown.
- **States:**
  - **streaming:** live tool rows.
  - **reconnecting:** a banner explains that the run continues on node X (REQ-N2).
  - **interrupted:** "Run stopped at 12:31 when node Y restarted" with Resume and Inspect.

**W2 — Transcript renderers**

- **Purpose:** messages and tool calls.
- **Contents:**
  - tool rows collapsed by default, with three views (Normal, Thinking, Verbose — the Claude
    pattern [18]);
  - renderers keyed by tool name or MIME type (ADR-0022);
  - compaction and handoff markers as first-class rows.
- **States:**
  - **error:** the row shows its error code and a retry policy.
  - **unknown duration:** a start marker only.

**W3 — Trace / inspector (REQ-D6, REQ-J1)**

- **Purpose:** lossless audit of the run.
- **Contents:** a turn-aware ledger and timing overview (DSH Trajectory model [9]) with a record
  inspector: tokens, cost, duration, input, output, connection, machine.
- **States:**
  - **loading:** older pages load on demand.
  - **reasoning hidden:** shown with a reason ("remote model: not stored").

**W4 — Side chat**

- **Purpose:** ask without disturbing the main thread.
- **Contents:** a small floating or pane chat that reads the parent; "Send to main" is explicit.
- **States:** **empty:** "Ask about this session". By default it is ephemeral, and that is labelled.

### 5.4 Right drawer: blocks and panes

**How the drawer works.** Each **block** is a compact card in the right rail (a `list` slot). Any
block expands into a full **pane** in the dock (a `keyed` slot with dockkit-style split and tab
operations [8]). Users can:

- reorder, hide and pin blocks;
- choose the density (compact or comfortable);
- save a layout per project.

Each block is listed below with its pane and its states.

**B1 — Context usage**

- **Block:** a ring with %, the window size and the source of the limit.
- **Pane:** a breakdown by category (system, tools, skills, MCP, history, attachments — the
  Cursor and Warp pattern [51][72]); compaction and handoff history.
- **States:**
  - **unknown:** when the model does not report a window.
  - **streaming:** updates per step.

**B2 — Quota and cost**

- **Block:** the worst window (5-hour, weekly, balance) and the run's cost so far.
- **Pane:** all connections, with forecasts (ADR-0033).
- **States:**
  - **estimated:** a badge when Guanxi meters locally.
  - **offline:** shows the age of the last observation.

**B3 — Plan / ledger**

- **Block:** the current item, "4 of 9", and blockers.
- **Pane:** the run ledger with acceptance commands, evidence links and derived status
  (ADR-0032).
- **States:**
  - **empty:** "No ledger (mode off)", with a toggle.
  - An item claimed done without evidence shows **"verification requested"**.

**B4 — Changes / diff**

- **Block:** files changed with +/−.
- **Pane:**
  - scopes: uncommitted, branch, last turn, commit (the Codex pattern [36]);
  - line comments sent back as one batch;
  - per-hunk stage and revert;
  - PR and CI checks (the Conductor Checks pattern [71]).
- **States:**
  - **empty:** "No changes".
  - **error:** shown when git is unavailable.
  - **live:** updates during the run (avoid OpenCode's stale panel [46]).

**B5 — Files**

- **Block:** worktree root and the count of changed files.
- **Pane:**
  - **views:** tree, flat search, changed-only, by type, and a *worktree compare* (base vs
    branch);
  - opens files in the viewer (code, Markdown, PDF, image, media) or an external editor.
- **States:**
  - **empty:** "Project has no folder" (REQ-D1).
  - **offline:** remote worktree shows cached tree with its age.

**B6 — Terminal**

- **Block:** the open terminals, plus a running/exit badge.
- **Pane:** a tabbed terminal in the session folder on the chosen machine; collapsing the pane
  keeps processes running.
- **States:**
  - **ended:** shows the exit code.
  - **unreachable:** for a remote node.

**B7 — Processes ("htop" per agent)**

- **Block:** "3 containers · 1 browser · 2 shells", with CPU and RAM sparkline.
- **Pane:**
  - a process tree per agent and sub-agent: shell processes, Docker containers, browser and
    computer-use sessions, dev servers with ports, leases (ADR-0018);
  - CPU, RAM, GPU/VRAM and network columns;
  - **Open / Finished** tabs;
  - Stop, Kill and Open (logs, URL) actions.
- **States:**
  - **unknown:** for processes that cannot be attributed.
  - **degraded:** when the container runtime cannot be reached (Colima stopped).

**B8 — Connectors / tools**

- **Block:** active MCP servers, skills and tools, with their health.
- **Pane:** a per-project enable/disable list, a tool budget, and the sandbox profile
  (ADR-0022 §9).
- **States:**
  - **off by default**, and labelled as such.
  - **error:** a health check failure with its last check time.

**B9 — Outputs / artifacts**

- **Block:** files produced, images and reports.
- **Pane:** a gallery and list with preview (REQ-G4) and "open in folder".
- **States:** **empty:** "Nothing produced yet".

**B10 — Environment**

- **Block:** machine, OS, runtime, branch, worktree path and access mode.
- **Pane:** node metrics, leases, ports, the **keep-awake hold**, power source and battery
  (REQ-B4).
- **States:** **offline:** `node_unreachable`.

**B11 — Browser / preview**

- **Block:** the dev-server URL.
- **Pane:** an embedded browser for loopback pages (DSH and Claude pattern [13][18]).
- **States:** **error:** connection refused, with the port lease owner.

**B12 — Sub-agents**

- **Block:** child agents and their states.
- **Pane:** a lineage tree with the role, model, machine, cost and handoff count of each child.
- **States:** **hibernating:** the lead shows "asleep, wakes on …".

### 5.5 Project-level and global screens

| ID | Screen | Purpose | Contents | States |
| --- | --- | --- | --- | --- |
| P1 | **Projects** | List and settings | Cards or a list, each with the project's folder or a "no folder" label, default models and roles, run policy, glossary, linked tracker. | **empty:** "Create a project". |
| P2 | **Board** (ADR-0032) | Work graph projection | Columns by derived status, a dependency view, evidence links, a WIP indicator derived from real capacity, the tracker link. | **mode off:** explains how to enable it. **sync error:** shows the tracker's last poll. |
| P3 | **Activity / background** | Every run across sessions and machines | Rows with run, role, machine, status (working, waiting, hibernating, blocked, failed, done), ETA with confidence (REQ-C8), cost. Filters as in Warp [78]. | **streaming:** live. **offline nodes:** the last state, with its age. |
| P4 | **Fleet / machines** | Where work can go | Per-machine cards: CPU, RAM, GPU, disk, power and battery, keep-awake, sessions, containers, leases. | **unreachable** state with its age. **unknown** metrics. |
| M1 | **Models** (REQ-G1) | Catalogue, downloads, local runtimes | Search by modality; fit estimate with source and confidence (the LM Studio pre-load estimate pattern [83]); download progress with bytes, speed, ETA and resume; loaded models per machine. | **offline catalogue:** cached results, with their age. **download error:** resumable. |
| M2 | **Model workbench** (REQ-G2/G3) | Parameters and media | Every parameter with recommended values; a preview and editor for media outputs. | **unsupported modality:** explained. |
| C1 | **Connections** | Keys, subscriptions, services | Health, balance, windows, and limits with provenance; secrets shown only as references. | **estimated** badge. **error:** an auth failure, with a re-auth action. |
| T1 | **Settings** | Preferences | General, Appearance (theme, density, transparency, motion), Voice and glossary, Notifications (channels, quiet hours), Machines, Accounts, Plugins, **Developer** (last). | — |
| T2 | **Developer area** | Building and debugging Guanxi | Live component catalogue rendered from the DTCG tokens, with each primitive in every state from §5.1, light, dark, increased contrast and reduced transparency; token inspector; slot map (who owns which slot); plugin inspector; event-log tail; feature flags. | Hidden until Developer mode is on. The catalogue doubles as the visual-snapshot source for the ADR-0022 gate. |

---

## 6. Interaction principles

Each principle cites its evidence. The principles themselves are recommendations **[I]**.

1. **Scope lives in the composer.**
   - Show where the run executes, what it may touch, which model it uses and how full the context
     is, right where the prompt is typed. Show only non-default values as chips.
   - Evidence: Claude's environment, folder, mode, model and ring row [18]; Codex's
     Local/Worktree/Cloud and permission control [30][31]; Warp's toolbelt [73].
2. **Reading surfaces are opaque; glass belongs to navigation and floating controls.**
   - Evidence: Apple HIG — Liquid Glass is a layer for controls and navigation, not content [90];
     DSH keeps the centre opaque over a vibrant sidebar [6].
3. **Every number carries a source and an age.**
   - Context, quota, balance, ETA, fit and battery all show provenance; "unknown" beats a guess.
   - Evidence: REQ-N1; DSH never invents in-flight durations [9]; LM Studio labels its memory
     figure as an *estimate* [83].
4. **Queue and steer are distinct actions.**
   - Enter queues; an explicit "send now" steers at the next tool boundary; the queue is visible
     and editable.
   - Evidence: Cursor [47], Zed [56], Warp [72], DSH QueueDock [12].
5. **Status comes from the harness, not from the agent.**
   - Plan and board items move only on evidence; the agent's "done" becomes "verification
     requested".
   - Evidence: ADR-0032; Conductor's Checks block merging on failing checks or open todos [71].
6. **Small first, deep on demand.**
   - Blocks summarize; panes explain; the Trace inspects. Each level is one click from the
     previous one.
   - Evidence: Claude's cards opening into panes [18]; Cursor's ring opening a tray [51]; Warp's
     chip opening a popup [74].
7. **Review is a conversation.**
   - Line comments on a diff are batched and returned to the agent as one message, and the
     result is a fresh diff.
   - Evidence: Claude [18], Conductor [70], Warp [76], Codex [36].
8. **Attention is centralized and actionable.**
   - One inbox, typed actions, status dots on rows, OS alerts only when the app is in the
     background, at most two toasts.
   - Evidence: Codex Activity [29], Warp [77], Goose status dots [62], ADR-0033.
9. **Closing a view never stops work.**
   - Collapsing the terminal or drawer, closing the window or sleeping the laptop are visible
     states, not side effects.
   - Evidence: DSH terminal survives a collapsed sidebar [13]; Claude's keep-awake caveat
     (a closed lid still sleeps) [19]; REQ-N2.
10. **Parallel work is isolated and named.**
    - Every background run shows its worktree or branch, machine and ports.
    - Evidence: Conductor's worktree with `CONDUCTOR_PORT` [66][68]; Codex's worktree snapshot
      before deletion [30]; REQ-H6.
11. **Side questions do not pollute the main context.**
    - Side chats read the parent and write nothing unless told to.
    - Evidence: Claude `/btw` [18], Cursor `/side` [47], Codex `/side` [34].
12. **Layouts are user-owned, but core navigation is fixed.**
    - Blocks and panes are reorderable and saved per project; plugins add and never rearrange.
    - Evidence: Goose's sidebar options [60], Warp's toolbelt editing [73], DSH's slot ownership
      rule [10], REQ-F3.
13. **Motion confirms and never informs alone.**
    - Use a single 100–300 ms curve; respect Reduce Motion; never animate blur in or out.
    - Evidence: Apple HIG Motion and Accessibility [92][93]; DSH's single curve [5]; WCAG 2.3.3
      [102].
14. **Expert depth hides behind a mode, not behind clutter.**
    - A developer area and a Developer mode keep the default UI simple.
    - Evidence: LM Studio's User/Developer modes [80]; VISION principle 8.
15. **Destructive or irreversible actions say what they discard.**
    - Evidence: Claude warns before discarding worktree changes [18]; Codex snapshots worktrees
      before deletion [30].
    - Guanxi has no approval prompts (D-118), so this applies to the *user's* destructive actions,
      not the agent's.

---

## 7. What to borrow and what to avoid

### 7.1 Borrow

| From | What | Why |
| --- | --- | --- |
| **DSH** | The slot model (`single`, `list`, `keyed`, `chain`) [10]; a dockkit-like right sidebar with normal and fullscreen presentations [8]; Trajectory ledger and inspector [9]; the Jobs control [13]; the material recipe from §3; spec tests that enforce styling rules (no material overrides, hairline-only neutral borders, paired corner shapes) [2] | MIT licensed [1]; it already solves plugin-owned UI regions, and its lint-by-test style matches ADR-0022's gate. |
| **Claude Code desktop** | The composer control row; three transcript views; diff line comments with batch submit; the session rail of cards; pop-out panes; the keep-awake wording [18][19] | It is the owner's reference for the entry screen. |
| **Codex** | Diff review scopes; worktree snapshot before deletion; the Activity inbox with filters; OS alert policy (never, background only, always) [29][30][36] | These map directly onto ADR-0033 and REQ-H6. |
| **Cursor / Warp** | A context ring with a categorized breakdown, hidden below 20% (Warp) [51][72]; the task chip [74]; the cloud and local agent management panel with filters [78] | These solve "how full, what is doing what" without clutter. |
| **Conductor** | Checks tab with a suggested next action; line comments as composer attachments; a goal bar with a token budget [69][70][71] | It turns review and merge readiness into one place. |
| **Zed** | Per-hunk accept/reject; the follow-agent toggle; a compaction marker as a transcript entry [56] | Precise review and transparency about context. |
| **Goose** | Session status dots; a configurable sidebar position and style [60][62] | A cheap, high-signal pattern for seeing background work. |
| **LM Studio** | Pre-load memory estimate with explicit override; User/Developer split [80][83] | Matches REQ-G3 (no hidden caps, but warnings) and the developer area. |

### 7.2 Avoid

| Anti-pattern | Seen in | Why |
| --- | --- | --- |
| **Cloning DSH's identity**: the deepseek blue ramp, Montserrat wordmark styling, exact sidebar washes, conic onboarding ring | DSH [3][6][17] | DSH's brand guidelines ask projects not to imply endorsement [15]; Guanxi has its own logo (D-126); a copied look would make Guanxi read as a DSH distribution, which D-108 rejects. |
| **Review panels that update only at turn end**, and panels unavailable before the first message | OpenCode [46] **[I]** | Breaks principle 9 and hides live evidence. |
| **Agent-maintained checklists presented as truth** | Most todo UIs [52][74] | ADR-0032: drift and false "done" claims. |
| **Glass on reading surfaces**, or glass stacked on glass | Warned against by Apple [90][94] | Legibility and performance. |
| **Blurred modal masks** | DSH explicitly avoids them [2] | Cost and legibility; a plain dim mask is clearer. |
| **Approval cards and permission dialogs in the default flow** | Zed [57], Goose [59], Junie [88] | D-118: Guanxi has exactly two access modes and no approval prompts. Use `input_required` escalations instead. |
| **Hidden caps disguised as UI limits** (fixed context sliders, maximum media size) | — | REQ-G3 and VISION principle 5. |
| **Notification sprawl** across Slack, email and SMS by default | Codex web [29], Cursor [55] | D-125 limits channels to in-app, OS and push. |
| **Cost and usage shown without a source** | claude.ai's progress bars are documented only in third-party guides [20] **[I]** | REQ-N1. |

---

## 8. Accessibility for translucent materials

### 8.1 Platform rules **[V]**

- **Apple HIG Materials [90]:**
  - Use Liquid Glass **regular** for text-heavy surfaces such as sidebars, alerts and popovers.
  - Use **clear** only over rich media, with a **35% dark dimming layer** when the content behind
    is bright.
  - Use **scroll-edge effects** to keep bars legible.
  - Glass appearance responds to the user's Liquid Glass preference, **Reduce Transparency** and
    **Increase Contrast**.
- **Apple HIG Color [91]:**
  - Glass has no colour of its own; tint it sparingly, for emphasis only.
  - Ship light, dark and **increased-contrast** variants even if the app has only one appearance.
- **Apple HIG Accessibility [92]:**
  - Contrast of 4.5:1 up to 17 pt, and 3:1 at 18 pt or bold.
  - Under Reduce Motion, replace movement with fades and **avoid animating into and out of blurs**.
- **Adopting Liquid Glass [94]:**
  - Don't stack glass on glass.
  - Use concentric corners.
  - Test with Reduce Transparency and Reduce Motion.
- **The 26.1 "Clear / Tinted" appearance choice [97]:** reported only by secondary sources **[I]**.
  The HIG confirms that a "preferred Liquid Glass look" setting exists [90].
- **WCAG 2.2:**
  - **1.4.3** text contrast is measured against the background in normal use [100].
  - **1.4.11** asks for 3:1 for UI component boundaries and states. For gradients, test the least
    contrasting area [101].
  - **2.3.3** asks that motion triggered by interaction can be disabled. Animated blur counts after
    the errata [102].
- **CSS support [98][99]:**
  - `prefers-reduced-transparency`: Chromium 118+; Firefox behind a flag; **not in Safari**.
  - `prefers-contrast`, `prefers-reduced-motion` and `forced-colors` are widely supported.
- **Electron [103][104]:**
  - On macOS, `vibrancy` (with types such as `sidebar`, `menu`, `popover`, `under-window`) plus
    `visualEffectState`.
  - On Windows 11 22H2+, `backgroundMaterial` (`mica`, `acrylic`, `tabbed`).
  - No Electron API for macOS 26's Liquid Glass view was found, so Electron vibrancy is the older
    NSVisualEffectView material **[I]**.

### 8.2 Rules for Guanxi **[I]**

1. **Opaque reading layer.** Transcript, diff, code, terminal and tables never sit on glass. Glass
   is allowed only on the sidebar, title strip, menus, popovers, the toast stack and docks above
   the composer.
2. **Contrast is tested against the worst case.**
   - Measure text on glass against both a white and a black backdrop behind the material (and a
     saturated test wallpaper).
   - Require 4.5:1 for body text and 3:1 for hairline component boundaries in both cases.
   - Where 0.5 px hairlines fail 1.4.11, a state change must also carry a fill, icon or text
     change.
3. **Three transparency levels in Settings › Appearance:** *Glass* (default), *Tinted* (fill at
   about 85–90%), *Solid*.
   - Map OS Reduce Transparency to *Solid* automatically.
   - Electron's renderer cannot rely on `prefers-reduced-transparency` everywhere: Chromium has
     it, but a Safari-based PWA does not. So the desktop shell should also read the OS setting
     natively and set a `data-transparency` attribute, as DSH does for the platform [6].
4. **Increase Contrast.** Map `prefers-contrast: more` and the OS setting to a high-contrast token
   set:
   - 1 px borders instead of 0.5 px;
   - a stronger stroke ladder;
   - no saturation boost;
   - a solid material.
   - In `forced-colors`, drop the material entirely and use system colours.
5. **Reduce Motion.**
   - Only the single curve is used.
   - Panel slides become fades.
   - No shimmer sweeps, no animated conic borders, no blur transitions.
   - Status is never conveyed only by motion (a spinner always has a text label or a dot colour
     plus a shape).
6. **Performance budget.**
   - Limit concurrent `backdrop-filter` surfaces (for example at most three on screen).
   - Fall back to the Tinted level on battery power or when the GPU is busy.
   - These numbers are to be measured in stage U1 (REQ-L2), not assumed.
7. **Every material is a token.** Glass fill, blur, saturate and stroke, and the fallback fill,
   are DTCG tokens (ADR-0022), so the developer catalogue (T2) can render each component under
   all four regimes (default, reduced transparency, increased contrast, forced colours) as
   snapshot tests.

---

## 9. Open questions for the owner

1. **Glass intensity.** Should the default be DSH-like (vibrant sidebar, frosted menus, opaque
   content), or more Liquid-Glass-like with glass toolbars over content? Should a "rough" grain
   layer be added, and how strong?
2. **Accent hue.** Should the palette come from the `guanxi-gx-v1` logo, or does the owner want a
   specific cold hue that is clearly *not* DSH blue?
3. **Right drawer default.** Which blocks are on by default? The proposal is Context, Changes,
   Plan/ledger, Processes and Environment, with the rest one click away. Should layouts be per
   project, or global?
4. **Process view scope.** Should Kill/Stop on containers and processes be allowed from the UI
   inside Full access only, or also in Read-only?
5. **Energy.** Is per-machine power and battery enough, or is per-agent attribution with an
   explicit confidence wanted (it will often be "estimated")?
6. **Side chats.** Should they be ephemeral (Claude's behaviour) or saved in the event log?
7. **Notifications.** Should toasts appear while the app is focused, or only the badge and inbox?
8. **Developer area access.** Hidden behind a toggle, or always visible as the last Settings item?

---

## Sources

All accessed **2026-10-20**. Each source is tagged as one of:

- **[primary]** — official docs, a changelog, a repository or guidelines;
- **[clone]** — read from the DSH clone at commit `687f282` (2026-10-17);
- **[snippet]** — seen only in a search result summary;
- **[secondary]** — a third-party report.

### DeepSeek Harness

1. deepseek-ai/deepseek-harness repository, MIT, commit `687f282`. https://github.com/deepseek-ai/deepseek-harness [primary, clone]
2. DSH `docs/web-styling.md` (component rules, material, hairlines, masks). https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/web-styling.md [clone]
3. DSH `packages/client/ui-theme/src/styles/design-platform.css` (static palette, alias tokens, menu fill, diff palette). https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-theme/src/styles/design-platform.css [clone]
4. DSH `ui-theme/src/styles/gradient-shadow-text.css` (elevation, backdrop filter, typography scale). https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-theme/src/styles/gradient-shadow-text.css [clone]
5. DSH `ui-theme/src/styles/base.css` and `corner-shape.css` (radius scale, easing and durations, superellipse). https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-theme/src/styles [clone]
6. DSH `packages/client/ui-layout/src/client/AppFrame.module.css` (vibrancy tint, washes, reduced-transparency fallback, opaque centre). https://github.com/deepseek-ai/deepseek-harness/blob/main/packages/client/ui-layout/src/client/AppFrame.module.css [clone]
7. DSH `apps/desktop/src/main.ts` and `welcome-window.ts` (Electron vibrancy, `visualEffectState`, acrylic). https://github.com/deepseek-ai/deepseek-harness/tree/main/apps/desktop/src [clone]
8. DSH `packages/client/ui-sidebar-right/README.md` and `ui-dockkit/README.md`. https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-sidebar-right [clone]
9. DSH `packages/client/ui-trajectory/README.md`. https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-trajectory [clone]
10. DSH `packages/client/ui-slots/README.md`. https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-slots [clone]
11. DSH `packages/client/ui-primitives/README.md` (component catalogue, renderers). https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-primitives [clone]
12. DSH `packages/client/ui-conversation/README.md` (composer, QueueDock, Todo dock, context meter). https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-conversation [clone]
13. DSH READMEs for `ui-jobs`, `ui-sidebar-files`, `ui-sidebar-terminal`, `ui-sidebar-browser` and `ui-sidebar-documentpreview`. https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client [clone]
14. DSH READMEs for `ui-permission-presets`, `ui-model-selection`, `ui-plan`, `ui-goal`, `ui-deliverables`, `ui-subagent`, `ui-tool`, `ui-schedule`, `ui-sidebar`, `ui-session` and `ui-layout`. https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client [clone]
15. DSH `BRAND_GUIDELINES.md`. https://github.com/deepseek-ai/deepseek-harness/blob/main/BRAND_GUIDELINES.md [clone]
16. DSH `packages/client/ui-theme/README.md` (focus ring, shimmer, toast tokens, Montserrat). https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-theme [clone]
17. DSH `packages/client/ui-settings-account/src/client/DesktopOnboarding.module.css`. https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/ui-settings-account [clone]

### Claude

18. Claude Code Desktop docs. https://code.claude.com/docs/en/desktop [primary]
19. Claude Code Desktop scheduled tasks (Scheduled page, keep computer awake). https://code.claude.com/docs/en/desktop-scheduled-tasks [primary]
20. Understanding usage and length limits. https://support.claude.com/en/articles/11647753-understanding-usage-and-length-limits [primary]
21. Extra usage for paid Claude plans. https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans [primary]
22. What are artifacts. https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them [primary]
23. What are projects. https://support.claude.com/en/articles/9517075-what-are-projects [primary]
24. Claude release notes. https://support.claude.com/en/articles/12138966-release-notes [primary]
25. Claude Code desktop session-control tool surface, observed first-hand by this agent on 2026-10-20: pane types diff, file, terminal, pr, tasks, plan, preview and artifact; transcript views normal, thinking and verbose; keep-awake hold; sidebar group_by and sections; split and pop-out windows. Not a public document.

### OpenAI (ChatGPT and Codex)

`developers.openai.com/codex/*` now redirects to `learn.chatgpt.com/docs/*`.

26. What's new. https://learn.chatgpt.com/docs/whats-new.md [primary]
27. App. https://learn.chatgpt.com/docs/app [primary]
28. Projects. https://learn.chatgpt.com/docs/projects.md [primary]
29. Notifications (Activity view, OS alerts, Pets). https://learn.chatgpt.com/docs/notifications.md [primary]
30. Git worktrees. https://learn.chatgpt.com/docs/environments/git-worktrees.md [primary]
31. Permission modes. https://learn.chatgpt.com/docs/permission-modes.md [primary]
32. Cloud. https://learn.chatgpt.com/docs/cloud.md [primary]
33. Codex changelog (first ~100k characters read). https://learn.chatgpt.com/docs/changelog [primary]
34. Developer commands (CLI). https://learn.chatgpt.com/docs/developer-commands.md?surface=cli [primary]
35. Long-running work (goal row, prevent sleep). https://learn.chatgpt.com/docs/long-running-work.md [primary]
36. Code review. https://learn.chatgpt.com/docs/code-review.md [primary]
37. Integrated terminal. https://learn.chatgpt.com/docs/integrated-terminal.md [primary]
38. IDE extension. https://learn.chatgpt.com/docs/codex/ide.md [primary]
39. openai/codex repository. https://github.com/openai/codex [primary]

### OpenCode

40. anomalyco/opencode repository. https://github.com/anomalyco/opencode [primary]
41. Download. https://opencode.ai/download [primary]
42. Packages tree. https://github.com/anomalyco/opencode/tree/dev/packages [primary]
43. Web docs. https://opencode.ai/docs/web/ [primary]
44. Changelog (v2.0.27–v2.1.0). https://opencode.ai/changelog [primary]
45. Docs. https://opencode.ai/docs/ [primary]
46. Issue #52348, review panel not live. https://github.com/anomalyco/opencode/issues/52348 [snippet]

### Cursor

47. Agent overview. https://cursor.com/docs/agent/overview [primary]
48. Agents Window. https://cursor.com/docs/agent/agents-window [primary]
49. Planning. https://cursor.com/docs/agent/planning [primary]
50. Cloud agent. https://cursor.com/docs/cloud-agent [primary]
51. Prompting (context ring and breakdown). https://cursor.com/docs/agent/prompting [primary]
52. Changelog 1.2 (to-dos). https://cursor.com/changelog/1-2 [primary]
53. Review. https://cursor.com/docs/agent/review [primary]
54. Changelog 1.3 (native terminal). https://cursor.com/changelog/1-3 [primary]
55. Changelog (Projects, iOS remote with keep awake, Canvases). https://cursor.com/changelog [primary]

### Zed

56. Agent panel. https://zed.dev/docs/ai/agent-panel [primary]
57. Tool permissions. https://zed.dev/docs/ai/tool-permissions [primary]
58. External agents (ACP). https://zed.dev/docs/ai/external-agents [primary]

### Goose

The block.github.io/goose docs moved to goose-docs.ai.

59. Goose permissions (GitHub markdown). https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/managing-tools/goose-permissions.md [primary]
60. Desktop navigation. https://goose-docs.ai/docs/guides/desktop-navigation/ [primary]
61. Quickstart. https://goose-docs.ai/docs/quickstart/ [primary]
62. Session management. https://goose-docs.ai/docs/guides/sessions/session-management/ [primary]
63. Developer MCP. https://goose-docs.ai/docs/mcp/developer-mcp/ [snippet]
64. Session recipes. https://goose-docs.ai/docs/guides/recipes/session-recipes/ [snippet]

### Conductor

65. Docs. https://www.conductor.build/docs/ [primary]
66. Workspaces and branches. https://www.conductor.build/docs/concepts/workspaces-and-branches [primary]
67. Parallel agents. https://www.conductor.build/docs/concepts/parallel-agents [primary]
68. Workflow. https://www.conductor.build/docs/concepts/workflow [primary]
69. Agent modes (goal bar). https://www.conductor.build/docs/concepts/agent-modes [primary]
70. Diff viewer. https://www.conductor.build/docs/reference/diff-viewer [primary]
71. Checks. https://www.conductor.build/docs/reference/checks [primary]

### Warp

72. Using agents (conversation panel, queue, context indicator). https://docs.warp.dev/agents/using-agents [primary]
73. Terminal and agent modes (toolbelt). https://docs.warp.dev/agents/local-agents/interacting-with-agents/terminal-and-agent-modes/ [primary]
74. Task lists. https://docs.warp.dev/agents/capabilities/task-lists/ [primary]
75. Code diffs. https://docs.warp.dev/agents/local-agents/code-diffs/ [primary]
76. Interactive code review. https://docs.warp.dev/agents/local-agents/interactive-code-review/ [primary]
77. Agent notifications. https://docs.warp.dev/agents/capabilities/agent-notifications/ [primary]
78. Managing cloud agents (Agent Management Panel). https://docs.warp.dev/platform/managing-cloud-agents/ [primary]
79. CLI agents overview. https://docs.warp.dev/agents/cli-agents/overview/ [snippet]

### LM Studio

80. Modes. https://lmstudio.ai/docs/app/user-interface/modes [primary]
81. Chat. https://lmstudio.ai/docs/app/basics/chat [primary]
82. Download a model. https://lmstudio.ai/docs/app/basics/download-model [primary]
83. v0.3.27 release notes and `lms load --estimate-only`. https://lmstudio.ai/blog/lmstudio-v0.3.27 and https://lmstudio.ai/docs/cli/local-models/load [primary]
84. Local server. https://lmstudio.ai/docs/developer/core/server [primary]
85. Presets. https://lmstudio.ai/docs/app/presets [primary]

### JetBrains

86. AI Chat. https://www.jetbrains.com/help/ai-assistant/ai-chat.html [primary]
87. Agents. https://www.jetbrains.com/help/ai-assistant/agents.html [primary]
88. Junie agent. https://www.jetbrains.com/help/ai-assistant/junie-agent.html [primary]
89. Junie IDE plugin (older docs). https://junie.jetbrains.com/docs/junie-ide-plugin.html [primary]

### Apple

90. HIG Materials (Liquid Glass). https://developer.apple.com/design/human-interface-guidelines/materials (read via https://developer.apple.com/tutorials/data/design/human-interface-guidelines/materials.json) [primary]
91. HIG Color. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/color.json [primary]
92. HIG Accessibility. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json [primary]
93. HIG Motion. https://developer.apple.com/tutorials/data/design/human-interface-guidelines/motion.json [primary]
94. Adopting Liquid Glass. https://developer.apple.com/tutorials/data/documentation/technologyoverviews/adopting-liquid-glass.json [primary]
95. SwiftUI `glassEffect(_:in:)`. https://developer.apple.com/tutorials/data/documentation/swiftui/view/glasseffect(_:in:).json [primary]
96. SwiftUI `Glass`. https://developer.apple.com/tutorials/data/documentation/swiftui/glass.json [primary]
97. MacRumors, iOS 26.1 Liquid Glass Clear/Tinted. https://www.macrumors.com/how-to/ios-26-1-reduce-liquid-glass-effects/ [secondary]

### Web standards and Electron

98. MDN, `prefers-reduced-transparency`. https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency [primary]
99. MDN browser-compat-data, media queries. https://raw.githubusercontent.com/mdn/browser-compat-data/main/css/at-rules/media.json [primary]
100. WCAG 2.2 Understanding 1.4.3. https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html [primary]
101. WCAG 2.2 Understanding 1.4.11. https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html [primary]
102. WCAG 2.2 Understanding 2.3.3. https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html [primary]
103. Electron BrowserWindow. https://www.electronjs.org/docs/latest/api/browser-window [primary]
104. Electron BaseWindowOptions. https://www.electronjs.org/docs/latest/api/structures/base-window-options [primary]

### Known gaps

These pages failed or were not available:

- help.openai.com agent-mode and canvas articles returned 403.
- learn.chatgpt.com `/docs/app/review` and `/docs/scheduled-tasks.md` returned 404.
- No LM Studio page documents an in-app resource monitor.
- No Apple primary page documents the 26.1 Clear/Tinted setting.
- None of the surveyed products except DSH publishes density, typography, colour or motion tokens.
