# Localization browser-gate flake hand-off

**Status:** locally validated; cross-family review fixes applied · **Date:** 2026-10-21
**Branch:** `lane/fix-localization-flake` · **Base:** `bc4f44c`
**Review-fix commit:** `76b3454` (on top of `ab7973f`)

## Root cause and observation boundaries

The development entrypoint uses React StrictMode. `useAsync` (health/models) and
`useRuntimePolling` (runtime) start a fetch during effect setup, synchronously abort its
signal during cleanup, then start the replacement during effect replay. Chromium may process
that cancellation before the first request reaches Playwright route interception. Thus a
correct initial mount can intercept one or two GETs per endpoint. The old requirement of two
intercepted GETs could fail on correct cancellation; a route counter does not count all fetch
invocations or only useful completed reads.

The test-only fixture records main-frame `window.fetch` identities, cancellation and
settlement. Each endpoint must have exactly two initial attempts: one aborted/rejected and
one fulfilled/non-aborted. Native request timing and a forced microtask before native fetch
are exercised. The forced variant requires `[true, false]` for cancellation at network start.
The complete ledger must remain unchanged through preview, failed save and successful save.
Methods are normalized to uppercase so lowercase `get` is also tracked.

Route counters independently observe intercepted health/runtime/models requests, including
XHR and other execution contexts that reach page routing. The forced variant requires
`{ health: 1, runtime: 1, models: 1 }` initially and at the no-refetch check. Native timing
requires each final route count to be at most two, accommodating the legitimate initial
aborted request when it is intercepted.

The clock is paused before app timers exist. After the preview is observably committed and
again after save success, `runFor(RUNTIME_IDLE_POLL_INTERVAL_MS * 0.4)` advances four seconds.
These separate windows expose short timer-driven reads while totaling eight seconds, below
the legitimate ten-second idle poll. The clock remains controlled through reload.

## Changes and independent review

- `0a6ad45`: add fetch lifecycle observation and the forced timing variant.
- `cb27d6b`: isolate the locale flow from the legitimate periodic runtime poll.
- `ab7973f`: record the initial reproduction and historical stability evidence.
- The owner's Claude cross-family review returned **merge after fixes**: F1 found missing
  route-level duplicate coverage and case-sensitive methods; F2 found timer-driven reads
  hidden by the paused clock; F3 found the hand-off overstated coverage. These are valid
  limitations of the earlier rewrite; its original no-findings review did not catch them.
- `76b3454`: restore the route counters and assertions, uppercase methods, and add both clock
  windows. No production files, package dependencies or locale/UI assertions changed.
- A separate read-only reviewer checked the two-file fix against `ab7973f`, including exact
  assertions, timer placement, imported constant safety and cancellation ordering. No
  blocking findings. A separate documentation review corrected idle-poll coverage and receipt
  scope claims. The author executed the checks below. This documentation corrects F3 and
  explicitly records the remaining limits.

## Environment and commands

All checks target this Mac with Node 26.9.0 and mocked Chromium:

```bash
export GUANXI_WEB_PORT=5185 GUANXI_API_PORT=4385
export GUANXI_DATA_DIR="$PWD/.lane-data"
agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- npm run test:web:browser
```

Every full gate acquires/releases the shared `heavy` lock separately. The runner stops on a
nonzero gate; source edits and commits are excluded during the stability series. Worktree
contract resolution points to this lane's `packages/contract/src/index.ts`. The scratch
checkout received its own `npm ci` and resolved its own contract source.

## New / regression envelope

- **New in this review fix:** assertions in the two existing locale timing variants; no new
  committed test cases. The earlier rewrite added one forced-timing scenario.
- **Regression envelope:** the complete 49-case mocked browser gate, including native and
  forced locale flows, delayed locale, runtime polling and the other browser specs.
- Focused fixed localization spec: **3/3 pass** (`check-lrnkj1fm/result.json`).
- Workspace `npm run typecheck`: pass (`check-dux42f_h/result.json`).
- Browser specs are outside that tsconfig; a separate strict check of the spec and imports:
  pass (`check-lfl59cff/result.json`).
