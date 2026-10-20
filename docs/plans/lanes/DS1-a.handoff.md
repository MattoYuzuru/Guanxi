# DS1-a hand-off

**Status:** Ready to merge with `--no-ff`. Review 2 fixes and K1 sidebar integration are locally validated; all required checks pass.
**Date:** 2026-10-20. **Branch:** `lane/ds1-a-tokens`.
**Worktree:** `/Users/yuzuru/Projects/Guanxi-lanes/ds1-a`.

The original delivery and validation below are historical. **Final K1 sidebar integration**
supersedes earlier validation counts, the K1 blocker and integration status. Review 2's
deferred follow-ups and required merge protocol remain applicable.

## Delivered

- DTCG 2025.10 sources, resolver and pinned Style Dictionary 5.7.0 build: four themes,
  two densities, full/reduced motion, three materials and strong material. Values follow
  FOUNDATIONS including the owner's `718240c` addendum. No material/density value remains open.
- Five committed outputs under `packages/ui/generated/`: runtime CSS, Tailwind v4 theme,
  typed TS map, MCP Apps variables and flat catalog JSON. `npm run tokens:build` regenerates
  all five. Theme rules preserve other modifiers; compiled Tailwind utilities avoid cyclic
  aliases and preserve the 4 px grid and 21.9% app-tile radius.
- Unmodified upstream Plex Sans Variable 0.2.0 and Mono 2.5.0 WOFF2 slices, upstream
  `unicode-range`, local URLs, OFL files, checksums and third-party notices. No optional
  companion pack or Plex npm package ships. Logo SVG/PNG assets are unchanged copies of the
  repository's brand source.
- Extensible G1–G7 runner and scoped G17. Fast checks never launch browser extensions;
  `node packages/ui/gates/run.mjs --browser` runs registered browser checks and their seeds.
  Later lanes append `extensions/*.gate.mjs`; see `packages/ui/gates/README.md`.
- Legacy `--warning` and `--focus` map to new semantic tokens. Other legacy classes and
  palette definitions are unchanged. G5/G6/G7 freeze 1,288 / 145 / 18 occurrences.

## Exit gate — new evidence

**14 new node tests / 6 new built-app browser tests.** These are separate from the regression
envelope below; `npm test` does not implicitly run `test:gates`.

| Requirement | Failing assertion / local result |
| --- | --- |
| G17 rejects every seed | Seven actual checkers fail with their specific expected diagnostic; a checker that accepts its seed makes G17 fail. |
| G1 valid sources | 233 tokens in all 16 contexts; wrong types, broken/type-mismatched aliases, invalid DTCG names and missing/inconsistent fallbacks fail. |
| G2 catches manual edits | Two in-memory generations are byte-equal; adding a byte to each of the five outputs fails G2. |
| G3 all pairs and HC | 456 measurements: 18 pairs × four themes plus normal/strong materials × eight extreme backdrops. HC measurements are all ≥7:1. Transparent foreground/background/material regressions fail. |
| Recorded contrast reproduced | Light text/muted/control/accent: 14.43 / 4.72 / 3.51 / 5.12. Dark: 14.61 / 7.01 / 4.09 / 8.39. Exact two-decimal assertions pass. |
| G4 zero unresolved | Explicit `unresolved === 0`; removing either original compatibility definition fails G4. |
| G5–G7 and freeze | Palette, arbitrary/unknown classes, constants, cva variants, CSS apply, CSS font shorthand, raw CSS/TS motion and timing functions fail. New/invalid/unused allowances fail. |
| No non-local fonts | A temporary production build serves on an OS-assigned loopback port. Actual Latin/Cyrillic/Sans Greek loads occur, zero font requests have another origin, zero font loads fail. A blocked injected external font is detected. |
| Mode/material correctness | Built-browser assertions cover all themes, densities and motion modes under light/dark OS and increased contrast. Mandatory Solid has opaque Solid fill/border, no blur/grain on root and strong descendants. Legacy class selection is independent of OS colour scheme. |
| Compiled theme works | The real pinned Tailwind compiler produces styles yielding IBM Plex Sans, 8 px gap and 21.9% radius in Chromium. |
| Asset provenance | Every WOFF2/OFL checksum matches the upstream manifest, only the two core families ship, and every copied logo matches its repository source. |

## Commands and regression envelope

Validation targets the current Mac, Node 26.9.0. Each shell exported
`GUANXI_WEB_PORT=5182`, `GUANXI_API_PORT=4382`, and `GUANXI_DATA_DIR="$PWD/.lane-data"`.
The built-font test's extra static server binds loopback port 0 and closes its own listener.
No live model, GPU inference, external API, or owner data directory was used.

