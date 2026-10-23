# U1 session features handoff

**Status:** candidate on `codex/u1-session-features`; three features built, independently reviewed,
review findings fixed. Not merged, no owner approval, U1 exit stays open (see residuals).
**Date:** 2026-10-23 · **Base:** `2defd182`, then main `603ae3d7` merged (one conflict, the
contract `index.ts` export list). Checkout `/Users/yuzuru/Projects/Guanxi-lanes/u1rest`, ports
5216/4416, Node 26, shared `agent-dev` heavy lock.

## What is built

1. **New-session screen (E1)** at `/agent`, `packages/web/src/features/new-session`: project picker with
   folder state, composer (Enter starts, Shift+Enter newline), connection, model ID, access mode, a Run
   options disclosure (folders, hosts, local context, attachment ids, protected paths), chips for changed
   values only, per-browser recent projects, loading skeleton, empty (one action), error (source, time,
   copyable code, reason inside the alert), `node_unreachable` with last-known age, degraded folder list,
   unknown start outcome. `NativeAgentPage` now only hosts a running session.
2. **Finished-unseen indicator**, `features/shell/seen.ts`, `useUnseenSessions.ts`: unseen = run state
   finished and log head beyond the head this profile last showed; no timers; history older than the
   profile baseline is seen; the session on screen or just watched is seen; max-merge across tabs.
3. **Ephemeral side chat (D-135)** on native sessions. Node seam (contract `side-chat.ts`, server
   `native-agent/side-chat.ts` and `sideChat*` methods, routes `POST /api/agent/:id/side-chat/{respond,save,send}`,
   README section "Ephemeral side chat (U1)"); web panel `features/side-chat`; inspector renders saved chats.
   No owner decision was needed: connection and model come from the session's own policy, Save is an
   `agent.note` (no migration), Send reuses the FIFO with a derived prompt id.

## Gates (this session)

| Gate | Result |
| --- | --- |
| typecheck, lint:md, check:licenses, ui:check, `npm run lint` | pass (675 packages, 0 not allowed; suppression file unchanged) |
| `npm test` (`check-i4oh2tvg`) | pass: codemods 6, gates 102, core 2504 (2 Linux-only skips), kernel 107, web 466 in 52 files, ui 49 + vitest, bench |
| `npm run test:web:browser` (`check-x8s_1a5w`) | pass 194/194, 3.4 min (exit 0; the receipt reads `source_changed` only because this hand-off file was written during the run) |
| `npm run ui:check:browser` (`check-nq3sei6s`) | pass: G13, G14, G15-clipping, G16 and their seeds |
| `npm run build` (`check-9x_nbggx`) | pass |

## New / regression envelope

- **New:** server side-chat 17 (`side-chat.test.ts` 15, `side-chat-contract.test.ts` 2); web component and unit
  new-session 23, side-chat 24 (incl. inspector rendering), shell-unseen 14, shell-seen 6, brand-mark 1; browser
  new-session 9, unseen-sessions 5, side-chat 7. One existing component test adapted (native-agent hint id: same property,
  resolved through `aria-describedby`).
- **Envelope:** the full suites above. Existing `native-agent/*`, session-log, shell and native-agent browser
  specs were run unchanged in the same gates.

## Exit-gate evidence

- Unsaved side chat adds zero session-log events: server test compares every node-database table's row
  count and the data-directory file list before and after completed, failed and canceled requests and after
  restart, and counts K3 receipts separately (one per completed request, none otherwise). The browser spec
  repeats the count through the session events route (mock node) before and after.
- Save adds exactly one `agent.note` (plus at most one `writer.acquired` handover bookkeeping event on an idle
  session) and is idempotent; Send adds exactly one prompt; neither performs the other. Reload discards an
  unsaved chat and the panel and `beforeunload` say so beforehand.
- New-session flow: axe 0 serious/critical in ready, run-options, loading, error, offline, empty, start
  failure, both themes and locales, 320 px at 200% text; keyboard order and focus ring asserted; a seeded
  violation proves the scan.

## Independent review (separate commits)

Server (`sde-agent:implementation-reviewer`): fit proof ignored the draft; local bound; stranded queued Send
reported as sent; reused client request id double-billed then failed; changed Send payload; between-turn 503;
FIFO throw exposure; transcript marker; unproven claims (receipts, 499, 429). Fixed in `20961d1b`.
Web (`frontend-agent:accessibility-reviewer`): quick-navigation false positive; no focus after start; Russian
state chrome in English; discard confirmation not described; browser-offline gating; hidden required field;
load reason outside the alert; folder-save message; unknown start outcome; live regions; label-in-name; focus
loss; 320 px and long names; stale manifest. Fixed in `eda6a089`, tests in `9dd7a6dc`.

## Independent cross-check fixes (Opus, 2026-10-23)

