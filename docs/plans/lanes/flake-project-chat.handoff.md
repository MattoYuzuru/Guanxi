# Project Chat component focus flake handoff

**Status:** locally validated · **Date:** 2026-10-21

**Branch:** `lane/fix-project-chat-flake` · **Base:** `7caba28ec6708974706a9e38cefec3f4b028f5a8`

**Tested code:** `47239c9764be2814d82e6ec3b932e6a4d3b7ba81`

## Root cause

`findByRole` / `findByText` establishes DOM presence, not completion of a passive React
focus effect. Under CPU contention the old immediate assertion could observe the heading
or error before its focus effect ran. Both immediate assertions in `project-chat.test.tsx`
were vulnerable; both were reproduced before editing.

The hard-load ownership-error heading is focused by `ThreadPage`'s passive effect in
`ChatPage.tsx`. It does **not** use the K1 animation frame. The new-Project heading uses
`NewThreadPage`'s animation frame; K1 commit `7af0ed9` already suppresses that initial focus
once creation begins or fails. Controlled replay found no product focus defect, so product
code is unchanged.

## Fix commits

- `7aa2a5d` — `test(web): control project chat focus frame ordering`.
  Adds a shared held-frame helper with cancellation and automatically restored spies.
  Awaits actual error focus and explicitly releases the late heading frame before asserting
  that focus remains on the error. Initial heading focus runs through the controlled frame.
- `47239c9` — `test(web): close focus scheduling gaps found in review`.
  Awaits frame registration before flushing, adds pending-creation focus protection coverage,
  and checks hard-load retry focus before and after draining frames/effects.

No arbitrary sleeps or extended test timeouts. Existing exact API arguments, sourced
ownership, no legacy thread read/create, one-create guard, retry counts and route assertions
remain. Held-frame creation tests assert a pending callback exists, so replay is non-vacuous.
For hard-load, eventual focus and retention after an `act`/frame drain are asserted; there is
normally no competing animation frame on that path.

## Failing-before evidence

All checks used this worktree, Node **26.9.0**, the shared `heavy` lock, and:

```bash
export GUANXI_WEB_PORT=5186 GUANXI_API_PORT=4386 GUANXI_DATA_DIR="$PWD/.lane-data"
```

The archived harnesses, every per-trial log, summaries and failure excerpts are under
`/Users/yuzuru/.local/state/agent-dev/guanxi-project-chat-flake-20261021/`.
Receipts below are relative to `/Users/yuzuru/.local/state/agent-dev/`; each receipt's
`log` field points to the captured command output.

| Before check at `7caba28` | Observed result | Receipt |
| --- | --- | --- |
| Both files, serial fresh Vitest processes plus 14 Python busy-loop processes | 1/27 runs failed (3.70%); stopped on first failure, run 27: create error existed while heading retained focus | `check-tv11viol/result.json` |
| Hard-load test only, waves of 24 parallel fresh Vitest processes | 1/96 failed (1.04%); stopped after first failing wave, run 87: heading existed while body retained focus | `check-083_z8oc/result.json` |

These are observed stop-on-failure sample rates, not estimates of the general flake rate.
The hard-load-only invocation intentionally selected one test and skipped its two siblings.
The failures were ordinary focus assertions, not timeouts or environment failures.

Reproduction commands (harnesses are archived alongside the logs):

```bash
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  python3 /tmp/guanxi-project-chat-flake/repeat.py before-load 30 14
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  python3 /tmp/guanxi-project-chat-flake/parallel.py
```

`repeat.py` runs `npm test --workspace @guanxi/web --` with both component file paths,
sequentially, while 14 child Python processes execute busy loops. It records each exit code
and stops at the first failure, terminating and waiting for its own CPU-load processes.
`parallel.py` runs the hard-load title filter in waves of 24, up to 120 invocations,
collecting the whole wave before stopping on failure. Neither harness changes product code.

## Stability evidence

**New:** 1 test for pending creation retaining the active control's focus.

**Regression envelope:** 4 existing tests across the two component files, strengthened;
full repository `npm test` (including 265 web component/unit tests per run), plus the separate
mocked Chromium browser gate. These totals are not credited as new tests.

All following checks ran on clean code commit `47239c9` with no source edits during a check.

| Check | Result | Receipt |
| --- | --- | --- |
| Both component files, 50 sequential fresh processes with 14 CPU burners | 50/50 runs passed, 5 tests per run, zero failures | `check-r1z800l6/result.json` |
| Full `npm test`, run 1 | exit 0 | `check-27fizcas/result.json` |
| Full `npm test`, run 2 | exit 0 | `check-xzwvjrqd/result.json` |
| Full `npm test`, run 3 | exit 0 | `check-2b329owy/result.json` |
| Full `npm test`, run 4 | exit 0 | `check-i7lps9t9/result.json` |
| Full `npm test`, run 5 | exit 0 | `check-8p736bgq/result.json` |
| `npm run test:web:browser` | 49/49 mocked Chromium tests passed | `check-w0xrexiq/result.json` |
| `npm run typecheck` | exit 0 | `check-cgm75135/result.json` |
| `npm run check:licenses` | exit 0 | `check-qw9chlx_/result.json` |

```bash
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- \
  python3 /tmp/guanxi-project-chat-flake/repeat.py after-load 50 14
# Invoked five times sequentially, each with its own receipt:
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm test
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run test:web:browser
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run typecheck
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run check:licenses
```

The full-suite driver is archived as `full-gates.py`; it invokes the exact locked `npm test`
command five times and stops at the first nonzero result. Preparation `npm ci` passed
(`check-06kd_k5k/result.json`); `require.resolve('@guanxi/contract')` resolved inside this
worktree to `packages/contract/src/index.ts`.

Documentation-only validation: `npm run lint:md` passed after writing this handoff
(`check-uq70l_um/result.json`). Test source remained unchanged.

### Receipt boundary

The existing `.claude/skills/guanxi-ui` symlink is unsupported by the runner's source
fingerprinting. Consequently receipts report `source_verifiable: false` and `reusable: false`;
they are execution receipts, not reusable source attestations. Every stability receipt records
the tested HEAD above and `source_changed: false`. No receipts were rewritten to override this
limitation. Logs provide test counts; no JUnit reports were declared to the runner.

## Fresh review

Fresh author self-review and a separate read-only reviewer (`/root/focus_review`, per
`WORKFLOW.md`) both found that immediately checking pending frame count after DOM lookup
could reproduce the same effect-order race. Fixed in separate commit `47239c9` by waiting
for frame registration. Self-review also added the pending-creation and retry focus assertions
in that commit. The independent reviewer inspected the first commit and follow-up diff,
confirmed cancellation/mock cleanup and preserved boundary assertions, and reported no
remaining blocking findings. The reviewer did not execute tests; receipts belong to the
implementation lane.

## Scope, risk and next step

Shared edits: none outside the two requested component test files, their new test helper and
this handoff. No component, token, story, catalog approval or product behavior changed.
`PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` were not edited. No push or merge was performed.

This is local jsdom scheduling evidence and mocked browser regression evidence. It does not
validate a live Ollama/GPU/network deployment or prove absence of every future timing race.
The finite after-drain assertions cover the known late-heading-frame threat; no unbounded
"focus can never move" claim is made. Next step: integrator review and merge under its own
workflow; no further lane implementation remains.