`npm install --ignore-scripts` and `npm ci --ignore-scripts` ran in this worktree; resolving
`@guanxi/contract` prints this worktree's `packages/contract/src/index.ts`. The generated
local lockfile was restored per lane policy; the integrator must regenerate it at merge.

Final behaviour validation was at `e1ae283`; subsequent edits add this hand-off, an explicit
modified-stylesheet attribution comment and a stronger font-inventory assertion only.

| Command | Result / receipt |
| --- | --- |
| `npm run tokens:build` | Five files generated; byte freshness/determinism assertions pass. |
| `npm run ui:check --silent` | G1–G7 + G17 green; scope `fast`, seven seeds, zero unresolved variables. |
| `npm run test:gates --workspace @guanxi/ui` | 14 passed, zero failed/skipped. |
| `npm run typecheck` | All five workspaces passed. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy -- npm test` | 681 core/CLI + 261 web tests passed; 29 web files. Receipt `~/.local/state/agent-dev/check-0wfn237t/result.json`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy -- npm run test:web:browser` | 46 passed: **6 new / 40 regression envelope**. Receipt `~/.local/state/agent-dev/check-py04rlpc/result.json`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy -- npm run build` | Web, server and CLI builds passed. Receipt `~/.local/state/agent-dev/check-hi8yw0kj/result.json`. |
| `npm run lint:md` | Zero errors in 95 files, including this hand-off. |
| `npm run check:licenses` | 358 installed packages, zero not allowed. Vendored fonts are separately checked against their upstream OFL provenance. |

All heavy checks used the shared lock. Receipts report unchanged source during execution and
real exit code 0, but mark source verification/reuse unavailable because the repository's
existing `.claude/skills/guanxi-ui` symlink is unsupported by `agent-dev` fingerprinting.
These are local execution results, not reusable source-bound or production evidence.
Earlier failed attempts (missing Chromium after an unlocked install, temporary static-server
test bugs, and a duration-unit assertion) were fixed; they are not counted as passing evidence.

## Independent verification and fixes

A fresh-context, read-only reviewer inspected `ee06936..52c104f` for correctness, determinism,
licensing and claimed-but-unproven properties. It found seven defects: theme rules resetting
other modifiers, strong material bypassing Solid, legacy Light following OS dark, alpha ignored
by contrast, missed cva constants, missed font/timing shorthands and invalid DTCG names.

- `52c104f` — initial implementation, fonts/attribution and tests.
- `cd07c9c` — token/literal gate fixes, browser/fast split and owner-authorized freeze correction.
- `5c8a744` — orthogonal theme modes, legacy class compatibility and mandatory Solid.
- `e1ae283` — compiled-theme alias/radius fixes and rendered Solid fill/border assertions.

The reviewer verified all seven fixes at `5c8a744`, including the exact freeze-correction
hashes, then reviewed `e1ae283` and reported **no further findings**. No reviewer edited code.
Cross-family review remains the integrator's next action, as specified by the lane protocol.

## Authorized baseline correction

The first scanner missed six lexical occurrences in the unchanged legacy `INPUT_CLASS`
constant. The owner explicitly authorized correcting the initial baseline in this chat on
2026-10-20. Six old false positives were removed, so the total remains 1,451. The exact
before/after snapshots and six increases are recorded in `legacy-ratchet-policy.json`.
Only that hash-bound transition is allowed; subsequent per-value allowances may only shrink,
including across committed history. No legacy class name was rewritten.

## Shared edits, residuals and next slice

- Shared root edits are only the two requested scripts and Plex notice entries.
- The CSS-only legacy compatibility fix imports runtime tokens/fonts and defines the two
  missing aliases. The sole additional web path is the explicitly required Playwright test,
  `packages/web/test/browser/local-fonts.spec.ts`; no existing test was weakened.
- No components, catalog, approvals, ESLint, phase-status or next-prompt files were edited.
- **Canonical documentation correction proposed:** FOUNDATIONS §2.1 says Mono covers Greek,
  but IBM's shipped Mono archive contains only π, not the Greek alphabet. Keep the OS mono
  fallback and correct that sentence at integration. Sans Greek is shipped and network-tested.
- The only designated preload candidates are Sans Roman Latin1 and Mono Regular Latin1;
  consumer HTML preload integration belongs with the catalog/client wiring. No extra script
  pack or font conversion is proposed.
- HC status/categorical foregrounds use the existing ≥7:1 neutral, with labels/dashes required;
  no unapproved HC hue was invented. The source recipes and supported resolver subset are
  documented in `packages/ui/tokens/README.md`.
- Next: integrator cross-family review; merge in lane order; regenerate `package-lock.json`,
  rerun gates, then fold this evidence into PHASE_STATUS/NEXT_AGENT_PROMPT. DS1-b consumes the
  generated outputs and appends its gates; DS1-c owns lint integration and the legacy codemod.

`main` was merged through `ee06936` (including `718240c`); the final pre-hand-off merge was
already up to date. No push was performed.

## Review 1 fixes

**Status:** implemented and locally validated; all required checks passed.
**Code revision:** `bb3758c`; only this hand-off changed after the final checks.
Review source: the integrator's `ds1-a-review/REVIEW-1.md`, reviewed baseline `2ef69a1`.
`main` was already merged in `559a6a1`, including OFL authorization `11166df` (M8).

### Findings and assertions

Test references below are in `packages/ui/gates/` unless explicitly marked browser. The tests
name the finding IDs; each assertion rejects the reported violation or fails when the required
behavior disappears. M6's missing roles and L4–L6 are the explicitly authorized proposals and
residuals described below.

| Finding | Status and fix commit | Failing-when-violated test / residual |
| --- | --- | --- |
| H1 | Done — `18452ec`, `d5460e5` | `ratchet.test.mjs`: independent branch shrinks merge; restoring either parent's occurrence fails; deleting/recreating the ledger fails. Actual commit parents are checked. |
| H2 | Done — `63ddf94` | `foundations.test.mjs`: runtime font/spacing names cannot collide with Tailwind. Browser `H2: importing runtime tokens preserves legacy computed fonts and spacing` compares the built app with a build omitting only that import. |
| H3 | Done — `63ddf94`, `d77d371`, `83575db` | `scanner-review.test.mjs`: bound/nested maps, element/property access, lexical scopes, spreads, helper conditions and function returns; `*ClassName` props; every lexical legacy arbitrary class covered. `ratchet.test.mjs`: two exact corrections accepted; changed snapshots, a third entry, replay and duplicate introductions rejected. |
| M1 | Done — `63ddf94` | `gates.test.mjs`: every font URL is relative and in `sources.json`, external/unlisted mutations fail. Browser `M1` loads all 32 `document.fonts` entries, asserts 32 loaded, 32 distinct local requests and zero failures/external origins. |
| M2 | Done — `63ddf94`, `83575db` | `foundations.test.mjs`: FOUNDATIONS tables checked across all 16 contexts; negative ramp/duration/easing/fill/Solid-border/data-alias mutations fail. Covers ramps, statuses, data, radii, spacing, density, motion and material levels. |
| M3 | Done — `63ddf94` | `scanner-review.test.mjs` `M3`: both `bg-(--made-up)` and typed shorthand fail G4/G5; a declared variable resolves in JS. |
| M4 | Done — `63ddf94`, `c7cbbb5`, `9282b46` | `foundations.test.mjs` `M4`: removed default namespaces cannot compile; semantic replacements/defaults asserted. Scanner `M4` tests raw `@apply` motion rejection and all 17 semantic easing/duration/delay utilities accepted in JSX and CSS. |
| M5 | Done — `63ddf94` | `scanner-review.test.mjs` `M5/L3`: each formerly excluded feature-directory name still reports violations. Special authoring exclusions are anchored to `packages/ui/`. |
| M6 | Done; missing roles proposed — `63ddf94`, `83575db` | `foundations.test.mjs` `M2/M6`: Glass/Tinted border absent; Solid step-8/HC step-11 border and edge/seam colors/alpha asserted. Remaining MCP roles are proposed below. |
| M7 | Done — `63ddf94` | `gates.test.mjs` `M7`: root test script must run both fast gates and gate tests before core regressions. Both also execute during the locked `npm test`. |
| M8 | Done — `11166df` via `559a6a1` | Accepted ADR-0016 now permits unmodified OFL fonts; checksum/OFL provenance tests and `check:licenses` pass. No new license exception was introduced here. |
| M9 | Done — `18452ec` | `ratchet.test.mjs` `M9`: split/move keeps exact gate/value/count, rejects count growth, changed values and partial-source-key transfers. |
| L1 | Done — `63ddf94` | `foundations.test.mjs` `L1`: copy resolver to a path with spaces, assert decoded root and successful resolution (`fileURLToPath`). |
| L2 | Done — `18452ec`, `83575db` | `ratchet.test.mjs` `L2` / `H3/L2`: committed and working-tree policy rewrites/removals fail; a correction cannot grant repeated growth. |
| L3 | Done — `63ddf94`, `bb3758c` | `scanner-review.test.mjs` `L3` / `M5/L3`: listed CSS properties and nested raw `var()` fallbacks rejected, including case-insensitive zero-valued color functions; HTML/JSX/SCSS and JS variable references scanned. |
| L4 | Residual | Nested theme regions inherit root-computed material recipes and legacy `--warning`; isolated nested theme support needs a later recipe/compatibility change. |
| L5 | Residual / integration proposal | Keep the web relative token import until DS1-b adds the UI dependency; switch to `@guanxi/ui/tokens.css` then. Add an MCP variable-map export path when wiring that consumer. |
| L6 | Proposed owner decision | HC currently uses the same neutral foreground for accent, statuses and data. Retaining hue with approved HC values remains an owner choice; labels/dashes are required meanwhile. |
| L7 | Done — `63ddf94`, `83575db` | `scanner-review.test.mjs` `L7`: off-scale padding, gaps, logical offsets, scroll margins/padding and indents fail in JSX and `@apply`; legal scale/zero cases pass. |

### Correction #2 and the ratchet

The second and final owner-authorized rebaseline was committed in `63ddf94`, after the scanner
fix, against unchanged legacy source at `2ef69a1`. The immutable policy records:

- correction #1: `add42e20ec27bce93a3875c5102a28312f0a32323be83856e36ad644068068fc`
  → `3d40852098f06aecd9947f85630f882296ce651a2667f85bfec1d49cc3f719f8`;
- correction #2: `3d40852098f06aecd9947f85630f882296ce651a2667f85bfec1d49cc3f719f8`
  → `e1c37488d05d75c88b703cf41ed5091dcce328486f99adf6b8af62a95a2cee65`.

No third correction or policy hash rewrite was made. `c7cbbb5` only removes the false-positive
`ease-linear` G7 allowance, producing current snapshot
`98547a86720fb2c40f854b7279c7c202b3abff08b911da574a8dca89c3cfb260`.
Scanner counts exactly match it: G5 **1,543**, G6 **152**, G7 **17**. Subsequent changes may
shrink or relocate exact rule/value budgets; correction exceptions apply only on their policy
introduction edges. A retired allowance cannot return by replaying an old correction, deleting
the ledger or rewriting policy history.

### Fresh review and evidence

A separate self-review inspected the whole `git diff 2ef69a1..HEAD`, including the merged
main documentation. A fresh-context read-only reviewer independently checked the same diff
and verified fixes through `9282b46`. Confirmed additional findings were ledger deletion/reset,
correction replay, nested map/helper gaps, semantic `ease-linear` and `duration-instant` false
positives, logical/scroll spacing bypasses and missing Solid-border assertions. Their fixes
are separate commits `d5460e5`, `d77d371`, `c7cbbb5`, `83575db`, `9282b46`. A final claim check
found uppercase zero-valued color functions bypassing G6; `bb3758c` normalizes their names and
adds literal/fallback assertions, independently verified by the reviewer. Reproductions failed
before the respective fixes; the replay test also fails when run against the original
`63ddf94` ratchet in a disposable Git fixture. Final reviewer result: no blockers in scope.

**New / regression envelope relative to `2ef69a1`:** 26 new node tests / 14 existing node tests
run in full (40 total); one new browser test / six existing DS1-a browser tests strengthened or
retained. The legacy browser envelope remains 40 mocked tests. Core/CLI and web-component
regressions add no new tests in this review. Test counts are not live model, GPU, network-provider,
mobile, screen-reader or production evidence.

All commands use the current Mac, Node 26.9.0, with `GUANXI_WEB_PORT=5182`,
`GUANXI_API_PORT=4382`, `GUANXI_DATA_DIR="$PWD/.lane-data"`. Direct-check logs are under
`.lane-data/review1-evidence/`. Heavy commands run one per `agent-dev` call under the shared
`heavy` lock; a busy lock is waited out, never bypassed.
The final heavy calls used `--lock-timeout 55` to wait for acquisition. No check command failed
in the final sequence; earlier `resource_busy` results ran no check and were retried.

| Command | New result / receipt |
| --- | --- |
| `npm run ui:check` | Passed G1–G7/G17; seven seeds rejected, 456 contrast measurements, zero unresolved variables. Log `ui-check.log`. |
| `npm run test:gates --workspace @guanxi/ui` | 40 passed, zero failed/skipped. Log `gate-tests.log`. |
| `npm run typecheck` | All five workspaces passed. Log `typecheck.log`. |
| `npm run lint:md` | 95 files, zero errors, including the final hand-off. Log `markdown.log`. |
| `npm run check:licenses` | 358 packages checked; zero not allowed. Log `licenses.log`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 55 -- npm test` | Passed fast gates, all 40 gate tests, core/CLI and all 29 web-component files. Receipt `~/.local/state/agent-dev/check-n5j6dtba/result.json`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 55 -- npm run test:web:browser` | 47 passed: one new / six existing DS1-a / 40 legacy envelope. Receipt `~/.local/state/agent-dev/check-moqzkxi3/result.json`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 55 -- npm run build` | Web, server and CLI builds passed. Receipt `~/.local/state/agent-dev/check-m6nau0ad/result.json`. |

