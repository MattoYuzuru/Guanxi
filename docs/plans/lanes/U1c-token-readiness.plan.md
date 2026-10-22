# U1c token readiness — canonical motion utilities and ledger retirement

**Status:** proposed · plan-only; awaiting root authorization · **Date:** 2026-10-22
**Source pin:** `codex/u1c-css` at `7b49dbc` (clean). Candidate `/u1-completion` `a4a42da`
remains the frozen failed integration and is not edited here.
**Red receipt:** `/Users/yuzuru/.local/state/agent-dev/check-a6cxb2j3/output.log` — full
`npm test` stops at `ui:check`; fast G5/G6/G7 are red.

## Short plan

1. Add focused red assertions first: generated animation utilities must exist and compose the
   accepted motion tokens; the stream caret must be static; no scanned CSS may keep an
   `animation:` shorthand with a bare keyframe/timing name; the legacy ledger must contain no
   animation shorthand entry and must not gain one.
2. Add one small authored manifest, `packages/ui/tokens/motion-animations.json`, with four
   semantic animations composed only from existing `motion.duration.*` / `motion.easing.*`
   tokens. The token build validates the manifest and emits Tailwind theme tokens
   `--animate-spinner`, `--animate-pulse-soft`, `--animate-fade-up`, `--animate-sheen` in
   `packages/ui/generated/theme.css`.
3. Replace the four legacy `animation:` shorthands with `@apply animate-*`; remove the caret
   animation and its keyframes entirely. The caret becomes a static accent block.
4. Retire the now-unused ledger entries: 21 exact keys deleted, `outline-offset:2px` reduced
   `5 → 4`. No key is added, moved, renamed or regenerated.
5. Regenerate `generated/theme.css` with `tokens:build` only; run the focused Node gates and,
   only with root authorization, fast `ui:check`. Root owns the Chromium matrix.
6. Commit one coherent behavior/test/ledger commit and a separate handoff-only docs commit.

**Non-goals:** no scanner/rule/context/ratchet logic change; no `legacy-ratchet-policy.json`,
`eslint-suppressions.json`, baseline, snapshot, correction or allowance change; no
`@guanxi/ui` component animation or catalog status change; no package/lock change; no
push/merge/rebase; no `PHASE_STATUS`/`NEXT_AGENT_PROMPT`; no browser/build/Storybook/
`agent-dev`/nested sandbox run by this worker; no live model, owner data, external service,
SSH or third-party copy.

## Failure analysis

The mandatory receipt has two distinct causes; both must be fixed together.

1. **New literal shorthands.** Five declarations still carry a bare keyframe name:
   `guanxi-caret`, `guanxi-fade-up`, `guanxi-pulse-soft`, `guanxi-sheen`, `guanxi-spin`.
   G6's `rawWords` treats the identifier as a literal CSS value, so all five are new G6 keys.
   The caret's `step-end` is additionally a new G7 key. The receipt reports exactly five
   `G6 ... 1 new violation(s)` and one `G7 ... 1 new violation(s)`.
2. **Retired ledger counts.** The earlier tokenization removed the raw font, type, radius,
   focus-offset, distance, reduced-motion and old animation values, but did not shrink
   `packages/ui/gates/legacy-allowlist.json`. G5/G6/G7 share one `ratchet(ctx)` result, so all
   three report the same 22 unused allowance lines. `outline-offset:2px` still has four actual
   occurrences (`5 > 4`); deleting that key would create four new violations.

The ratchet itself is correct: `auditRatchet` permits deletions and exact-count reductions and
rejects any increase or new key. No correction or policy change is involved.

## Decision: generated semantic animation theme tokens

Use the existing Tailwind theme/build pipeline, not a new CSS-value mechanism:

- **Authored source:** `packages/ui/tokens/motion-animations.json`, four entries.
- **Build output:** `packages/ui/generated/theme.css`, four `--animate-*` declarations inside
  the existing `@theme inline` block, after the existing `--animate-*: initial` reset.
- **Consumers:** `packages/web/src/index.css` uses `@apply animate-*`; Tailwind resolves the
  utility and keeps the `var()` references live under `data-motion`.