No P1; two P2s and six P3s, each fixed with a red test commit first (`073e976f`, web tests commit) and a
fix commit (`3cca5818` server, `eda46401` web).

- **P2-1 zero-write proof.** The test now opens every `*.sqlite` under the data directory read-only
  (`test.sqlite`, `connections.sqlite`, `native-projects.sqlite`, any new file), compares per-table counts and
  the file list (sqlite by name), and checks the K3 receipt table apart (exactly +1 per completed request). The
  production sidecars (`notifications`, `voice`, `work`, index) are not loaded by the native fixture and booting
  `start()` needs a live provider, so that part is argued from the code (the seam imports none), not asserted.
  README and this hand-off say so.
- **P2-2 spend.** Receipts are `side-chat:<session>:<uuid>`; run-budget limits apply to the session's cumulative
  side-chat spend and refuse with `budget_exhausted` before dispatch; per-session concurrency
  `GUANXI_SIDE_CHAT_MAX_CONCURRENT` (default 1) refuses with `too_many_requests`. Tests: exact limits, prefix
  isolation, node-level refusal that never reaches the provider, slot release on completion, failure and abort.
- **P3-1** the receipt assertion no longer claims canceled requests leave none; K3 under-accounting on cancel after
  billing is a recorded residual (K3 unchanged). **P3-2** long Send compares the stored artifact checksum (same
  first 8 KiB, different tail gives `operation_conflict`). **P3-3** `onSent` makes the session page re-read its
  status and resume polling. **P3-4** Save is bounded at 256 KiB (`too_large`, no truncation; boundary tested at
  the exact byte). **P3-5** seen heads absent from a complete list read are pruned (persisted despite the
  max-merge write; a partial page never prunes); recents keep ten. **P3-6** Send's answer comes from
  `prompt()`'s real outcome (`started`, `queued`, `duplicate`).

Gates after the fixes are listed under "Gates after cross-check fixes" below.

## Shared edits

- `packages/server/src/native-agent/service.ts` (queue returns a status, optional ids on `queue`, `prompt`,
  `launch`), `model.ts` (one export), `plugin.ts`, `routes.ts`, `README.md`: K4/R2/K5 lanes touching
  `native-agent` may conflict.
- `packages/contract/src/index.ts` (one export line, merge-sensitive with MS2), `packages/web/src/lib/locale.ts`
  (two message registrations), `components/ui.tsx` (optional `describedBy` on the legacy Select), `App.tsx`
  (`UiLocaleProvider` at the root), inspector `model.ts`, `packages/ui/catalog/manifest.json` (regenerated).
- Not touched: the API client module, notification, voice and work routes.

## Residual risk and deferred

- **Owner signatures** for all `review` components; nothing here is `approved`; no new `@guanxi/ui`
  component was added (Select, Checkbox, Badge stay draft, so the screen uses the legacy native Select and
  Button toggles).
- **112 CSS suppressions** and the 278 ESLint bulk suppressions remain; none were added.
- Side chat: native sessions only (no legacy Chat Job route), docked panel (no floating placement, not a
  workspace block), non-streaming reply, in-app navigation discards an unsaved chat without a prompt (only
  reload and close warn), `writer.acquired` bookkeeping on idle Save, per-template token framing is a
  conservative 16-byte allowance, local-runtime output reserve unknown (a `length` stop is flagged).
- New session: no microphone, presets, machine/worktree/branch/effort/budget/judge/ledger options (no node
  API); create has no idempotency key, so an unknown outcome relies on the user checking the list.
- Finished-unseen: per-browser store (no cross-device sync), needs a session-list read, an older session
  opened by URL outside the loaded page is not marked until loaded, closing a tab while watching a finish
  flags it on the next load.
- Chromium only; no physical assistive technology; the side-chat browser spec runs against a mock node, the
  real node's zero-write property is proven by the server tests.
- The X1 indexing test is load-sensitive (inherited).

## Gates after cross-check fixes

Light: typecheck, `lint`, `lint:md`, `ui:check` pass (suppression file unchanged). Targeted: server side-chat 22 and
contract 2, web 475 in 52 files. Heavy: `npm test` pass (`check-afzg1qfi`: core 2504+ incl. the new server cases, web
475, 2 Linux-only skips) and `npm run test:web:browser` pass 194/194 (`check-0kqd5m3z`, source unchanged).
`ui:check:browser` and `build` were not re-run: this round changed no catalog component or CSS and only added
server/web logic and tests (last passing receipts `check-nq3sei6s`, `check-9x_nbggx`). Residuals added by this round: K3 under-accounting for
a request canceled after billing; production sidecars not covered by the zero-write test.

## Next

Integrator merges, regenerates nothing (no `package.json` change), re-runs the gates on main, folds this file
into `PHASE_STATUS.md`. A follow-up slice could add a legacy-Chat side-chat route and a workspace block.