The existing `.claude/skills/guanxi-ui` symlink makes `agent-dev` source reuse unverifiable.
Receipts are execution evidence with actual exit codes; they are not reusable source-bound
certification. All three final receipts report exit code 0 and `source_changed: false` during
execution. Subsequent hand-off-only edits do not claim to reuse those receipts. No task blocker
remains; the authorized residuals below are integration inputs.

### Proposals, residuals and integration

- **M6 proposal:** define `--color-background-ghost`; border roles `secondary`, `tertiary`,
  `inverse`, `ghost`, `disabled`; and the MCP host ring vocabulary beyond `primary`. FOUNDATIONS
  supplies no distinct values for those roles. The map remains partial; no values were invented.
- **L4–L6:** retain the limitations and proposals in the findings table; no nested theme,
  package-boundary or HC-palette work is represented as completed.
- The gate extension contract now documents `extensions/*.gate.mjs` and erasable
  `extensions/*.gate.ts` under Node 26, with an execution/discovery test. DS1-b's
  `gates/catalog/*.ts` modules need a registration adapter; they are not auto-registered.
- Shared edit added by Review 1: root `test` script for M7. No phase-status, next-prompt,
  components, catalog or approval files were edited. No push or merge was performed in this
  resumed session. The integrator still owns package/notice conflicts and lockfile regeneration.
