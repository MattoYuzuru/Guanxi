# U1-b glossary continuation

**Status:** 12 target terms and their English/Russian entries are implemented with scoped
assertions; the browser rendered-count follow-up remains outside this lane. Independent review
is pending.
**Date:** 2026-10-22 · **Branch:** `codex/u1-glossary` · **Starting pin:** `86f1019` (clean)
· **Code head:** `0de614d1f1e0d9279de7b3be0dabe0b2a123ae19` (the handoff commit is
documentation-only on top).

Own Node 26 install; root's `npm ci` is used and `@guanxi/contract` resolves inside this clone
at `packages/contract/src/index.ts`. Ports 5208/4408 are documented local-only ports, but no
server was started. No model, owner data, workspace cleanup, SSH or external service was used.
No push, rebase, merge, central status edit or other UI edit was made.

This is a new lane handoff; no earlier claim is modified.

## Scope

Added `session`, `run`, `attempt`, `node`, `connection`, `workspace`, `block`,
`developer-mode`, `visual-mode`, `layout`, `side-chat` and `lease` to
`packages/web/src/lib/glossary.ts`, appended after the 17 legacy entries. Every legacy key,
term and copy remains in its original order and wording. The 12 new keys are unique.

Definitions describe target semantics without presenting proposed behavior as operational:

- Session is the lossless, append-only event container; it contains Runs and is not a Run or a
  Chat.
- Run is a durable unit of task work with one execution fence and a terminal state; Attempt is
  one fenced execution segment, and two Attempts of one Run never execute at the same time.
- Lease ownership changes only by a transaction on the granting Node (grant, release, expiry,
  fenced handover or audited admin break); a timeout stops renewal and never creates a second
  holder.
- Side chat reads a Session without writing to it, is ephemeral by default and exposes the
  explicit Save to session log / Send to main decision (D-135).
- Visual mode is an experience mode, not model autonomy: it grants the model no extra freedom,
  permissions or decisions.
- Workspace is a Session view and does not require a filesystem folder. The legacy Project
  "logical container, not a folder" copy is unchanged.
- No numeric caps, hardware figures or cost facts were added to the target definitions.

No product component (`Glossary.tsx`), token, locale-catalog, snapshot or browser-test file was
changed.

## Tests and evidence

Test-first: `localization.test.tsx` was extended before production changed; the expected red
showed the missing target keys and `session: undefined`. The entries were then added.

| Command | Result |
| --- | --- |
| `nice -n 10 npm exec --workspace @guanxi/web -- vitest run test/component/localization.test.tsx` | PASS: 1 file, 14/14 tests |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | PASS: exit 0, no diagnostics |
| `nice -n 10 npx eslint packages/web/src/lib/glossary.ts packages/web/test/component/localization.test.tsx` | PASS: exit 0, no diagnostics |
| `git diff --check` | PASS: exit 0 |
| `node -e "console.log(require.resolve('@guanxi/contract'))"` | `/Users/yuzuru/Projects/Guanxi-lanes/u1-glossary/packages/contract/src/index.ts` |

**New:** 12 target entries and one new component case, "keeps target term boundaries and owner
decisions explicit". The existing search case now asserts the retained legacy keys and order,
the 12 unique target keys, canonical EN/RU terms, new localized search hits in both locales,
retained legacy search, and non-empty term/definition/example copy for every entry in both
locales. The new case guards the Session/Run/Attempt boundaries, the Lease transition list and
second-holder rule, Side chat's ephemeral Save/Send choice, Visual mode's non-autonomy, the
Workspace/Project folder invariant, and the absence of numeric caps, currency or hardware
figures in the target definitions.

**Regression envelope:** the whole `test/component/localization.test.tsx` file, 14/14 tests,
ran green. Browser, full suite, build, Storybook and `agent-dev` were not run inside this DSH
sandbox, per the lane boundary.

## Residuals / next action

1. **Browser count is owned outside this lane.** `packages/web/test/browser/localization.spec.ts:212`
   asserts 17 rendered glossary articles after reload; the catalog now has 29 entries. This
   lane must not edit that file. Root/integrator should update the literal to 29 and run the
   browser gate. By copy inspection, the surrounding browser searches still match only their
   existing entries (`SPEED UP CONTINUATION` → `kv-cache`, `Диктовка ПРОМПТА` → `recipe`,
   absent query → 0).
2. Independent review is pending; the root GPT `design_review` is the separate reviewer. There
   are no review-fix commits yet.
3. Russian copy is curated here but not owner-reviewed. The `Lease` Russian term follows the
   untranslated `lease` wording already used by the runtime locale, so the glossary does not
   introduce a second production label for the same concept.
4. No live model, hardware, cost, network or owner data was observed or claimed.

## Review fixes

Independent review pending. Append findings and their fix commits here; do not rewrite the
claims above.

