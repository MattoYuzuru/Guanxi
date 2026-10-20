# Design principles

**Status:** accepted · **Updated:** 2026-10-20

Every screen, component and review is checked against these. Each principle names how a
reviewer can tell it is broken. Evidence: [01 harness UI patterns](../research/2026-10-20-design/01-harness-ui-patterns.md) §6 and the owner decisions.

1. **Truth over confidence.** Context, quota, balance, ETA, fit, energy and machine state show a
   source and an age; `unknown` is a designed state, not a blank.
   *Broken when* a number appears without provenance or a missing value renders as `0`.
2. **Work outlives the window.** Closing a pane, the window or the laptop lid is a visible state,
   never a side effect that stops or duplicates work.
   *Broken when* collapsing a terminal kills its process or a reload duplicates a message.
3. **Scope lives in the composer.** Where the run executes, what it may touch, which model it
   uses and how full the context is sit next to the prompt; only non-default values show as
   chips.
   *Broken when* the user must open settings to learn which machine or mode a run uses.
4. **Reading surfaces are opaque; glass is for what floats.** Transcript, diff, code, terminal
   and tables never sit on glass. Glass never stacks on glass; at most three glass surfaces are
   visible.
   *Broken when* body text sits on a translucent layer.
5. **Small first, deep on demand.** A block summarises, its pane explains, the trace inspects;
   each level is one action from the previous one.
   *Broken when* a block is a wall of detail or a detail needs more than one hop from its summary.
6. **Status comes from the harness.** Plans and boards move on evidence; an agent's "done" is
   shown as "verification requested".
   *Broken when* UI state depends on an agent remembering to tick a box.
7. **Attention is centralised and actionable.** One inbox; typed actions on every notification;
   toasts only for what needs the user now (D-136).
   *Broken when* an important event exists only as a toast, or a notification has no next action.
8. **The user owns the layout.** Any block can go anywhere, be hidden, resized, floated or popped
   out; plugins add blocks but never rearrange; the core navigation always exists (D-131).
   *Broken when* a plugin moves another block or the user cannot reach New, Projects, Models or
   Settings.
9. **Two modes, one product.** Developer mode shows the machinery; Visual mode shows results.
   Switching never loses work or the other mode's layout (D-132).
   *Broken when* a Visual-mode screen shows raw code by default.
10. **Queue and steer are distinct.** Enter queues; "send now" steers at the next tool boundary;
    the queue is visible and editable.
11. **Review is a conversation.** Line comments on a diff are batched and sent back as one
    message; the result is a fresh diff.
12. **Parallel work is isolated and named.** Every background run shows its machine, worktree or
    branch and its leases (ports, containers, browser profiles).
13. **Motion confirms, never informs alone.** One easing family, short durations, nothing moves
    under Reduce Motion, streaming text never animates; every animated state also has a static
    cue (text, icon or colour plus shape).
14. **No approval prompts.** The two access modes never ask permission (D-111, D-118). A user's
    own destructive action states what it discards before it runs.
15. **Every pixel from a token, every control from the catalog.** Features use semantic tokens
    and catalogued components only; a new component starts as `draft` and ships only when the
    owner approves it.
    *Broken when* a lint gate needs a new suppression.
16. **Accessible by default.** WCAG 2.2 AA: contrast in every theme (worst case on glass),
    keyboard paths including moving blocks without dragging, visible focus, names on every
    control, live regions for streaming and status, 24 px minimum targets, Reduce Motion,
    Reduce Transparency, Increase Contrast and forced colours honoured.