- During self-review, related edits from another local writer were preserved, inspected and
  covered by assertions before inclusion in `83575db`; the read-only reviewer made no edits.
- Next: integrator rechecks the lane hand-off, merges in lane order, regenerates the lockfile
  and folds evidence into the central status files. DS1-c consumes the corrected scanner and
  shrink-only ledger; DS1-b consumes the token/font outputs and registration contract.

## Review 2 fixes

Review source: `/Users/yuzuru/Projects/Guanxi-lanes/ds1-a-review/REVIEW-2.md`, baseline
`a8651a7`; verdict: merge after small fixes. Each finding has a separate fix commit.

### Findings, commits and assertions

| Finding | Fix commit | Test / evidence |
| --- | --- | --- |
| N1 | `8abdca6` | Merge protocol in the gate README and below; documentation is the accepted test substitute. Optional merge bound omitted. |
| N2 | `3c5ea78` | `ratchet.test.mjs` `N2`: a new one→two correction cannot exempt one→three, and the source hash is also checked, on working-tree and committed edges. Removing the hash binding makes this test fail. |
| N3 | `ccc8319` | `ratchet.test.mjs` `N3`: a real depth-one file-URL clone fails closed; after `git fetch --unshallow`, the previously hidden growth is detected. Test failed before the guard. |
| N4 | `80a39f0`, `2212ad9` | Two `scanner-review.test.mjs` `N4` tests: independent JSX/SVG seeds in UI/new web/HTML/SVG paths, exact literal diagnostics, semantic paints accepted, unchanged legacy counts before N7. Literal seed test failed before the fix. G6's G17 seed includes JSX/SVG. The count assertion now detects the separate K1 integration blocker below. |
| N6 | `af1e7fa` | `foundations.test.mjs` `M2/M6/N6` and `N6`: all 16 contexts, documented neutral steps, background/text/border status identities, ring and on-accent text. Wrong-role mutations failed only after the assertions were added. Existing mappings match FOUNDATIONS; no token was changed. HC step-11 overrides retain L6. |
| N7 | `70d4593`, `69135f3` | Resolved using the approved FOUNDATIONS container scale from main `4588ce6` (merged by `6125949`). All 13 `layout.container.*` tokens map to `--container-*`; both `w-*` and `max-w-*` resolve to their documented rem values. Text shadows remain reset, and JSX/CSS `max-w-[37rem]` and `text-shadow-lg` fail G5. All 30 legacy widths now pass without any ratchet correction. |
| N9 | `f0f335a` | `foundations.test.mjs` `N9`: compares every runtime declaration with all names from installed Tailwind `theme.css` and legacy `@theme`; injected Tailwind and legacy collisions fail. |