### 2026-10-22 review-fix round

Independent read-only review of clean `d39bd8dabfb836862177f3023350f977f4497439` reported four
P2 copy findings and the known browser-count follow-up in
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/codex-u1-glossary-20261022.md`. All five are fixed
on this branch in five separate commits; the historical claims above are unchanged.

**Count clarification.** The pre-fix evidence above is **14 total component cases = 1 newly
added case + 13 existing cases**, with the existing search case expanded. It was not 14 new
tests.

**New this round:** 1 component case, `interpolates the central product name into both Node
definitions`. The existing `keeps target term boundaries and owner decisions explicit` case
gained assertions for retention qualification, the Run execution slot/current grant, the
one-active-Attempt invariant and the Lease/Attempt example semantics. No new test files.
**Regression envelope this round:** `packages/web/test/component/localization.test.tsx` in full,
**15/15** (2 lane-new + 13 pre-existing cases). The browser change is one existing assertion,
not a new test.

| Finding | Fix commit | Change |
| --- | --- | --- |
| P2 Session retention | `84249939a8303911c5c5cb119582c1b431e1d282` | EN/RU definition and example qualify retained prompt/event/result data by the retention policy; no indefinite-retention promise (D-113, ADR-0023). |
| P2 Run fencing | `1d5291a1b920102d2bce83c54664447b06e4ba49` | Run EN/RU name one stable execution slot and the current fencing grant instead of one lifetime token; Attempt retains the single-active invariant (ADR-0018 §3). |
| P2 brand source | `56b90956cd9cdaf7d276c199c461652d8c246143` | Both Node definitions interpolate `PRODUCT_NAME` from `packages/web/src/lib/brand.ts`; no new literal product name, no key rename. A mocked brand name proves the interpolation. |
| P2 lease/attempt examples | `7266cffbb06396c47cb4815d90e20bd5a24dcdfd` | EN/RU examples end old ownership by grantor-confirmed expiry, release, fenced handover or an audited admin break, not expiry only; a timeout alone never creates a second holder. |
| Browser follow-up | `1db7d7a54c825b7f7fd8b390a19c23742d89acb5` | `packages/web/test/browser/localization.spec.ts:212` expects the exact 29 articles; the existing legacy search assertions are untouched. |

Only `packages/web/src/lib/glossary.ts`, `packages/web/test/component/localization.test.tsx`,
one assertion line in `packages/web/test/browser/localization.spec.ts` and this handoff changed.
No component, locale-catalog, legacy-key, CSS, motion-test or status file was changed.

### Commands (scoped; all run in this clone)

| Command | Result |
| --- | --- |
| `nice -n 10 npm exec --workspace @guanxi/web -- vitest run test/component/localization.test.tsx` | PASS: 1 file, **15/15** tests |
| `nice -n 10 npx tsc --noEmit -p packages/web/tsconfig.json` | PASS: exit 0, no diagnostics |
| `nice -n 10 npx eslint packages/web/src/lib/glossary.ts packages/web/test/component/localization.test.tsx packages/web/test/browser/localization.spec.ts` | PASS: exit 0 |
| `git diff --check` | PASS: exit 0 |
| `node --input-type=module -e "const { glossaryEntries, searchGlossary } = await import('./packages/web/src/lib/glossary.ts'); const keys = glossaryEntries.map((e) => e.key); console.log('count/unique', keys.length, new Set(keys).size); console.log('legacy-first', keys.slice(0, 17).join(',')); console.log('EN search', searchGlossary(glossaryEntries, 'SPEED UP CONTINUATION', 'en').map((e) => e.key)); console.log('RU search', searchGlossary(glossaryEntries, 'Диктовка ПРОМПТА', 'ru').map((e) => e.key));"` | `count/unique 29 29`; legacy-first is the unchanged 17-key order; EN search `['kv-cache']`; RU search `['recipe']` |

`node -e "console.log(require.resolve('@guanxi/contract'))"` still resolves to
`/Users/yuzuru/Projects/Guanxi-lanes/u1-glossary/packages/contract/src/index.ts`.

Test-first was followed per finding: each new assertion was run red before its production copy
changed, then green. No test was weakened; the browser count is corrected from 17 to 29.

### Residuals after this round

1. **Browser gate not run here.** DSH does not run Chromium, the browser suite, full `npm test`,
   build, Storybook or `agent-dev`. Root must run the affected
   `packages/web/test/browser/localization.spec.ts` and the full browser gate. The probe above
   confirms the two retained searches still select exactly one legacy entry.
2. Russian copy remains curated but not owner-reviewed; the `Lease` term is unchanged from the
   existing runtime label.
3. No live model, hardware, cost, network, owner data, SSH or external service was observed or
   claimed. This glossary is copy evidence only, not acceptance evidence for unimplemented
   side-chat, remote execution, new-session or owner-approved component work.
