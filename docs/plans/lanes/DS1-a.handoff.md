# DS1-a hand-off

**Status:** implemented, locally validated; ready for integrator cross-family review.
**Date:** 2026-10-20. **Branch:** `lane/ds1-a-tokens`.
**Worktree:** `/Users/yuzuru/Projects/Guanxi-lanes/ds1-a`.

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
