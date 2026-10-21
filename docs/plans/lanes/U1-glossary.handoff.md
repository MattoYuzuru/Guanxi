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
