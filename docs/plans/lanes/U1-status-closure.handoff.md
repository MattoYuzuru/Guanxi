# U1 transitive lifecycle closure — lane handoff

**Status:** original repair and independent-review repair implemented and locally validated; the
actual G11 gate is expected to FAIL until the owner's separate readiness decision; independent
GPT 6.1 Sol / high re-review, full gates and merge remain root-owned. No push, merge, rebase,
`PHASE_STATUS` or `NEXT_AGENT_PROMPT` edit.
**Date:** 2026-10-22 · **Branch:** `codex/u1-status-closure` · **Base:** `6c8aa1f2`
**Plan:** `docs/plans/lanes/U1-status-closure.plan.md` (`308ede3e`; review repair authorized
at `873c717c`)

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
- At the time of the first handoff this clone had no `main` ref, so the full extension file's G12
  case failed for setup rather than source. The independent reviewer later created only the
  trusted local `main` object `1b6f495f5d0ecf70621fddf820e76fdf0de6c253` after an ancestry check;
  that ref is preserved. The appended repair run exercises the full extension file, 7/7.
- The first independent review at `a3160507` found two P2 bypasses in this helper; the repair is
  in the appended section. A fresh independent re-review of the repair is reserved for
  GPT 6.1 Sol / high. `scanUsage` and manifest usage counts remain direct-only by design.
- `export *`, namespace imports and named re-export barrels are followed at module granularity,
  so the helper can conservatively over-report components exported from a reachable barrel; this
  is fail-closed, not an approval bypass. Computed dynamic imports are reported as unresolved
  rather than resolved.

## Rollback / next

Rolling back `a85ca9e8` (and the test-only commits if desired) removes the additive enforcement
repair and restores the old direct-import blind spot. It cannot mark the blocked U1 mount ready.
The next slice is the owner/root readiness review for the reachable drafts above, followed by the
full gates and the reserved independent review; this lane does not merge or push.

## Independent-review repair (2026-10-22)

The outside review at `a3160507` (`codex-u1-status-closure-20261022.md`, receipt
`check-_bw41_op`) confirmed two P2 bypasses. This section is the bounded repair. Only
`packages/ui/catalog/tooling/dependencies.ts`, the two existing dependency test files, one new
G11 fixture and this handoff changed. `g11-status-policy.ts`, component sources and statuses,
review records, signatures, snapshots, approvals, the manifest, `scanUsage` counts, dependencies
and server code are untouched.

### Behavior

- A runtime named import/export now traverses the imported or re-exported module itself before
  relying on the checker-resolved binding. The module's own side-effect imports, named
  re-exports and aliases are evaluated, so `A -> barrel (named B) + barrel -> C` yields
  `A/B/C` even when A never uses C. The resolved declaration is still visited as before.
- The checker still distinguishes value from type-only bindings. Explicit `type` imports/exports,
  namespaces/star re-exports, aliases, cycles and file/component deduplication keep their prior
  behavior.
- A resolved relative code import outside `packages/ui/src` is now returned in `unresolved` with
  the importer (UI-root-relative) and original specifier. It is not followed and is not
  reclassified as an external package; G11's existing unresolved-edge error fails closed.
- Non-code assets, external packages, stories/tests and computed dynamic-import handling are
  unchanged.

### Commits

| Commit | Purpose |
| --- | --- |
| `29f1327f` | `test(ui): cover named-barrel evaluation and out-of-root edges` — 3 pure helper cases, 1 G11 case and the `transitive-barrel-side-effect` fixture |
| `f0e5d8af` | `fix(ui): follow named-barrel runtime edges and reject outside imports` — helper only |
| handoff commit after `f0e5d8af` | this appended evidence |

### Red / green (identical commands where noted)

Red at `29f1327f`, before the helper fix:

```text
nice -n 10 node --test packages/ui/gates/catalog/test/dependencies.test.ts
  5 pass / 3 fail
  named-import barrel: actual [a,b], expected [a,b,c]
  named-export barrel: actual [a], expected [a,c]
  out-of-root import: actual unresolved [], expected
    [{file: "src/components/a/a.tsx", specifier: "../../../outside.ts"}]

nice -n 10 node --test packages/ui/gates/catalog/test/g11-dependencies.test.ts
  7 pass / 1 fail
  named-barrel case: actual errors [], expected ["g11-barrel-draft"]
```

