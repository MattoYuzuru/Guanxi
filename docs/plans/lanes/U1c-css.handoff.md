# U1-c CSS typography, focus and motion migration

**Status:** locally checked; independent root review pending · **Date:** 2026-10-22

Branch `codex/u1c-css`, base `af6f7fb`. The behavior, test and suppression changes are in
`4a20756`; this handoff is a separate documentation commit. No push, merge, rebase, generated
asset or approval record was written.

## Delivered

The legacy root stylesheet now consumes the already-generated U1 tokens. No token value was
invented or edited.

| Location | Change |
| --- | --- |
| `@theme` | `--font-sans` → `var(--font-family-sans)`; `--font-mono` → `var(--font-family-mono)` |
| `body` | `13px` → `var(--font-text-size)`; `1.5` → `var(--font-line-height-ui)` |
| `:focus-visible` | offset `2px` → `var(--focus-ring-offset)`; radius `3px` → `var(--border-radius-inline)` (the intended standard 6 px) |
| `.anim-spin` | `0.7s linear` → `var(--motion-duration-loop) var(--motion-easing-linear)` |
| `.anim-pulse-soft` | `1.6s ease-in-out` → `var(--motion-duration-loop) var(--motion-easing-standard)` |
| `.anim-fade-up` | `0.16s ease-out` → `var(--motion-duration-moderate) var(--motion-easing-enter)` |
| `guanxi-fade-up` from | `translateY(4px)` → `translateY(var(--motion-distance-sm))` |
| `.stream-caret::after` | `1.05s` → `var(--motion-duration-loop)`; `step-end` is preserved because no step timing token exists |
| `.sheen::after` | `1.4s ease-in-out` → `var(--motion-duration-loop) var(--motion-easing-standard)` |
| Reduced motion | durations/counts replaced with `animation: none !important` and `transition: none !important` |

The touched root comment is now English and states that body text comes from
`--font-text-size`. Unrelated Russian comments, fit colours, syntax colours, legacy aliases,
project-chip colours, markdown sizing and all other CSS are unchanged.

Files changed against the base:

- `packages/web/src/index.css`
- new `packages/ui/gates/u1c-css.test.mjs`
- the exact `packages/web/src/index.css` `guanxi/no-literal-css` count in
  `eslint-suppressions.json`
- this handoff

No UI component, story, review status, approval record, layout, federation or `App` file changed.

## New tests / regression envelope

**New:** 4 focused Node cases in `packages/ui/gates/u1c-css.test.mjs`. They parse the real
stylesheet with the already-declared `postcss` dependency and assert the exact token mappings,
the fade distance, the preserved caret step timing, absence of stale raw font/motion values in
the migrated declarations, and reduced motion as `animation: none !important` plus
`transition: none !important`. The file is picked up by
`npm run test:gates --workspace @guanxi/ui` (`node --test gates/*.test.mjs`).

**Regression envelope:** none was run by this sandboxed worker. Per lane policy the root
coordinator owns full `npm test`, browser, build, Storybook, UI and Chromium computed-style
checks. This handoff does not claim them.

Sensitivity check: a temporary copy of the same test pointed at the pre-change
`af6f7fb` stylesheet failed all 4 cases. The temporary files were removed; the checkout was not
modified by that check.

## Executed checks