### Independent verification

A fresh-context, read-only reviewer inspected `a8651a7..f0f335a` plus the pending N7 diff.
It found one N4 gap: static computed JSX keys (`['color']`, `['padding']`) bypassed the scan.
The added seed failed before the fix; `2212ad9` handles these keys and passes the expanded test.
The reviewer independently verified that commit, reporting no further in-scope blocker beyond
the known N7 legacy-width issue. No reviewer wrote files or ran heavy checks.

A separate fresh-context, read-only reviewer inspected `6125949..69135f3` and the root
`package.json` merge resolution, reporting **no findings**. It verified all container values,
context/mutation assertions, compiled utilities, G5 rejection, the unchanged ledger and both
DS1/K1 test scripts. No reviewer edited files or ran heavy checks.

**New / regression envelope:** this continuation adds **3 new node tests / 46 existing node
tests run in full**. All three new tests pass. The cumulative Review 2 delta relative to
`a8651a7` is **9 new / 40 regression envelope**, 49 total: **45 passed / 4 failed / 0 skipped**.
The existing FOUNDATIONS assertions now check every container name, value and unit across all
16 contexts; mutations reject missing/extra widths, all 13 wrong values and a wrong unit.
The four failures are two G5 acceptance tests, the H3 lexical-freeze assertion and the N4
full-ledger assertion, all caused by the six new K1 sidebar literals described below.
No browser tests were added in this continuation. Core/kernel/web-component regressions were
not reached because the locked root test command stopped at G5.

