# DS1-a hand-off

**Status:** Review 1 fixes implemented and locally validated; ready for integrator review.
**Date:** 2026-10-20. **Branch:** `lane/ds1-a-tokens`.
**Worktree:** `/Users/yuzuru/Projects/Guanxi-lanes/ds1-a`.

The original delivery and validation below are historical. The **Review 1 fixes** section
supersedes their counts, remaining work and integration status.

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
`a8651a7`; verdict: merge after small fixes. Findings are being fixed in separate commits.

### Required merge protocol (N1)

Merge DS1-a into `main` only with `git merge --no-ff`; never squash or rebase DS1-a commits.
Later lanes must branch from `main` after that merge. Do not merge the lane tip into a stale
branch already containing pre-correction DS1-a commits: the tip is no longer the hash-bound
correction snapshot, and the audit rejects that topology. Rewritten and original correction
histories merged together are also rejected as duplicate introductions. The integrator deleted
the old trial branch `integrate/ds1-a`. The optional merge-commit bound is deliberately omitted;
the documented protocol is the accepted N1 fix and stands in for its test.