Across the two changed files: 12 pass / 4 fail, exactly the four new regressions.

Green at `f0e5d8af`:

| Command (`nice -n 10`) | Result |
| --- | --- |
| `node --test packages/ui/gates/catalog/test/dependencies.test.ts` | PASS, 8/8 |
| `node --test packages/ui/gates/catalog/test/g11-dependencies.test.ts` | PASS, 8/8 |
| `node --test packages/ui/gates/catalog/test/dependencies.test.ts packages/ui/gates/catalog/test/g11-dependencies.test.ts packages/ui/gates/catalog/test/gates.test.ts packages/ui/gates/catalog/test/extension.test.ts` | PASS, 34/34, zero fail/skip/cancel, 25.7 s |
| `npx tsc --noEmit -p packages/ui/tsconfig.json` | PASS, exit 0 |
| `npx eslint` on the changed helper and test files | PASS, exit 0; the fixture sources are ignored by the repo ESLint config (7 ignore warnings, 0 errors) |

**New:** 4 repair tests (3 pure helper + 1 G11 gate case) plus the `transitive-barrel-side-effect`
fixture (reviewed wrapper, reviewed leaf, draft leaf, helper barrel, product use). The fixture is
exercised by the direct G11 case; it was not added to `g11.seeded`, so G17's registered-seed scope
is unchanged.

**Regression envelope:** the other 30 tests in the identical four-file scope (12 from the earlier
`a85ca9e8` repair, 18 inherited) all pass. The 34/34 count is the targeted catalog scope, not a
full suite.

### Actual G11 remains red for real drafts

`node packages/ui/gates/catalog/run.ts --mode fast --only G11` exits **1** with 8 errors and 12
warnings. The required real draft errors are still present, now at the original product files:

```text
error icon-button    packages/web/src/features/shell/MountedShell.tsx
error menu           packages/web/src/features/shell/MountedShell.tsx
error menu           packages/web/src/features/workspace/Workspace.tsx
error tooltip        packages/web/src/features/shell/MountedShell.tsx
error tooltip        packages/web/src/features/shell/ShellPalette.tsx
error tooltip        packages/web/src/features/workspace/Workspace.tsx
error textarea       packages/web/src/features/workspace/Workspace.tsx
error empty-state    packages/web/src/features/workspace/Workspace.tsx
```

These are expected policy failures, not a failed repair. No component was promoted, no record or
approval was changed, and U1 still waits for the separate readiness decision.

### Outside controls

- The frozen original probe `/Users/yuzuru/Projects/Guanxi-lanes/reviews/u1-transitive-usage-review.ts`
  was not edited; its SHA-256 is still
  `82a8a9f04cc19d07d9b8ef9eaffca81c3643f0e1666792b32926fd9c8148b842`. It was not run here; its
  global-three-ID assertion remains obsolete because the correct closure also reports other
  product files. Independent Sol must rerun the original controls independently.
- The reviewer's boundary probe `u1-g11-independent-boundaries-20261022.ts` was rerun locally as
  an author diagnostic: **4/4 pass**, including the two former P2 failures. This is not an
  independent review and does not replace Sol's rerun.
- No outside probe was modified. `refs/heads/main` is still exactly
  `1b6f495f5d0ecf70621fddf820e76fdf0de6c253`, an ancestor of HEAD; the reviewer-created ref was
  preserved.

### Not run / residuals

- No browser gate, Storybook, visual snapshots, build, full `npm test`, full workspace typecheck,
  `npm run ui:check` or `npm run ui:catalog:selftest`, and no shared-lock/`agent-dev` run.
  Root/reviewer own those checks. No provider/model, network, SSH, push or owner-data action.
- A named re-export barrel is now traversed at module granularity, joining the existing
  namespace/star conservative over-reporting. This is fail-closed, not an approval bypass.
- The existing G11 unresolved-edge wording says "cannot resolve" for a resolved out-of-root file;
  the finding still carries the importer and specifier and fails closed. Message splitting is
  cosmetic and was not part of this bounded fix.
- Non-relative local aliases are still treated as external by design; the repaired boundary is
  resolved relative runtime imports. Computed dynamic imports remain unresolved diagnostics.
- The new fixture is not a G17 seed; the direct G11 regression covers it in the 34-case scope.
- Independent review of this repair is still pending. No full U1, MS1, main or approval claim is
  made; this lane does not merge or push.
