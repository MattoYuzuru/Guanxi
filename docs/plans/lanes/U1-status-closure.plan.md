# U1 component lifecycle dependency closure — review repair

**Status:** root-authorized bounded repair · **Updated:** 2026-10-22
**Base:** `6c8aa1f26964e89bc754c013acbbd9998244b273`

Independent U1 review confirmed a P2: product AppShellChrome uses draft IconButton/Menu,
and IconButton uses draft Tooltip. COMPONENTS_AND_CATALOG section4 applies to product use
through a wrapper too. Current G11 checks direct named imports only and misses this chain.
Fix the enforcement gap; do not weaken the policy or promote any component as a shortcut.

## Implementation contract

Own G11 and a small catalog-tooling dependency helper, proportional tests/seeded fixtures,
and this lane's handoff/docs. Preserve direct scanUsage/manifest usage-count meaning if
possible: G11 may separately expand component dependencies after direct product attribution.
No UI primitive, review record, approval, signature, snapshot, token, suppression, server,
dependency or lockfile changes. Root owns the separate readiness review for the three drafts.

Starting from each directly used catalog component, traverse runtime local imports/reexports
through its implementation and UI-local helpers into other component folders. Use actual
TypeScript syntax/module resolution, not regex matching or a hand-maintained allowlist.
Skip type-only imports/exports and non-code assets; follow named aliases, local barrels and
value dependencies. Do not traverse stories/tests or third-party packages. Resolve only
within the UI source root; unsupported/unresolvable runtime component dependencies cannot
silently become an approval bypass. Preserve existing unknown/star/deprecated behavior.

For every reachable component apply its actual lifecycle status to the original product
file. Draft/invalid/deprecated errors block ordinary slices; review/stale warn ordinarily
and error for release. Deduplicate component/file pairs; cycles terminate. Catalog-only
draft usage remains allowed. Do not treat an approved/review parent as approval of a child.

## Required discriminating evidence

- Reviewed wrapper -> draft child fails G11 with the child ID and original product file.
- Two-hop actual-style wrapper -> icon -> tooltip and a helper/barrel/aliased value import
  cannot hide the draft; graph cycles terminate with correct deduplicated findings.
- The same graph after all dependencies are unsigned review yields warnings for ordinary
  slices and errors for release. This is fixture-only status data, never real promotions.
- Type-only edges, external dependencies and unreachable catalog-only drafts do not cause
  false product errors; existing direct/alias/unknown/deprecated seeded cases remain green.
- Actual mounted branch now reports IconButton/Menu/Tooltip draft use. This expected policy
  failure is evidence, not a failed repair to silence. U1 integration waits for readiness fixes.

Commit a semantic red test before the minimal implementation and run the identical targeted
command after. Preserve existing signatures/history and scanner rules. No benchmark or
product behavior changes. Independent Sol review follows, fixes in separate commits.

## Environment and handoff

Standalone clone `codex/u1-status-closure`; Node 26, own dependencies. Root installs first.
DSH runs pure targeted node tests, UI tsc and scoped static lint only, with nice priority;
no browsers, containers, full suites or shared agent-dev commands inside its sandbox.
Root/reviewer use shared `/Users/yuzuru/.local/state/agent-dev`, resource heavy, local Mac.
Freeze source throughout queued/running checks. No SSH, provider/model, owner data/key or push.

Write U1-status-closure.handoff.md with exact commits, new/envelope and red/green outcomes,
actual expected draft errors, unrun checks and residuals. Root alone updates central status.
Rollback removes only the additive enforcement repair; it cannot mark the blocked U1 mount
ready. Unsigned review readiness and owner-signed stage acceptance remain separate.