- `npm run lint:md`, including this final hand-off: pass; receipt indexed in
  `localization-review-fixes/checks.json`.
- Core/unit tests, build, live Ollama, GPU and network-provider validation were not run for
  this test-only fix. The full browser gate is mocked, not a full product regression suite.

All short receipt paths below are relative to `/Users/yuzuru/.local/state/agent-dev/`.

## Mutation proof in a scratch checkout

The fixed tests were copied into a detached scratch worktree based on `ab7973f`. Only the
scratch copy of `packages/web/src/lib/locale.ts` was mutated; lane product code was untouched.
Each mutation was applied independently and restored. Diffs, runner scripts, traces and
logs are retained outside Git at
`/Users/yuzuru/.local/state/agent-dev/localization-review-fixes/`; `scratch-path.txt` names the
checkout. `mutations.json` indexes the baseline and four mutations; `single-xhr.json`
indexes the additional single-XHR control.

The focused command uses `npm run test:browser --workspace @guanxi/web --
localization.spec.ts --grep "locale preview"`, through the same shared-lock prefix and lane
ports, with output artifacts outside the checkout. The single-XHR control selects only
`--grep "abort before interception"`. The baseline runs the complete three-case locale spec.

| Control | Observed result | Receipt |
| --- | --- | --- |
| Unmodified scratch baseline | 3/3 pass | `check-edkt2whr/result.json` |
| One XHR GET `/api/runtime` on RU preview only | Forced variant fails final route count: runtime 2, expected 1 | `check-4gm7bwb9/result.json` |
| XHR GET `/api/runtime` on preview and save | Both variants fail final route counts (native 4, forced 3) | `check-8mv_69y8/result.json` |
| Lowercase `method: 'get'` fetch `/api/runtime`, immediately aborted on preview and save | Both variants fail ledger equality with extra aborted/rejected identities | `check-knomy1ka/result.json` |
| One-second timer GET `/api/models` on preview only | Both variants fail ledger equality with an extra fulfilled model read | `check-sgo2wbd1/result.json` |
| One-second timer GET `/api/models` on successful save only | Both variants fail ledger equality with an extra fulfilled model read | `check-0h_kahqg/result.json` |

The first scratch baseline after `npm ci` failed before the mutation checks: Settings did not
render, and its trace recorded an invalid hook call in Glossary. The network trace contains
two React prebundle version URLs in the same navigation, consistent with a cold Vite
optimizer transition. An unchanged second baseline passed 3/3; the initial failure and trace
are retained as `initial-scratch-*` (`check-y21wlqrh/result.json`). It is excluded from both
mutation detection counts and the lane's full-gate stability series; no product/test rule
was changed to hide it.

## Consecutive full-gate evidence after review fixes

**25/25 consecutive full gates passed at clean
`76b34542ee9f06946dcc3abdd3c11aeb5037f46f`: 49/49 per run, 1,225 case executions,
zero failures, skips or retries.** Each receipt records exit 0, the same clean HEAD before
and after, an unchanged fingerprint and `source_changed: false`.

UTC interval: `2026-10-21T06:35:32.825411+00:00` to
`2026-10-21T06:50:13.886769+00:00`. The local machine-readable index is
`/Users/yuzuru/.local/state/agent-dev/localization-review-fixes/stability.json`.

