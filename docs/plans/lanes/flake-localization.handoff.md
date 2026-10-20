# Localization browser-gate flake hand-off

**Status:** locally validated; independent code review completed · **Date:** 2026-10-21
**Branch:** `lane/fix-localization-flake` · **Base:** `bc4f44c`

## Root cause

The development entrypoint uses React StrictMode. `useAsync` (health/models) and
`useRuntimePolling` (runtime) start a fetch during effect setup, synchronously abort its
signal during cleanup, then start the replacement during effect replay. The first fetch
invocation always exists, but Chromium may process the cancellation before its network
request reaches Playwright route interception. Thus the route sees one or two GETs per
endpoint depending on request-start, abort and interception ordering. A route counter is
neither the number of fetch invocations nor the number of useful completed reads.

The old test required two intercepted GETs for health, runtime and models, so correct
cancellation could fail it. The product hooks do not need a change: both timing variants
prove two fetch identities, one canceled/rejected attempt and one fulfilled live attempt
per endpoint. This is the same class of transport-observation race as the earlier S0 Quick
Run mock fix (`ebd061f`), rather than a duplicate live read or locale-triggered refetch.

## Changes and review

- `0a6ad45` — `test(web): count locale reads by fetch lifecycle`.
  A test-only init-script fixture records each fetch identity, signal cancellation and
  settlement before network interception. The locale spec requires exactly one fulfilled,
  non-aborted read per endpoint and exactly one rejected aborted StrictMode attempt. It
  compares the entire identity ledger before/after preview, failed save and successful save;
  even an extra canceled fetch fails. All existing save deduplication, failure/retry,
  persistence/reload, glossary, focus, mobile, zoom, forced-colors and reduced-motion checks
  remain. Both native timing and a forced microtask before native network start are covered.
- `cb27d6b` — `test(web): isolate locale checks from periodic runtime polling`.
  Fresh self-review found that a slow host could allow the Runtime Bar's legitimate 10-second
  poll to alter the no-refetch ledger. Pause the Playwright clock on about:blank, before any
  app timers exist, so that assertion measures locale-driven work. Keep the clock paused
  through reload. Also record/assert `[true, false]` for signal cancellation at native fetch
  invocation in the forced variant: the canceled request reaches native fetch already aborted,
  and its replacement does not. No sleeps, request retries or weakened thresholds were added.
- A separate read-only reviewer inspected `bc4f44c..0a6ad45` and then
  `bc4f44c..cb27d6b`, including original assertions, cancellation/concurrency ordering,
  frozen-polling scope and negative-control evidence. No correctness findings. The reviewer
  did not write code or execute checks; the author owns execution.

## Environment and commands

All checks target this Mac/worktree using Node 26.9.0 and mocked Chromium, with:

```bash
export GUANXI_WEB_PORT=5185 GUANXI_API_PORT=4385
export GUANXI_DATA_DIR="$PWD/.lane-data"
```

Every browser invocation used this shared-lock prefix, acquiring/releasing it separately
for each full gate and stopping the stability series on any failure:

```bash
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- <command>
```

`npm ci` was run in this worktree; `require.resolve('@guanxi/contract')` resolved to
`/Users/yuzuru/Projects/Guanxi-lanes/flake/packages/contract/src/index.ts`.

## Failing-before and controlled evidence

| Check | Result | Receipt under `/Users/yuzuru/.local/state/agent-dev/` |
| --- | --- | --- |
| Unmodified spec, intended repetition through root npm wrapper | 2/2 pass; repeat/worker flags were consumed by nested npm, so excluded from repetition rate | `check-8d0bf5zl/result.json` |
| Unmodified spec, corrected workspace command below | 1/11 completed affected cases failed (9.1% observed); 18 passes across both cases, 2 interrupted, 39 not run after first failure | `check-qvfjw0o7/result.json` |
| Unmodified full browser gate | 48/48 pass, 0/1 failed full runs | `check-ieb3dt1o/result.json` |
| Restore old absolute route assertion under forced timing, 3 repeats | 3/3 fail at old route-count assertion; first canceled requests never intercepted | `check-urih_s2t/result.json` |
| Fixed first commit focused spec | 3/3 pass | `check-hhz92chn/result.json` |
| Self-review followup focused spec, paused clock | 3/3 pass, including interactions/reload | `check-6sp9wbt8/result.json` |
| Final fixed spec, 30 repeats and 3 workers | 90/90 pass: 30 native locale, 30 forced locale, 30 delayed-locale | `check-ttvmd0g0/result.json` |

The natural failure occurred at old line 98: health intercepted twice, runtime and models
once each instead of twice. This was a stopped batch, not an unbiased long-run flake-rate
estimate. The old assertion negative control was a temporary test mutation, restored before
the followup commit. Its traces/screenshots are retained outside Git at
`/Users/yuzuru/.local/state/agent-dev/localization-flake-cb27d6b/old-count-negative-control/`.

Correct repetition command (the final `--` is significant):

```bash
npm run test:browser --workspace @guanxi/web -- localization.spec.ts \
  --repeat-each=30 --workers=3 --max-failures=1
```

