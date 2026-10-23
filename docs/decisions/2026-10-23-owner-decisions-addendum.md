# Owner decisions — 2026-10-23 addendum (UI redesign, models in chat, MS1 lead)

**Status:** accepted · **Date:** 2026-10-23 · **Decisions:** D-200–D-210
**Extends:** [2026-10-23](2026-10-23-owner-decisions.md); where they differ, this record wins over it and over
[`docs/design/`](../design/README.md).
**Source:** the owner's review of the running product (`localhost:5173`) in the Guanxi development chat,
2026-10-23, with screenshots of the Claude desktop app as a reference for interaction patterns (not identity).

| ID | Topic | Decision |
| --- | --- | --- |
| D-200 | Redesign priority | A full frontend redesign is the priority before more features land. One Opus 5.5 lane owns it. The CSS is rewritten; every control (buttons, dropdowns, checkboxes, toggles, inputs) is a custom component, pixel-checked (a toggle's knob is centred in its track in both states). |
| D-201 | Palette | The verdigris/frost palette is retired ("bathroom tile"). The session/chat surface is white (dark theme: a deep neutral); the accent moves toward the bluer candidate discussed earlier; a second, plentiful tone carries the chrome. Palette changes stay token-only; the lane proposes and the owner approves the final values. D-201 supersedes the brand-colour rows of `BRAND.md`/`FOUNDATIONS.md` §1 once approved. |
| D-202 | Icons over text | Status and controls use custom icons with tooltips and short popovers anchored to the control, not labelled bordered buttons or prose (device → device icon, quota, keep-awake → moon/coffee, power, inbox → tray). Values (GB, MB, tokens, %) are emphasised by weight or colour. No decorative middle dots between phrases. Less text everywhere. |
| D-203 | No retry buttons, no visible polling | Views are always current: no "Retry"/"Refresh" buttons and no "updated N seconds ago" captions for normal data. Updates arrive by push (SSE) or quiet background refresh with stable rendering: no flicker, no layout jump, no whole-view re-render. Errors that need the user say what to do; transient failures recover by themselves. Applies to the whole harness. |
| D-204 | Developer/Visual split removed | The product has one interface, visual from the start. Density, layout and similar preferences move into a customisation panel (icons, borderless) in the harness chrome, not a row of bordered chips. |
| D-205 | Theme | Default `system`; the toggle swaps light and dark only. No emoji or Unicode glyphs as theme icons. |
| D-206 | Graphics tiers | A detailed, polished static design is the default. An optional "max graphics" mode adds shaders and effects; it never blocks interaction, respects reduced motion, and can be turned off. Costly effects are opt-in. |
| D-207 | Composer and session layout | Follow the familiar agent-chat pattern: a new session shows the composer centred; model, effort and context management sit at its lower right, the (simplified) permission mode at its lower left; after the first prompt the composer docks at the bottom. Per-message actions (trace, chat info) are icon buttons with anchored popovers. A new session opens in the current project. |
| D-208 | Models in chat | Chat can select provider models (DeepSeek, OpenAI and others K3 supports), not only Ollama. The node imports provider keys from an owner-designated dotenv file into the K3 vault (values never pass through prompts, logs or clients); an OpenAI-compatible connection may carry an owner-set base URL. Local chat gets a harness system prompt so a model knows it runs inside Guanxi. |
| D-209 | Fleet map | Proposed feature, accepted for design: a rendered (bounded, not free-pan) map of devices and sessions — device nodes with type icons (laptop, desktop, server, phone), state colour, the lead/home marked, animated links showing real traffic; clicking a node opens a panel with its sessions (open any session's chat view, including a delegated sub-agent's prompt and thinking under D-113 rules) and its loaded models. Views: one session, one project, all devices. |
| D-210 | MS1 lead | The MS1 lead is Claude Sonnet 5.5 at medium effort through K5 (Claude Code), replacing the planning-quota note in D-197. The owner approved the DS2 Touch ID signer setup; Guanxi sends the steps. |

The Electron desktop build (U2) remains the path to a macOS DMG; TypeScript stays.