- **Caret:** no utility, no token, no keyframes. Static block only.

Exact values (composition is generated; the manifest stores token names, not duplicated
numbers):

| Theme token / utility | Keyframes | Duration token | Easing token | Iterations |
| --- | --- | --- | --- | --- |
| `--animate-spinner` / `animate-spinner` | `guanxi-spin` | `motion.duration.loop` | `motion.easing.linear` | `infinite` |
| `--animate-pulse-soft` / `animate-pulse-soft` | `guanxi-pulse-soft` | `motion.duration.loop` | `motion.easing.standard` | `infinite` |
| `--animate-fade-up` / `animate-fade-up` | `guanxi-fade-up` | `motion.duration.moderate` | `motion.easing.enter` | omitted (1) |
| `--animate-sheen` / `animate-sheen` | `guanxi-sheen` | `motion.duration.loop` | `motion.easing.standard` | `infinite` |

Generated declarations, in deterministic name order:

```css
--animate-fade-up: guanxi-fade-up var(--motion-duration-moderate) var(--motion-easing-enter);
--animate-pulse-soft: guanxi-pulse-soft var(--motion-duration-loop) var(--motion-easing-standard) infinite;
--animate-sheen: guanxi-sheen var(--motion-duration-loop) var(--motion-easing-standard) infinite;
--animate-spinner: guanxi-spin var(--motion-duration-loop) var(--motion-easing-linear) infinite;
```

Build validation (English errors, fail closed): non-empty array; unique
`/^[a-z][a-z0-9-]*$/` utility names; unique keyframe names with the same pattern; duration
resolves to `motion.duration.*` with `$type: duration`; easing resolves to `motion.easing.*`
with `$type: cubicBezier`; iterations is `infinite` or a positive integer. The manifest is not
added to `guanxi.resolver.json` and does not become a DTCG token: the validator's supported
types are `color`, `dimension`, `duration`, `number`, `fontFamily`, `fontWeight`,
`cubicBezier`, `shadow`; there is no animation/string shorthand type, and inventing one is a
larger schema change than this finding requires.

### Why the existing tokens are insufficient

`motion.duration.*` and `motion.easing.*` are components, not an animation. There is no token
for the keyframe identifier or iteration count, and the validator cannot express a complete
shorthand. `motion.fade.*` only caps fade durations under reduced motion; it does not compose
a spinner, pulse or sheen. The scanner deliberately does not resolve `@keyframes` names, so a
scanned shorthand can never be made legal by adding a token name alone. The reusable point is
therefore the generated theme/utility layer, which is already excluded from source scanning
for every generated token and is owned by G2.

### Why this is not a scan bypass

- The only literals live in the authored manifest and generated `theme.css`; nobody hand-edits
  the generated file, and G2 rejects any drift.
- The build validates that each composition comes from existing accepted motion tokens.
- The scanner, context, ledger and ratchet logic are untouched; a new negative fixture proves
  a reintroduced literal shorthand still fails G6/G7.
- No local `--anim*` custom property, fallback value or alias bridge is added to scanned CSS.
  The generated `--animate-*` entries are theme tokens in the same namespace/reset as the
  existing `--ease-*` and `--default-transition-*` mappings.

### Alternatives considered (short)

- **Teach G6 to accept `@keyframes` names:** scanner weakening; prohibited.
- **Keep the literals, add ledger keys:** new allowance; prohibited.
- **Local custom property in `index.css`:** hidden alias/bypass; prohibited.
- **Drop all animation and stay static:** regresses accepted motion and weakens the browser
  matrix; the DS1-b static state was a temporary fallback, not the target.
- **Add a first-class DTCG animation type:** not supported by the validator/resolver; larger
  than the finding and still requires the generated utility/theme layer.

## Exact source changes

`packages/web/src/index.css` (generated CSS is not edited by hand):

- Delete `@keyframes guanxi-caret`.
- `.anim-spin` → one `@apply animate-spinner;` (no `animation` declaration).
- `.anim-pulse-soft` → one `@apply animate-pulse-soft;`.
- `.anim-fade-up` → one `@apply animate-fade-up;`.
- `.sheen::after` → one `@apply animate-sheen;`.
- `.stream-caret::after`: remove the `animation` declaration; keep `content`, size, margin,
  vertical alignment and `background: var(--color-background-accent)` as the static cue.