All commands ran in this standalone clone under `nice -n 10`.

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | local `packages/contract/src/index.ts` in this clone |
| `node --test packages/ui/gates/u1c-css.test.mjs` | 4 pass, 0 fail |
| `npx eslint packages/web/src/index.css` | exit 0 |
| `npx stylelint packages/web/src/index.css` | exit 0 |
| `npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |

The suppression count was checked without editing unrelated entries: a temporary copy of
`eslint-suppressions.json` was passed via `--suppressions-location` with
`--prune-suppressions`, and the file entry stayed at exactly 117. The committed file still has
only the one assigned hunk (`127` → `117`); 117 literal-CSS findings remain. This is not zero
suppression and does not claim it.

## Residuals

- Root GPT independently reviews this diff and runs the full gates and real Chromium
  computed-font/reduced-motion checks; this worker does not claim those results.
- The focus radius change from 3 px to the standard inline radius of 6 px is intentional and
  visible.
- The caret keeps `step-end` until a step timing token exists; only its duration is tokenized.
- The remaining 117 literal-CSS findings and all untouched legacy CSS are outside this slice.
- No browser, visual, screen-reader or performance verification was performed here.

## Review-fix (2026-10-22)

The previous same-policy attempt exited after reporting a red test, but the actual checkout was
clean: `git status --porcelain` was empty and HEAD was `4a20756` on `codex/u1c-css`, with exactly
the three intended paths changed against `af6f7fb`. No untracked edits were assumed or recovered.

Fresh verification could not reproduce the reported red test at `4a20756`: the focused file
passed 4/4. The test was then shown to fail 4/4 against the `af6f7fb` CSS, so it is not vacuous.
The exact pruned suppression count is 117, and scoped ESLint, stylelint and web `tsc` all pass.
No production or test defect was found in this round, so there is no additional behavior/test
fix commit: `4a20756` already carries the behavior, test and suppression changes. This handoff
commit records the evidence. No historical handoff existed, and no historical claim was
rewritten.

## Independent-review fixes (2026-10-22)

Two confirmed U1c integration findings from the independent root review were fixed in separate
commits on `codex/u1c-css` after `08b8b70`. The original three mapping cases in the Node gate
are unchanged; the fourth reduced-motion case is strengthened. No other product CSS, generated
file, snapshot or approval record was touched.

### P2a — obsolete legacy font freeze (`4d37ab6`)

`packages/web/test/browser/local-fonts.spec.ts`:

- Replaced `H2: importing runtime tokens preserves legacy computed fonts and spacing` with
  `H2: built app applies IBM Plex typography, density type size and spacing`. The old case
  asserted `Inter`/`SF Mono` against a synthetic legacy build, which contradicts the approved
  IBM Plex migration.
- The replacement runs against the ordinary built app for light and dark and for compact and
  comfortable density. It asserts IBM Plex Sans on `body`, IBM Plex Mono on `font-mono`,
  13 px/19.5 px compact, 14 px/21 px comfortable, and the preserved `p-2` 8 px, `gap-3` 12 px
  and `--spacing` 4 px checks.
- Removed the now-unused `baselineDirectory`/`__legacy__` Vite build and static-server path
  after `rg` confirmed H2 was its only user. The ordinary built-app Vite build, loopback
  server, path jail, M1 32-local-face test and external-font-request test are unchanged.

### P2b — explicit motion setting (`6ddf6bd`)

`packages/web/src/index.css`:

- Added the explicit reduced branch for `:root[data-motion="reduced"]`, its before/after
  pseudo-elements, descendants and descendant pseudo-elements with
  `animation: none !important` and `transition: none !important`.
- Changed the OS media branch so every selector is rooted at
  `:root:not([data-motion="full"])` (root, root pseudo-elements, descendants and descendant
  pseudo-elements). An explicit full setting is therefore not blocked by OS reduce.
- No token, raw duration, palette rule or other CSS changed.

`packages/ui/gates/u1c-css.test.mjs`:

- The fourth case now requires the explicit non-media-gated rule and exact six-selector
  coverage, and requires every OS selector to carry the full-override predicate. Both branches
  are asserted to contain only `animation: none !important` and `transition: none !important`,
  with no raw duration, infinite iteration or longhand regression.
- Before the CSS fix the same case failed first with `expected exactly one explicit
  reduced-motion rule` and then, with only the explicit branch added, with the bare
  `*, *::before, *::after` OS selectors. This is the recorded red evidence.

`packages/web/test/browser/local-fonts.spec.ts`:

- Added one built-app Chromium case covering light/dark × OS no-preference/reduce × setting
  system/reduced/full (12 combinations). It inserts temporary `.anim-spin`, `.stream-caret`,
  `.sheen` and transition probes, asserts `animationName: none`, `transitionProperty: none`
  and an empty `getAnimations({ subtree: true })` result when the setting resolves to reduced,
  and removes the probes in `finally`. It also asserts the animation names, `opacity`
  transition property and at least three running animations otherwise, with an explicit-full
  under OS-reduce positive control for both themes so the reduced checks cannot pass
  vacuously.
- This browser case has not been executed by this worker; root's Chromium run is pending.

## New tests / regression envelope

**New:** 1 Chromium test case (the 12-combination explicit/full motion matrix). The H2 browser
case was replaced and the fourth Node case was expanded; neither increases the case count. The
Node gate remains 4 cases.

**Regression envelope (executed here):** `packages/ui/gates/u1c-css.test.mjs` 4/4,
`packages/web/tsconfig.json` typecheck, and scoped ESLint/stylelint on
`packages/web/src/index.css`.

**Browser pending:** root must run the full browser gate in actual Chromium, including the
rewritten H2 and the new motion matrix. This worker did not run Playwright and does not claim a
browser pass.

## Commands (this round)

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `nice -n 10 node --test packages/ui/gates/u1c-css.test.mjs` | 4 pass, 0 fail after the fix; the old CSS failed 1/4 as recorded above |
| `nice -n 10 npx eslint packages/web/src/index.css` | exit 0 |
| `nice -n 10 npx stylelint packages/web/src/index.css` | exit 0 |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |
| temporary-copy `eslint ... --prune-suppressions` | `packages/web/src/index.css` stays at 117 |

The committed `eslint-suppressions.json` is unchanged: the new rules use `none` keywords and
add no literal-CSS findings, so the count is verified unchanged at 117. No other allowance was
touched.

## Residuals (this round)

- Root must run the full browser gate, including the rewritten H2 and the new motion matrix,
  in actual Chromium; no browser/visual result is claimed here.
- `packages/web/src/features/workspace/WorkspaceLayout/workspace-layout.css` has a separate
  OS-only reduced-motion rule outside this finding's owned files. Inside `.workspace-layout`
  that rule can still override an explicit full setting; it was not changed.
- The prior residuals remain: 117 literal-CSS findings, the intentional 3→6 px inline focus
  radius, and `step-end` on the caret until a step timing token exists.

At handoff the fix commits are `4d37ab6` and `6ddf6bd` on top of `08b8b70`.

## Browser gate compatibility fix (2026-10-22)

The root coordinator ran the full actual-Chromium browser gate at clean `dfe5a2e`; it failed
6/86 with 80 passed. Receipt:
`/Users/yuzuru/.local/state/agent-dev/check-6m67kodz/result.json`; log:
`/Users/yuzuru/.local/state/agent-dev/check-6m67kodz/output.log`. All six failures were the same
obsolete predicate, `Number.parseFloat(...transitionDuration).toBeCloseTo(0.00001, 8)`, with
`Expected: 0.00001` and `Received: 0`. The accepted reduced-motion policy removes motion
(`transition: none !important`), so Chromium computes `transitionDuration: 0s`; these six
assertions establish no production bug and no production CSS was changed.

Updated in `092930e` (one coherent test commit):

| File | Case / observed focused control | Old line |
| --- | --- | --- |
| `packages/web/test/browser/attachments.spec.ts` | attachment flow; focused Download button | 232 |
| `packages/web/test/browser/chat-trash.spec.ts` | Trash flow; focused "Обновить статус удаления" button | 209 |
| `packages/web/test/browser/localization.spec.ts` | locale flow; focused persisted-language combobox; both schedules (`native timing`, `abort before interception`) | 234 |
| `packages/web/test/browser/quick-runs.spec.ts` | Quick Run flow; focused "Сессия" button | 255 |
| `packages/web/test/browser/recipes.spec.ts` | Recipe flow; focused snapshot-result heading | 270 |

At each control the existing probe now also captures `transitionProperty` and
`getAnimations({ subtree: true }).length`. The legacy 0.01 ms tolerance is replaced by three
stronger assertions:

- `transitionProperty` is exactly `none`;
- every comma-separated `transitionDuration` component parsed with `Number.parseFloat` is
  exactly `0`;
- `relevantAnimationCount` is exactly `0`, where the count is
  `getAnimations({ subtree: true }).length`: all relevant animations, not a
  `playState === 'running'` filter. Zero over that superset implies zero running animations.

Every forced-colour, outline, keyboard, scope, error/reload and other assertion is unchanged.
Reduced-motion coverage is not deleted and the obsolete 0.01 ms allowance is not retained.

### New tests / regression envelope

**New:** 0. Six existing cases in the five files were updated; the localization source case runs
under two schedules, which is why one source assertion produced two failures. No new test case
is claimed.

**Browser regression envelope:** 86 pending the root coordinator's actual-Chromium rerun
(6 updated, 80 unchanged). This worker cannot run Playwright and does not claim a browser pass.

### Commands (this round)

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `nice -n 10 npx eslint packages/web/test/browser/attachments.spec.ts packages/web/test/browser/chat-trash.spec.ts packages/web/test/browser/localization.spec.ts packages/web/test/browser/quick-runs.spec.ts packages/web/test/browser/recipes.spec.ts` | exit 0 |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |

`packages/web/tsconfig.json` includes `src`, `vite.config.ts`, `dev-ports.ts` and `test/unit`,
not `test/browser`; the scoped tsc is a package regression check, and the root Chromium gate
remains the authority for these specs.

### Residuals (this round)

- Root must rerun the 86-test actual-Chromium gate; no browser, visual or performance result is
  claimed here.
- No other legacy `<= 0.00001` duration assertion was changed or newly credited. The remaining
  occurrences in `projects`, `project-presentation`, `runtime-bar`, `context-limits`,
  `capability-override`, `model-evidence`, `catalog-*`, `add-from-ollama` and
  `hugging-face-discovery` specs are outside this fix.
- The prior residuals remain unchanged: the OS-only `workspace-layout` reduced-motion rule, 117
  literal-CSS findings, the intentional 3→6 px inline focus radius and caret `step-end`.

At this handoff the test fix is `092930e` on top of `dfe5a2e`; this handoff update is the next
documentation commit. No push, merge or rebase was performed.

## Review-fix: Projects StrictMode fixture (2026-10-22)

**Source pin:** `codex/u1c-css` at `2c4a02f` before this fix; test commit `c8d509e`.
**Root red:** U1 candidate `a613f7a` in the `u1-completion` clone, full gate
`check-qj5p8r40`: 1/85 failed, 84 passed. `projects.spec.ts:105`
`expect(errorHeading).toBeFocused()` found no heading; the failure context showed the empty
Projects state instead. Receipt:
`/Users/yuzuru/.local/state/agent-dev/check-qj5p8r40/result.json`, log:
`/Users/yuzuru/.local/state/agent-dev/check-qj5p8r40/output.log`. No production file was
changed.

### Root cause and fix

The old spec read `projectMode` when each `/api/projects` GET reached the route and set
`projectMode = 'empty'` before releasing the held first response. React StrictMode can abort
the first project request before Playwright intercepts it. The surviving second request then
reached the route after the mode had already become `empty`, returned an empty list and never
produced the intended failure.

`packages/web/test/browser/projects.spec.ts` now runs the full existing scenario twice:
`native timing` and `abort before interception`, driven by
`installFetchLifecycle(page, deferNetworkStart)` as in `localization.spec.ts`. The shared
fixture observes health/runtime/models only, so the second schedule also installs a local
one-microtask deferral for `/api/projects`; this lets StrictMode cleanup cancel the first
project read before the network without changing the shared fixture.

The fixture now:

- fails every initial project GET until the explicit keyboard retry;
- releases the initial gate while the failure mode is still active;
- waits for the focused `Не удалось загрузить проекты` heading;
- switches to the empty projection immediately before `Повторить` + `Enter`;
- records the observed initial read count and asserts the retry issued exactly one read;
- separately asserts the expected one post-create reload, so the whole flow has no hidden
  project reads.

All previous scoping, keyboard, create, no-filesystem-root, 200% zoom and side-effect
assertions are preserved. The reduced-motion duration assertion is unchanged.

### New tests / regression envelope

**New:** 1 additional schedule. The existing Projects case is now two cases (native timing and
abort before interception); this is one strengthened existing scenario, not two new feature
tests.

**Browser regression envelope:** 87 pending the root coordinator's actual-Chromium run. This
worker did not run Playwright, the browser gate, build or Storybook.

### Commands (this round)

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `nice -n 10 npx eslint packages/web/test/browser/projects.spec.ts` | exit 0 |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |

The scoped tsc does not include `test/browser`; the root Chromium gate remains the authority
for this spec.

### Residuals (this round)

- Root must run the full actual-Chromium gate; the two-schedule Projects pass is not claimed
  here.
- The shared `fetch-lifecycle.ts` fixture is intentionally unchanged and still observes only
  health/runtime/models. The project microtask deferral is local to `projects.spec.ts`.
- Route counters observe only intercepted requests; an initial read aborted before
  interception is not counted. The assertion is relative to the observed initial count, not a
  fixed StrictMode attempt count.
- The post-create reload count (+1) is asserted separately from the retry read (+1); the final
  count is initial + 2. This is the intended create-and-refresh flow, not a retry duplicate.
- The legacy `0s`/`1e-05s` reduced-motion allowance in this spec remains unchanged; it is
  outside this fixture finding.
- No production CSS/TSX, other tests, status files or approvals were edited.

The test fix is `c8d509e` on top of `2c4a02f`; this handoff update is the next documentation
commit. No push, merge or rebase was performed. Final clean pin: the HEAD documentation commit
containing this section, with `git status --porcelain` empty.

## Review-fix: direct abort-before-network evidence (2026-10-22)

**Finding.** The forced `abort before interception` schedule installed a one-microtask deferral
for `/api/projects`, but it did not record whether the project fetch signal was already
aborted when the actual fetch was invoked. The test only observed intercepted route reads and
the committed focused error. A schedule that never aborts a project read before the network
could therefore still pass the claimed forced schedule; AGENTS.md Definition of done item 4
requires a direct assertion for every claimed property.

**Source pin.** `codex/u1c-css` at `e73936b` before this fix; test commit `3d14692`.

### Change (test-only)

`packages/web/test/browser/projects.spec.ts`:

- The existing local `deferProjectReadBeforeNetwork` wrapper now records, only for
  `GET /api/projects`: a local sequence id, `aborted` at wrapper entry,
  `abortedAtNetworkStart` after the one-microtask deferral immediately before calling the
  native fetch, and the promise `state` (`pending` / `fulfilled` / `rejected`). It records no
  request or response body.
- The records live only in page memory (`window.__guanxiProjectFetchReads`) and the spec reads
  them through a local helper. The wrapper adds an `abort` listener and removes it in
  `finally`. The shared `fixtures/fetch-lifecycle.ts`, production code and production globals
  are unchanged.
- In the forced schedule, after the committed focused error and `initialReadCount >= 1`, the
  test now asserts that at least one project read has `abortedAtNetworkStart === true`. It uses
  `.some(...)`, not an exact StrictMode attempt count, and `expect.poll` rather than an
  arbitrary sleep. The existing focused error and route count prove the non-aborted committed
  read; the retry, create and other assertions are unchanged.

### New tests / regression envelope

**New:** 0. The two existing Projects schedule cases are strengthened; no new test case and no
new schedule were added. The native-timing schedule still runs the same flow without the local
project observation.

**Evidence pending:** This worker cannot run Playwright or Chromium. The direct red/green of the
new forced-schedule assertion is pending the root coordinator's full actual-Chromium browser
gate. Static inspection of `e73936b` found no `abortedAtNetworkStart` observation or assertion
in `projects.spec.ts`, so the previous forced schedule could not fail on the claimed property;
that is the structural red evidence, not a browser result. If Chromium/React's actual schedule
never aborts a project read before native fetch, root must report the red rather than weaken
this assertion.

### Commands (this round)

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `nice -n 10 npx eslint packages/web/test/browser/projects.spec.ts` | exit 0 |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |

`packages/web/tsconfig.json` includes `src`, `vite.config.ts`, `dev-ports.ts` and `test/unit`,
not `test/browser`; the scoped tsc is a package regression check. The root Chromium gate
remains the authority for this spec.

### Residuals (this round)

- Root must run the full actual-Chromium gate; the new forced-schedule assertion is not claimed
  as passing here.
- The local records observe only `GET /api/projects` in the forced schedule. They are
  content-free (no URL query, headers or body) and are not shared with other specs.
- The aborted read's promise `state` is recorded for diagnosis, but the assertion targets
  `abortedAtNetworkStart`, the ordering property the claim names. Route counts still cannot
  observe an attempt Chromium drops.
- No production CSS/TSX, shared fixture, other tests, status files or approvals were edited.

The test fix is `3d14692` on top of `e73936b`; this handoff update is the next documentation
commit. No push, merge or rebase was performed. Final clean pin: the HEAD documentation commit
containing this section, with `git status --porcelain` empty.

## Review-fix: canonical motion utilities and ledger retirement (2026-10-22)

**Finding.** The root full `npm test` at `/u1-completion` candidate `a4a42da` stopped in
`ui:check`; fast G5/G6/G7 were red. Receipt:
`/Users/yuzuru/.local/state/agent-dev/check-a6cxb2j3/result.json`, log:
`.../output.log`. The migrated legacy declarations still used bare keyframe/timing names,
the stream caret still used `step-end`, and the ledger had not been shrunk; `outline-offset:2px`
was still `5 > 4`. Root reviewed and authorized plan `717cb62` with binding corrections; that
authorization record is `241e962`.

**Source pin.** `codex/u1c-css` at `241e962` before the fix; the bounded fix is `e6a3857`.

### Delivered

- `packages/ui/tokens/motion-animations.json`: authored four-entry manifest
  (`fade-up`, `pulse-soft`, `sheen`, `spinner`). It is a strict, closed, non-DTCG companion
  manifest: exact fields, safe identifiers, unique utility/keyframe names, `motion.duration.*`
  type `duration`, `motion.easing.*` type `cubicBezier`, and `infinite`/positive-integer
  iterations. It contains token names only, no new numeric motion values or aliases.
- `packages/ui/tokens/build.mjs`: validates the manifest fail-closed and reads it through the
  supplied `options.read` when present (falling back to the token root), so gate context
  overrides/negative fixtures are observed. The public `generate()` API and deterministic
  output keys are unchanged.
- `packages/ui/generated/theme.css`: regenerated only by `npm run tokens:build`; adds the four
  canonical `--animate-*` declarations in deterministic name order. No generated file was
  hand-edited.
- `packages/web/src/index.css`: the four compatibility classes now use
  `@apply animate-spinner|animate-pulse-soft|animate-fade-up|animate-sheen`; the streaming
  caret is a static accent block; `@keyframes guanxi-caret` is removed. The four existing
  keyframes and the reduced-motion branches remain.
- `packages/web/src/features/chat/ChatPage.tsx:1024`: removed `anim-fade-up` from the assistant
  streaming timeline article. The class and its fade-up recipe remain for the legacy modal
  (`packages/web/src/components/ui.tsx`), not for stream text.
- `packages/ui/gates/legacy-allowlist.json`: removed exactly the 21 retired keys and reduced
  `G6|packages/web/src/index.css|outline-offset:2px` from 5 to 4. No key was added or renamed,
  no count increased, and no held `animation:` allowance remains. The static proof read
  452 → 431 entries, 21 removals, 0 additions, the one 5 → 4 decrement, 0 increases and 0
  `animation:` keys.
- `eslint-suppressions.json`: the `packages/web/src/index.css`
  `guanxi/no-literal-css` count is reduced 117 → 112. Five removed animation declarations had
  been covered by that suppression, so leaving the count at 117 made G9 report an unused
  suppression. This is a shrink only; no suppression was added or increased.

The generated `animate-*` utilities are consumed by the current web compatibility classes.
They are not a complete cross-host or public `@guanxi/ui` animation-component API. The package
Spinner and StatusPill remain static; their keyframes still live in `packages/web/src/index.css`.
Future component/host reuse must verify keyframe ownership and reduced-motion loop removal
first. The full-web reduced-motion branches remove animation entirely; the token `0ms` alone
does not stop an infinite loop.

### Tests and red/green evidence

Written before the production fix:

- `packages/ui/gates/u1c-css.test.mjs` grew from 4 to 7 cases. The old motion case is replaced
  and strengthened: each compatibility class must have exactly one canonical
  `@apply animate-*`, the caret must have no animation, `@keyframes guanxi-caret` must be gone,
  generated declarations must exactly trace the manifest and contain only `var(--motion-*)`,
  no scanned animation shorthand may remain, the two reduced `animation: none` declarations
  are the only CSS animation declarations, the legacy modal keeps `anim-fade-up`, ChatPage does
  not, and the ledger retires every animation shorthand.
- `packages/ui/gates/gates.test.mjs` adds three cases: invalid manifests fail closed (unsafe
  names, extra/root fields, non-string/alias duration, unknown/mistyped tokens, duplicate
  utility/keyframes, bad iterations, empty array), the generator observes `options.read`, and a
  literal `animation: guanxi-spin 1s linear infinite` still fails G6/G7 while
  `@apply animate-spinner` passes G5/G6/G7.
- `packages/ui/gates/foundations.test.mjs` adds one compiled-theme case: the four
  `animate-*` utilities compile to the canonical animation property with live token `var()`
  references, and the default `animate-pulse` namespace stays reset.
- `packages/web/test/browser/local-fonts.spec.ts` keeps all 12 light/dark × OS
  no-preference/reduce × system/reduced/full cells. The caret is asserted static with a
  non-transparent background in every cell; full cells assert `guanxi-spin`/`guanxi-sheen`,
  both `1s`, and named running animations; reduced cells assert `none`, an empty
  `getAnimations({ subtree: true })`, and `transitionProperty: none`. The explicit-full under
  OS-reduce positive control remains.
- `packages/web/test/browser/chat-first-stream.spec.ts` runs under full motion (OS
  no-preference, `data-motion="full"`) and uses the actual Chat route fixture. It asserts the
  actual streaming transcript article, its `::before`/`::after`, and the caret `::after` have
  `animationName: none`, a non-transparent caret background, and an empty
  `getAnimations({ subtree: true })`. The old vacuous 0.01 ms duration assertion is replaced,
  not deleted.

Red before production: `u1c-css.test.mjs` 3 pass / 4 fail (`.anim-spin` and the caret still
declared literal shorthands; the ledger still held the retired keys); `gates.test.mjs` 14 pass /
6 fail (the manifest did not exist and valid G5/G7 fixtures inherited the stale ledger errors);
`foundations.test.mjs` 18 pass / 1 fail (`animate-fade-up` did not compile). Green after:
46 pass / 0 fail across the three files.

### Commands (this round)

All commands ran in this standalone clone under `nice -n 10`.

| Command | Result |
| --- | --- |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | this clone's `packages/contract/src/index.ts` |
| `npm run tokens:build --workspace @guanxi/ui` | ok; generated the five declared outputs; only `theme.css` differs from the pin |
| `node --test packages/ui/gates/u1c-css.test.mjs packages/ui/gates/gates.test.mjs packages/ui/gates/foundations.test.mjs` | 46 pass, 0 fail |
| `npm run ui:check` | exit 1 overall: G1–G9 pass. G5 frozen 898, G6 frozen 112 (117 − 5 shorthands), G7 frozen 10 (11 − caret `step-end`), G8/G9 pass. G10 stale catalog manifest and G12 no base branch fail (see residuals) |
| `npx eslint <the 8 changed JS/TS/CSS files>` | exit 0 |
| `npx stylelint packages/web/src/index.css` | exit 0 |
| `npx tsc --noEmit -p packages/web/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |

`npm run ui:check`'s G9 report still lists `packages/web/src/index.css` at 112
`guanxi/no-literal-css` suppressions and `u1ColourExitReady: false`.

### New tests / regression envelope

**New:** 7 focused Node cases: 3 in `u1c-css.test.mjs`, 3 in `gates.test.mjs`, 1 in
`foundations.test.mjs`. The old motion case in `u1c-css.test.mjs` was replaced and
strengthened; it is not counted as a new case.

**Changed browser cases:** 2 existing cases (`local-fonts.spec.ts` 12-cell motion matrix and
`chat-first-stream.spec.ts` static transcript assertion); **0 new browser cases**.

**Regression envelope executed:** the 46 Node cases in those three gate files, full fast
`ui:check` (G1–G9, G17), scoped ESLint/stylelint and web `tsc`. `packages/web/tsconfig.json`
does not include `test/browser`, so the root Chromium gate remains the authority for the two
changed browser specs. The actual-Chromium browser envelope remains root-run; this worker did
not run Playwright, the browser/UI-browser gates, the app build or Storybook.

### Residuals (this round)

- Root must run the actual-Chromium browser gate, including the full-motion transcript
  assertion and the 12-cell matrix; no browser, visual or performance pass is claimed here.
- `ui:check` G10 reports the catalog manifest stale. The manifest was already not matching the
  current tooltip props at this branch base, and the changed generated `theme.css` is a
  package-wide source-hash input, so refreshing it would change every component's source hash.
  Under the no catalog/hash/approval authorization this worker did not run `ui:manifest`.
  Root must refresh the manifest at integration and rerun G10.
- `ui:check` G12 cannot verify the trusted key set in this standalone clone because it has no
  `refs/heads/main` or `refs/remotes/origin/main`; no approval key or record was changed.
- The 117 literal-CSS suppressions at the pin are now 112 after retiring five animation
  declarations; 112 remain and `u1ColourExitReady` is still false. This bounded fix does not
  close all of U1, DS1 or owner UI approval.
- The four keyframes are still owned by `packages/web/src/index.css`. The generated utilities
  are not a cross-host/public `@guanxi/ui` animation API, and Spinner/StatusPill stay static.
  Any future component reuse must verify keyframe ownership and reduced-motion loop none.
- The prior OS-only `workspace-layout` reduced-motion residual, the intentional 3→6 px inline
  focus radius and the historical 117/112 number are unchanged in meaning; no historical claim
  above was rewritten.

At handoff the fix commit is `e6a3857` on top of `241e962`; this handoff update is the next
documentation commit. No push, merge, rebase, package/lock change, approval/status edit,
`PHASE_STATUS` or `NEXT_AGENT_PROMPT` edit was performed. Final clean pin: the HEAD
documentation commit containing this section, with `git status --porcelain` empty.
