# U1 transitive lifecycle closure — lane handoff

**Status:** repair implemented and locally validated; the actual G11 gate is expected to FAIL
until the owner's separate readiness decision; independent GPT 6.1 Sol / high review, full gates
and merge remain root-owned. No push, merge, rebase, `PHASE_STATUS` or `NEXT_AGENT_PROMPT` edit.
**Date:** 2026-10-22 · **Branch:** `codex/u1-status-closure` · **Base:** `6c8aa1f2`
**Plan:** `docs/plans/lanes/U1-status-closure.plan.md` (`308ede3e`)

## Finding

The independent read-only reproduction
`/Users/yuzuru/Projects/Guanxi-lanes/reviews/u1-transitive-usage-review.ts` failed 0/1 at the base:
G11 returned PASS while product code imported the unsigned `review` wrapper `AppShellChrome`,
which renders draft `IconButton` and `Menu`, and `IconButton` renders draft `Tooltip`. G11 only
attributed direct named `@guanxi/ui` imports, so the wrapper hid the three drafts.

The original probe was read, not edited. Its actual-chain assertions were adapted into this clone
as the first case of `packages/ui/gates/catalog/test/g11-dependencies.test.ts`.

## Repair (commit `a85ca9e8`)

- `packages/ui/catalog/tooling/dependencies.ts` — a catalog-tooling helper that expands each
  directly used component through its implementation and UI-local runtime value imports and
  re-exports with the TypeScript checker and module resolver. It follows named aliases, default
  and namespace imports, local helpers and barrels, and `export *`; cycles terminate through a
  visited-file set. Type-only imports/exports, stories/tests, non-code assets and external
  packages are not traversed. Runtime relative imports that do not resolve under the UI source
  root — and computed dynamic imports — are returned as unresolved and fail G11 closed.
- `packages/ui/gates/catalog/g11-status-policy.ts` — after the existing direct attribution, G11
  applies every reachable component's own status at the original product file. Component/file
  pairs are deduplicated. A reviewed parent is not approval for a child. Direct
  `scanUsage`/manifest usage-count semantics are unchanged; the manifest was not regenerated.
- No catalog component source, review record, approval, signature, snapshot, token, suppression,
  dependency, lockfile, server, `PHASE_STATUS` or `NEXT_AGENT_PROMPT` file changed.

## Tests and evidence

**New:** 12 cases, 3 seeded violations and 6 seeded fixtures.

- `packages/ui/gates/catalog/test/g11-dependencies.test.ts` — 7 cases: the actual mounted-shell
  chain; reviewed wrapper → draft child with the child ID and original product file; two-hop
  helper/barrel/alias → draft `IconButton` and `Tooltip`; a component cycle with one deduplicated
  finding; all-review fixture warnings in ordinary mode and errors in release mode; type-only and
  external edges ignored; catalog-only draft use allowed.
- `packages/ui/gates/catalog/test/dependencies.test.ts` — 5 pure helper cases: helper barrel,
  alias and two-hop value imports; cycle termination; type-only/story/test/external skipping;
  unresolved relative import reporting; computed dynamic import reporting.
- `g11` seeded fixtures `transitive-reviewed-wrapper`, `transitive-helper-alias`,
  `transitive-cycle`, `review-graph`, `transitive-safe` and `catalog-only-draft`.

**Red / green (identical command):**

```text
nice -n 10 node --test packages/ui/gates/catalog/test/g11-dependencies.test.ts
red:   2 pass / 5 fail  (actual chain returned no draft errors)
green: 7 pass / 0 fail
```

The red test commit is `6af65c08`; `53a6fee5` only matches the registration adapter's flattened
diagnostic to the actual G11 message. The fix follows in `a85ca9e8`.

**Regression envelope (pre-existing tests):**

| Command (`nice -n 10`, Node 26.9.0) | Result |
| --- | --- |
| `node --test packages/ui/gates/catalog/test/dependencies.test.ts` | PASS, 5/5 |
| `node --test packages/ui/gates/catalog/test/g11-dependencies.test.ts` | PASS, 7/7 |
| `node --test packages/ui/gates/catalog/test/gates.test.ts` | PASS, 11/11 (existing G10/G11/G12/G15 seeds and scaffold) |
| `node --test --test-name-pattern='G11' packages/ui/gates/catalog/test/extension.test.ts` | PASS, 1/1 |
| `npx tsc --noEmit -p packages/ui/tsconfig.json` | PASS, exit 0 |
| `npx eslint` over the changed helper, gate and test files | PASS, exit 0 |

The existing direct, alias, utility-laundered, unknown-export and deprecated G11 seeds remain
green. `npm run ui:check`, browser gates, Storybook, snapshots, the full suite and `agent-dev`
were not run in this sandbox.

## Actual expected policy failure

`node packages/ui/gates/catalog/run.ts --mode fast --only G11` exits **1** on the actual checkout
(8 errors, 12 warnings). This is the repaired gate reporting real draft usage, not a failed
repair. The three required reachable drafts are:

```text
error icon-button packages/web/src/features/shell/MountedShell.tsx
error menu      packages/web/src/features/shell/MountedShell.tsx
error tooltip   packages/web/src/features/shell/MountedShell.tsx
```

The same closure also reports other genuinely reachable drafts: `menu`, `tooltip`, `textarea`
and `empty-state` from `packages/web/src/features/workspace/Workspace.tsx`, and `tooltip` from
`packages/web/src/features/shell/ShellPalette.tsx`. Those are additional expected blockers for
the readiness review, not promotions.

## Untouched status warning

`icon-button`, `menu` and `tooltip` remain `draft` in their review records, with no approval or
signature. `AppShellChrome` remains unsigned `review`. No shortcut was taken to make G11 green:
the actual gate must stay FAIL until the owner's separate readiness decision and the root's full
gates. U1 integration is blocked on that readiness, not on this repair.

## Not run / residuals

- No browser gate, Storybook, visual snapshots, build, full `npm test`, full workspace typecheck
  or shared-lock/`agent-dev` run. Root/reviewer own those checks.
- The full `extension.test.ts` file has a pre-existing G12 failure in this standalone clone:
  G12 needs a `main`/`origin/main` base ref, and this clone has only the lane branch. The G11
  registration case passes.
- `export *` and namespace imports are followed at module granularity, so the helper can
  conservatively over-report components exported from a reachable barrel; this is fail-closed,
  not an approval bypass. Computed dynamic imports are reported as unresolved rather than
  resolved.
- No independent review has been performed yet; GPT 6.1 Sol / high review is reserved.
  `scanUsage` and manifest usage counts remain direct-only by design.

## Rollback / next

Rolling back `a85ca9e8` (and the test-only commits if desired) removes the additive enforcement
repair and restores the old direct-import blind spot. It cannot mark the blocked U1 mount ready.
The next slice is the owner/root readiness review for the reachable drafts above, followed by the
full gates and the reserved independent review; this lane does not merge or push.