- Add one short English comment that generated `animate-*` utilities compose the motion
  tokens and that streaming text/caret are static.
- Keep the four keyframes and their frozen transform literals; the caret keyframe is the only
  removed keyframe. Keep the reduced-motion `animation: none !important` and
  `transition: none !important` branches unchanged.

`packages/ui/tokens/build.mjs`: read/validate the manifest in `generate`, pass the validated
compositions to `themeCSS`, and emit the four `--animate-*` lines. No other generated file
needs a new token; only `generated/theme.css` changes.

`packages/ui/tokens/motion-animations.json`: new authored manifest, exact values above.

## Ledger edit (shrink only)

`packages/ui/gates/legacy-allowlist.json`:

All keys below carry the prefix `G6|packages/web/src/index.css|` for G6 and
`G7|packages/web/src/index.css|` for G7.

- Delete these 14 G6 keys (all actual count 0):
  `--font-mono:'SF Mono', 'JetBrains Mono', ui-monospace, 'Menlo', 'Monaco', monospace`;
  `--font-sans:'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
  `animation-duration:0.01ms`; `animation-iteration-count:1`;
  `animation:guanxi-caret 1.05s step-end infinite`;
  `animation:guanxi-fade-up 0.16s ease-out`;
  `animation:guanxi-pulse-soft 1.6s ease-in-out infinite`;
  `animation:guanxi-sheen 1.4s ease-in-out infinite`;
  `animation:guanxi-spin 0.7s linear infinite`; `border-radius:3px`; `font-size:13px`;
  `line-height:1.5`; `transform:translateY(4px)`; `transition-duration:0.01ms`.
- Delete these 7 G7 keys (all actual count 0): `animation-duration:0.01ms`;
  `animation:guanxi-caret 1.05s step-end infinite`;
  `animation:guanxi-fade-up 0.16s ease-out`;
  `animation:guanxi-pulse-soft 1.6s ease-in-out infinite`;
  `animation:guanxi-sheen 1.4s ease-in-out infinite`;
  `animation:guanxi-spin 0.7s linear infinite`; `transition-duration:0.01ms`.
- Reduce `G6|packages/web/src/index.css|outline-offset:2px` from `5` to `4`.

That is 21 deletions + 1 decrement, never 22 deletions. No key is added or moved; no
`legacy-ratchet-policy.json` edit. Expected gate stats after the fix: G5 frozen `898` unchanged,
G6 frozen `112` (117 − 5 new shorthands), G7 frozen `10` (11 − caret `step-end`).

## Tests

**New / changed assertions (write first, observe red on current source):**

- `packages/ui/gates/u1c-css.test.mjs`:
  - `.anim-spin`, `.anim-pulse-soft`, `.anim-fade-up`, `.sheen::after` each have exactly one
    `@apply animate-*` and no `animation` declaration; exact utility names asserted.
  - `.stream-caret::after` has no `animation` declaration and keeps the accent background;
    `@keyframes guanxi-caret` is absent; each manifest keyframe name is declared exactly once
    in `index.css`, and exactly the four sanctioned `@keyframes` remain.
  - `generated/theme.css` has exactly the four `--animate-*` declarations above, each traceable
    to one manifest entry, and no `--animate-caret`; no raw `ms`/`cubic-bezier` literal in
    those declarations (only `var(--motion-*)`).
  - `index.css` has exactly two `animation` declarations, both `none` in the explicit and OS
    reduced branches; no scanned animation shorthand remains.
  - `legacy-allowlist.json` contains none of the 21 retired keys and `outline-offset:2px` is 4.
- `packages/ui/gates/gates.test.mjs`: manifests reject an unknown duration token and a
  duplicate utility name; a fixture with `animation: guanxi-spin 1s linear infinite` still
  fails G6 and G7; a fixture with `@apply animate-spinner` passes G5/G6/G7. This is the direct
  no-scanner-weakening invariant.
- `packages/ui/gates/foundations.test.mjs`: `animate-spinner`, `animate-pulse-soft`,
  `animate-fade-up`, `animate-sheen` compile; default `animate-pulse` stays removed by the
  namespace reset.
- `packages/web/test/browser/local-fonts.spec.ts`: keep the 12-case light/dark × OS
  no-preference/reduce × system/reduced/full matrix. The caret is asserted `animationName:
  none` in every cell and its computed background is non-transparent in every cell (static
  cue). Full cells assert `animationName` `guanxi-spin` / `guanxi-sheen`, both durations `1s`,
  and named running animations; reduced cells assert `none`, empty
  `getAnimations({ subtree: true })`, and `transitionProperty: none`. The explicit-full-under-
  OS-reduce positive control stays. No assertion is deleted to make this pass.

**Regression envelope (worker, scoped):** `node --test` on the three UI gate files;
`git diff --check`; scoped ESLint/stylelint if the implementation envelope permits. **Root
only:** fast `ui:check`, full `npm test`, Chromium browser gate, build/Storybook.

## Commands

| Step | Command | Who |
| --- | --- | --- |
| Contract pin | `node -e "console.log(require.resolve('@guanxi/contract'))"` must print this clone | worker |
| Red test | `nice -n 10 node --test packages/ui/gates/u1c-css.test.mjs` (fails before production) | worker |
| Token generation | `nice -n 10 npm run tokens:build --workspace @guanxi/ui` (writes generated files; not the heavy app build) | worker if root authorizes, else root |
| Focused green | `nice -n 10 node --test packages/ui/gates/u1c-css.test.mjs packages/ui/gates/gates.test.mjs packages/ui/gates/foundations.test.mjs` | worker |
| Fast gates | `nice -n 10 npm run ui:check --workspace @guanxi/ui` | root authorizes; otherwise root |
| Chromium matrix | `npm run test:web:browser` through the shared heavy lock | root only |
| Diff hygiene | `git diff --check` | worker |

No `npm test`, browser, build, Storybook, `agent-dev` or nested sandbox is run by this worker.
If `tokens:build` cannot be authorized, the worker stops before claiming G2 and root runs it;
the generated file is never hand-edited.

## Documentation touched

- `docs/design/FOUNDATIONS.md` §5: add the four semantic animation utilities and the static
  stream caret rule; state that streaming text never animates.
- `docs/design/COMPONENTS_AND_CATALOG.md` §8: replace the pre-fix "stay still until the
  generated theme offers a loop animation" sentence with the implemented generated
  `animate-*` utilities and the static caret; note that catalog component behavior is
  unchanged in this slice.
- `packages/ui/tokens/README.md`: document the manifest, build validation, generated
  `--animate-*` names and the rule that generated output is never hand-edited.
- `packages/ui/gates/README.md`: document that motion shorthands stay forbidden, reusable
  animations are generated theme utilities, and the caret is static.
- `docs/plans/lanes/U1c-css.handoff.md`: append (do not rewrite) a
  `## Review-fix: canonical motion utilities and ledger retirement (2026-10-22)` section with
  new/regression tests, exact commands/results, residuals and the fix commit hashes.

## Residuals / review points

- `packages/ui/src/styles/base.css` and `status-pill.css` still explain their static
  spinner/pulse by "no loop animation yet". That rationale is historical; changing those
  component files would change catalog source hashes and require `ui:manifest`, so this slice
  leaves them and names the follow-up component batch.
- The frozen keyframe transform literals (`rotate(360deg)`, `translateX(...)`) remain legacy
  debt; they are not new shorthand and are not used as a precedent.
- The caret's static block remains the visible streaming cue; the message text/live region
  remains the accessible cue. No status relies on motion alone.
- Worker cannot run Chromium; the 12-cell matrix and the fast `ui:check` result are root-owned
  evidence. The worker will not claim them.
- Integration into `/u1-completion` and the frozen `a4a42da` candidate is root-owned; this
  clone only commits on `codex/u1c-css`.

## Authorization boundary

This round changes only this plan file. The implementation round starts only after root
reviews this plan and authorizes: the manifest/build/generated/CSS/test/ledger edit, the
`tokens:build` step and, if granted, scoped fast `ui:check`. Without that authorization the
worker stops and reports the plan pin.