### Required check results and remaining integration blocker

Current Mac, Node 26.9.0; all shells exported `GUANXI_WEB_PORT=5182`, `GUANXI_API_PORT=4382`,
`GUANXI_DATA_DIR="$PWD/.lane-data"`. Direct logs are in
`.lane-data/review2-container-evidence/`. Code revision: `69135f3`; only this hand-off changed
after these checks.

`main` at `4588ce6` was merged with merge commit `6125949`, without rebase. The only conflict
was the root test script: the resolution preserves DS1's gate checks and adds K1's kernel
suite. `npm install --ignore-scripts` refreshed the newly merged kernel workspace link;
`@guanxi/kernel` resolves to this worktree's `packages/kernel/src/index.ts`. The generated
lockfile was restored to the merged version per lane policy; the integrator regenerates it.

| Command | Result / evidence |
| --- | --- |
| `npm run tokens:build` | Passed; regenerated outputs include all 13 widths. G2 freshness/determinism passes. |
| `npm run ui:check` | **Failed G5:** six K1 sidebar keys / six occurrences. G1–G4, G6–G7 and G17 pass; 249 tokens per context; zero unresolved variables. Log `ui-check.log`. |
| `npm run test:gates --workspace @guanxi/ui` | **45 passed / 4 failed / 0 skipped.** All three new container tests pass; failures are the K1 integration issue. Log `gate-tests.log`. |
| `npm run typecheck` | Passed all six workspaces after refreshing the workspace install. Log `typecheck.log`. |
| `npm run lint:md` | Passed 100 files, zero errors; rerun after the final hand-off edit. Log `markdown.log`. |
| `npm run check:licenses` | Passed: 358 packages, zero not allowed. Log `licenses.log`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy -- npm test` | **Failed, exit 1**, at the G5 precheck due only to K1 sidebar literals. Receipt `~/.local/state/agent-dev/check-ysvetnvu/result.json`. |
| Locked `npm run test:web:browser` and `npm run build` | **Not run:** stopped after the first heavy-check failure, as instructed. |

The heavy command used the shared lock without bypass. Its receipt records
`source_changed: false`, exit 1 and no capture errors. The existing
`.claude/skills/guanxi-ui` symlink still prevents reusable source verification; this is an
execution result, not source-bound certification. Later hand-off-only edits do not reuse a
source-bound result.

**N7 blocker removed:** all 30 original legacy width occurrences resolve to the approved
tokens. G5 now finds 1,549 occurrences against the unchanged 1,543-entry occurrence budget:
the difference is entirely K1's six new sidebar literals. G6/G7 remain 152/17. No allowance,
correction policy, scanner exemption or legacy source was changed.

**Remaining blocker:** main's K1 contribution adds six unbudgeted literals in
`packages/web/src/kernel/SidebarSlot.tsx`: `border-[var(--border)]`,
`hover:bg-[var(--bg-subtle)]`, `hover:text-[var(--fg)]`, `rounded-md`,
`text-[var(--fg-muted)]` and `text-xs`, one occurrence each. This is separate from N7 and
requires an integration change to the K1 sidebar, outside this container-token correction.
Do not add a ratchet correction or weaken the scanner.

**Recovery:** migrate the K1 sidebar to supported token-backed styles, then rerun all five
direct checks followed by locked `npm test`, browser gate and build, one per call, stopping
at the first failure. Keep the merge protocol below. No push, merge into main, rebase,
central status-file edit or dependency declaration change was made.

### Deferred follow-ups (no fix in Review 2)

- **N5:** G5 data flow remains per file. Imported class maps, names without a
  `*Class(es)`/`*ClassName` suffix and `[base].join(' ')` can be missed. Consider a lexical
  fallback for non-legacy files in a separate slice.
- **N8:** G6 still misses raw colours in `-webkit-text-fill-color`, `stop-color`,
  `column-rule`, `text-decoration` and `mask-image` gradients. It also falsely flags tokenized
  `transition: opacity var(--motion-duration-fast) …` and `transition-property: opacity`.
  Improve property/value precision separately; these cases were not silently fixed here.

### Required merge protocol (N1)

Merge DS1-a into `main` only with `git merge --no-ff`; never squash or rebase DS1-a commits.
Later lanes must branch from `main` after that merge. Do not merge the lane tip into a stale
branch already containing pre-correction DS1-a commits: the tip is no longer the hash-bound
correction snapshot, and the audit rejects that topology. Rewritten and original correction
histories merged together are also rejected as duplicate introductions. The integrator deleted
the old trial branch `integrate/ds1-a`. The optional merge-commit bound is deliberately omitted;
the documented protocol is the accepted N1 fix and stands in for its test.

### Legacy inline styles for DS1-c (N4)

G6 now checks literal JSX style objects and SVG `fill`/`stroke` at every scanned path except
the exact existing legacy `packages/web/src/components/ui.tsx`. New web paths are checked.
No correction #3, allowance growth or legacy source edit was made. The original pre-K1 legacy
files still match their ledger; K1's six additions are the integration blocker above. DS1-c
must handle that file with G9 ("no inline colour styles
in feature code") and its own shrink-only suppressions, including:

- `:95`: Spinner's computed `borderWidth` geometry; related width/height come from `size`.
- `:327–331`: Select's embedded SVG background image (`stroke='%23888'`, width `1.4`),
  `backgroundRepeat: 'no-repeat'`, `backgroundPosition: 'right 4px center'`, `backgroundSize: '12px'`.
- Related literal branches in the same file: Switch's `left: checked ? 14 : 2` (`:250`),
  chevron `rotate(90deg)` (`:602`) and SVG `strokeWidth="1.6"` (`:604`).

Dynamic style expressions in legacy features (for example ContextPanel/FitIndicator colour
expressions) also remain G9 migration inputs. G6 does not resolve runtime expressions or
imported style objects. Existing G5/G7 checks continue on the legacy file.

## Final K1 sidebar integration

**Status:** implemented and locally validated; ready for integrator merge with `--no-ff`.
**Code revision:** `2db0e28`; only this hand-off changed after the final checks.
This continuation starts at `dbd70f6`; N7 was already resolved.

### Shared edits and token mapping

The integrator explicitly authorized migrating K1's new
`packages/web/src/kernel/SidebarSlot.tsx`; it is a **shared edit in K1's file**, not legacy
debt. Commit `8239582` replaces exactly these six classes:

| Previous class | Generated semantic utility / role |
| --- | --- |
| `border-[var(--border)]` | `border-divider` → decorative `color.border.primary` |
| `text-[var(--fg-muted)]` | `text-secondary` → `color.text.secondary` |
| `hover:text-[var(--fg)]` | `hover:text-foreground` → `color.text.primary` |
| `hover:bg-[var(--bg-subtle)]` | `hover:bg-inset` → subtle fill `color.background.tertiary` |
| `rounded-md` | `rounded-control` → 10 px control radius |
| `text-xs` | `text-12` → matching 12 px type-scale token |

The legacy app imports runtime tokens but does not yet import the generated utility theme.
The shared CSS edit in `packages/web/src/index.css` bridges only these six aliases, exactly
as declared in `packages/ui/generated/theme.css`, so the new classes actually compile.
No existing utility alias is overridden. `packages/ui/tokens/README.md` records the bridge.
DS1-c should remove it when importing the generated theme for the legacy utility migration.
**The slot may look slightly different from the surrounding legacy sidebar until DS1-c's
codemod moves the legacy sidebar onto the same tokens.**

No freeze entry, ratchet correction, policy change, path exclusion or generated output was
added or changed. G5/G6/G7 retain 1,543 / 152 / 17 frozen occurrences; the six unbudgeted K1
occurrences are gone. Both K1 test files are byte-unchanged relative to `dbd70f6`:
`packages/web/test/component/kernel-sidebar-slot.test.tsx` and
`packages/web/test/browser/kernel-slot.spec.ts`. They select by roles and data attributes;
no selector change was needed. HMR, focus preservation, unload and focus return retain their
original assertions and intent. No new component, catalog entry or approval status changed.

### Independent verification and new / regression envelope

A separate read-only reviewer checked `dbd70f6..8239582`: all six mappings and bridge aliases
were correct, with no behavioral or K1 test change. It identified an evidence gap: G5 compiles
the generated theme, so it alone cannot prove the app's bridge emits those utilities.
Separate commit `2db0e28` adds a compiler assertion over the actual web stylesheet and its
imports. It checks all six utility property/token mappings and rejects removal of each alias.
The reviewer verified that fix and reported **no further findings**; it made no edits and ran
no heavy checks.

- **New:** 1 node test in `foundations.test.mjs`; all six missing-alias mutations are rejected.
- **Regression envelope:** 49 existing gate tests, all passing (50 total, zero skipped).
- **Core/CLI/kernel/web envelope:** all existing suites pass; 690 core/CLI tests and 264 web
  component tests, including K1's unchanged two-test sidebar file. The kernel suite also passes.
- **Browser envelope:** 0 new / 48 existing tests pass, including the unchanged K1 real Vite
  HMR test and DS1's production-font/theme assertions. This is a mocked Chromium gate; it
  does not validate live Ollama, GPU inference or production operation.

### Final commands and receipts

Current Mac, Node 26.9.0. Every check shell exported `GUANXI_WEB_PORT=5182`,
`GUANXI_API_PORT=4382`, `GUANXI_DATA_DIR="$PWD/.lane-data"`.
Direct logs are in `.lane-data/sidebar-token-evidence/`. All required checks below passed
at `2db0e28`; the Markdown check was also rerun after this hand-off edit.

| Command | Final result / evidence |
| --- | --- |
| `npm run ui:check` | G1–G7 + G17 pass; 249 tokens per context, zero unresolved variables, unchanged freeze. `ui-check.log`. |
| `npm run test:gates --workspace @guanxi/ui` | 50 passed / 0 failed / 0 skipped. `gate-tests.log`. |
| `npm run typecheck` | All six workspaces pass. `typecheck.log`. |
| `npm run lint:md` | 100 files, zero errors. `lint-md.log`. |
| `npm run check:licenses` | 358 packages, zero not allowed. `check-licenses.log`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy -- npm test` | Passed all root suites. Receipt `~/.local/state/agent-dev/check-85vpv3ps/result.json`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy -- npm run test:web:browser` | 48 passed. Receipt `~/.local/state/agent-dev/check-ya8o0zh3/result.json`. |
| `agent-dev run --cwd "$PWD" --node 26 --resource heavy --lock-timeout 50 -- npm run build` | Web/server/CLI builds pass. Receipt `~/.local/state/agent-dev/check-kk6oa8hc/result.json`. |

Heavy commands ran one per call through the shared `heavy` lock. The first build acquisition
returned `resource_busy` without executing the build; the retry waited for the same lock and
passed. No executed check failed. Final receipts record exit 0, no capture errors and
`source_changed: false`. The existing `.claude/skills/guanxi-ui` symlink still makes reusable
source verification unavailable; these are local execution results, not source-bound
certification. Only documentation changed after them.

Residual scope: no new screenshot/theme/device matrix or forced-colours walkthrough was
performed. Review 2's deferred N5/N8 follow-ups remain separate work, not newly claimed fixes.
Next: integrator applies the N1 `--no-ff` protocol, regenerates the lockfile and reruns its
integration checks; DS1-c then migrates the legacy sidebar and removes the alias bridge.
No push, merge into main, rebase, dependency change, or PHASE_STATUS/NEXT_AGENT_PROMPT edit
was performed in this continuation.