| Run | Passed | Receipt |
| --- | --- | --- |
| 1 | 49/49 | `check-iv58mcpp/result.json` |
| 2 | 49/49 | `check-ch_gbm_q/result.json` |
| 3 | 49/49 | `check-5544kkbe/result.json` |
| 4 | 49/49 | `check-8fl6u3ez/result.json` |
| 5 | 49/49 | `check-1mkrf17l/result.json` |
| 6 | 49/49 | `check-khohh0da/result.json` |
| 7 | 49/49 | `check-swkn4c_0/result.json` |
| 8 | 49/49 | `check-l1t_nko2/result.json` |
| 9 | 49/49 | `check-zve64r17/result.json` |
| 10 | 49/49 | `check-9v8b9n9x/result.json` |
| 11 | 49/49 | `check-j8zu0wic/result.json` |
| 12 | 49/49 | `check-3reva8_9/result.json` |
| 13 | 49/49 | `check-5zu7dslz/result.json` |
| 14 | 49/49 | `check-vom68yxo/result.json` |
| 15 | 49/49 | `check-spx7iskd/result.json` |
| 16 | 49/49 | `check-vmpljli_/result.json` |
| 17 | 49/49 | `check-_igozt_u/result.json` |
| 18 | 49/49 | `check-k_nehhpa/result.json` |
| 19 | 49/49 | `check-qz39oc2z/result.json` |
| 20 | 49/49 | `check-fmf11xf3/result.json` |
| 21 | 49/49 | `check-pmu7tdxw/result.json` |
| 22 | 49/49 | `check-2a_4l82z/result.json` |
| 23 | 49/49 | `check-mca9vo8e/result.json` |
| 24 | 49/49 | `check-pqha34rq/result.json` |
| 25 | 49/49 | `check-xnjngfl0/result.json` |

The first gate passed 49/49. An external summary parser initially stopped because test titles
contain the word "failed"; after inspection it was corrected to match result-summary lines.
That successful gate is run 1 below. No failed gate was discarded or retried in the series.

## Historical evidence before the review fixes

These results explain the original flake investigation, but do not prove F1–F3 were fixed:

| Check | Result | Receipt |
| --- | --- | --- |
| Old spec, corrected repeated workspace command | 1/11 completed affected cases failed; stopped at first failure | `check-qvfjw0o7/result.json` |
| Restore old absolute route assertion under forced timing | 3/3 fail at the old count assertion | `check-urih_s2t/result.json` |
| Pre-review fixed spec, 30 repeats, 3 workers | 90/90 pass | `check-ttvmd0g0/result.json` |
| Full gate at `cb27d6b`, before F1/F2 were identified | 25/25 gates, 49/49 each | `localization-flake-cb27d6b/stability.json` |

The natural failure saw health twice, runtime/models once rather than twice. This stopped
batch is not an unbiased flake-rate estimate. The historical forced-count artifacts remain
at `localization-flake-cb27d6b/old-count-negative-control/` outside Git.

## Residual risk, shared edits and next step

The identity ledger covers main-frame `window.fetch` calls to health/runtime/models. An extra
canceled fetch through that wrapper in the observed interval changes the ledger; canceled
XHR, worker or other-realm work that never reaches routing has no equivalent identity
assertion. Route counters cross-check intercepted network reads, not every possible request
attempt. Native timing has one count of slack if its initial aborted request is not
intercepted; the forced variant's exact route counts close that gap for its exercised flow.
No worker, service-worker, iframe or canceled-XHR mutation was separately exercised.

Timer observation is bounded to four seconds after each committed transition, eight seconds
overall. Reads scheduled beyond those windows are outside this invariant. The Runtime Bar
browser specs retain native timers but do not assert the ten-second idle cadence. Existing `component/runtime-polling.test.tsx` tests assert idle/visibility scheduling
with fake timers; those component tests were not rerun for this fix. All evidence is local
mocked Chromium evidence, not production validation.

Lane stability receipts record unchanged fingerprints, clean tracked sources and the checked
HEAD (mutation receipts intentionally have dirty sources), but
`source_verifiable: false` / `reusable: false` remains because the runner does not support the
pre-existing `.claude/skills/guanxi-ui` directory symlink. They are execution evidence, not
reusable whole-tree source certification. Neither the verifier nor the symlink was changed.

Shared edits: only this lane's localization spec, fetch fixture and hand-off.
`PHASE_STATUS.md` and `NEXT_AGENT_PROMPT.md` remain integrator-owned under the lane rules.
No push or merge. Next: integrator review of F1–F3 fixes and integration; no blocker remains.