Negative-control command:

```bash
npm run test:browser --workspace @guanxi/web -- localization.spec.ts \
  --grep "abort before interception" --repeat-each=3
```

## New / regression envelope

- **New:** one forced abort-before-interception browser scenario, with direct ordering
  assertions. One existing locale flow is strengthened by identity/cancellation assertions.
- **Regression envelope:** all 48 existing browser cases, including the native locale flow.
  The full current gate contains 49 tests; the older S0/AGENTS count of 40 is historical.
- Workspace `npm run typecheck`: pass (`check-ta67zbmv/result.json`). Browser specs are outside
  that tsconfig, so a separate strict TypeScript check of `localization.spec.ts` and imports
  also passed (`check-zn2agu9r/result.json`).
- `npm run lint:md`: pass (`check-auewyrl9/result.json`). An earlier attempt found only the
  generated Playwright error-context Markdown retained under ignored `.lane-data`; those
  task-owned artifacts were moved outside the checkout before the green run. No lint rule
  or exclusion was changed.
  Lint including this hand-off also passed (`check-u8tdo6bz/result.json`).
- No production files or package dependencies changed. Core/unit tests, build, live Ollama,
  GPU and network-provider tests are outside this test-only check scope.

## Consecutive full-gate receipts

**25/25 consecutive full `npm run test:web:browser` gates passed at clean
`cb27d6b6509eb34fea6eeddcad73bd3daf48445d`: 49/49 per run, 1,225 case executions,
zero failures, skips or retries.** No source edit or commit occurred during the series.
Each run separately acquired the shared `heavy` lock; other lanes ran between some gates.
Receipt logs were checked for the full 49-pass result, and each receipt for exit 0,
`source_changed: false`, clean before/after state and the same HEAD.

UTC interval: `2026-10-20T20:37:07.450914+00:00` to `2026-10-20T21:05:20.956861+00:00`
(local Moscow dates 2026-10-20–21). Paths below are relative to
`/Users/yuzuru/.local/state/agent-dev/`; each receipt names its redacted output log.
The local machine-readable index is
`/Users/yuzuru/.local/state/agent-dev/localization-flake-cb27d6b/stability.json`.

| Run | Passed | Receipt |
| --- | --- | --- |
| 1 | 49/49 | `check-wafadu8q/result.json` |
| 2 | 49/49 | `check-pffowt0a/result.json` |
| 3 | 49/49 | `check-0sg1jeb2/result.json` |
| 4 | 49/49 | `check-rnyq7831/result.json` |
| 5 | 49/49 | `check-1xhtvybz/result.json` |
| 6 | 49/49 | `check-u4om0r68/result.json` |
| 7 | 49/49 | `check-u6bpriqf/result.json` |
| 8 | 49/49 | `check-2rn9lbrv/result.json` |
| 9 | 49/49 | `check-8m6acs5f/result.json` |
| 10 | 49/49 | `check-lqzgjwuo/result.json` |
| 11 | 49/49 | `check-pau2_zxp/result.json` |
| 12 | 49/49 | `check-8fdfx0pi/result.json` |
| 13 | 49/49 | `check-fngqjply/result.json` |
| 14 | 49/49 | `check-1lbfnh56/result.json` |
| 15 | 49/49 | `check-ai5nae92/result.json` |
| 16 | 49/49 | `check-74dirdj1/result.json` |
| 17 | 49/49 | `check-4jpwcapt/result.json` |
| 18 | 49/49 | `check-exwgak2f/result.json` |
| 19 | 49/49 | `check-6twnvsb0/result.json` |
| 20 | 49/49 | `check-3kxhhwoh/result.json` |
| 21 | 49/49 | `check-im2ltr8r/result.json` |
| 22 | 49/49 | `check-37h8m6lc/result.json` |
| 23 | 49/49 | `check-ycuy1y10/result.json` |
| 24 | 49/49 | `check-hn1xex_4/result.json` |
| 25 | 49/49 | `check-mjw899lq/result.json` |

## Residual risk, shared edits and next step

This is mocked Chromium evidence on this Mac, not production or live-runtime validation.
The forced schedule deliberately exercises abort before interception; the native variant
keeps normal request-start timing. Periodic polling timing is outside this locale invariant;
its existing Runtime Bar browser cases still run with native timers in every full gate.

The runner reports `source_changed: false`, clean tracked sources and the exact checked HEAD,
but marks receipts `source_verifiable: false` / `reusable: false` because its source verifier
does not support the pre-existing `.claude/skills/guanxi-ui` directory symlink. These receipts
are execution evidence; they are not advertised as reusable whole-tree source certification.
`agent-dev verify` on run 24 returned `failed_or_stale_evidence`, consistent with those
non-reusable receipt flags. The worktree-local contract resolution was checked separately. No verifier or symlink was
changed to make that limitation disappear.

Shared edits: none beyond this lane's localization spec, its new browser fixture and this
hand-off. `PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` were not edited. No push or merge.
Next: integrator review and integration; no implementation blocker remains.
