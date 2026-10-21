# Fast gates and extensions

`npm run ui:check --silent` emits one JSON report and exits nonzero on a failed gate.
G1–G7 and G17 run without a browser. `npm run test:gates --workspace @guanxi/ui` exercises
additional negative cases, file provenance and byte determinism.
DS1-c appends G8 and G9 through `extensions/lint.gate.mjs`; it does not replace registrations.
`npm run lint` runs the repository ESLint flat config, CSS stylelint and the suppression-growth
audit. The new dependencies are pinned exactly in the root manifest.
Both commands are also mandatory parts of the root `npm test` command. The gate tests parse
FOUNDATIONS tables to verify all ramps, status/data colours, spacing, radii, densities, motion
and material values across the 16 resolver contexts. Neutral semantic roles use §1.1's steps
1, 2, 3, 7, 9, 10, 11 and 12; background/text/border status identities, the accent focus ring
and text on accent match §1.2. HC text/borders/rings retain their explicit step-11 overrides,
including the authorized L6 neutral-status residual.

G1 checks all resolved contexts, DTCG names, types, alias cycles/types, equivalent hex fallbacks and
CSS-name collisions. G2 compares all five generated files in memory. G3 checks all 18
FOUNDATIONS colour pairs in four themes and text/control contrast for normal/strong versions
of three materials over white, black and six saturated RGB backdrops (HC uses Solid).
G4 checks CSS-variable references, including Tailwind v4 `(--name)` / `(type:--name)` shorthand,
in web/UI source and generated files. Local legacy and
geometry variables are explicitly scoped in `local-variables.json` and require definitions.

G5 uses the pinned Tailwind compiler plus CSS-declared custom classes, follows lexically scoped
class constants and nested bound maps (property/element access), `*ClassName` props,
`cva` variants, conditional/array class helpers and CSS `@apply`. Arbitrary classes, including v4 shorthand,
always require a legacy allowance. G6 parses CSS declarations/functions, literal values in JSX
`style` objects (including camelCase properties and conditional branches), and SVG `fill`/`stroke`
attributes in JSX, HTML and SVG source. The existing legacy `packages/web/src/components/ui.tsx`
inline styles are deferred to DS1-c's G9 ESLint rule and its shrink-only suppression file;
this exact path exception does not exempt its classes or any new web/UI path. No third ratchet
correction is authorized. G7 checks CSS motion plus TypeScript strings, motion object properties
and `@apply` parameters. HTML, JSX, JS, SCSS and SVG source are scanned, including raw fallbacks
inside `var()`. Runtime expressions and imported style objects are not resolved by G6. Off-scale numeric spacing,
including logical offsets, scroll padding/margins and text indents, fails even when Tailwind
can compile it. Special exclusions are anchored to the package's own
token/font/brand/generated/gate and top-level test directories; a feature directory with the
same name remains scanned. Stories and catalog source are included.

`legacy-allowlist.json` freezes occurrence counts by gate, file and exact value. It accepts
only legacy `packages/web/src/` paths, rejects unused counts and compares its entire Git
history against each commit's actual parents, including every merge parent. Shallow repositories
fail closed; run `git fetch --unshallow` before checking them. Deleting the ledger
is rejected even if a later commit recreates it; an empty freeze stays as `{}`. A moved or split
file can transfer an exact rule/value allowance only from disappeared source keys, without
increasing its total count. The owner authorized exactly two bootstrap corrections, recorded
as an immutable list in `legacy-ratchet-policy.json`: the original `INPUT_CLASS` correction
and Review 1's completed scanner/defaults baseline. Both are bound to exact before/after
hashes. Policy history cannot rewrite/remove an entry or append a third; only those two
transitions are exempt on the edge introducing the corresponding policy entry. An existing
entry cannot be replayed after its occurrences retire. Do not regenerate the list to accept a new violation.
DS1-c can remove entries as it migrates the legacy UI. This is the DS1-a fast ratchet;
DS1-c separately owns ESLint bulk suppressions.

## Merge protocol

### DS1-c lint freeze

G8 checks static imports, exports, dynamic imports, TypeScript import types and CommonJS
requires in feature/plugin source. Underlying UI libraries and private UI paths fail.
Server/CLI/kernel/contract code and the UI implementation are outside the feature boundary.
G9 rejects raw controls and inline colour styles, including bound same-file objects and
unresolved style spreads. Runtime geometry longhands are allowed. Literal inline geometry
in the legacy `components/ui.tsx` is frozen by `guanxi/no-literal-styles`, not a G6 correction.

`eslint-suppressions.json` is ESLint's native bulk format. Only legacy web source may have
entries. Counts must match actual lint errors; prune retired entries with
`npx eslint . --prune-suppressions`. The audit checks each committed parent edge and the
working tree, rejects new/increased entries, deletion/recreation and shallow history, and
allows one initial freeze. A file move needs migration of its violations, not a new budget.
The stylelint colour/geometry rule uses the same CSS count in this file; ESLint also checks
CSS through a source-preserving parser so no separate stylelint allowance can grow.
Inline disable comments cannot bypass the ESLint rules.

The G5 lexical fallback catches arbitrary/palette class literals in imported maps and
`[base].join(' ')` without depending on variable names or call-site analysis. G6's supplemental
CSS rule covers `stop-color`, `mask-image`, WebKit text fill, column rules and text decoration,
while allowing property lists and tokenized transitions. SVG/HTML style attributes and paints
and same-file style objects are also checked. The original DS1-a scanner/ledger stays intact
apart from removing allowances retired by the codemod.

Residual static limits: runtime-generated class fragments, imported/computed style-value
contents, DOM style mutations and custom CSS properties whose names conceal colour usage
need migration/review. Unknown JSX style objects are rejected conservatively. The existing
G5 scanner still owns full compiled-class/spacing validation; the lexical fallback targets
arbitrary values and default palette colours. Colour-related suppression counts are included
in G9's JSON report; U1 cannot exit until those counts are zero.

The deterministic codemod is `npm run codemod:semantic -- --write`; omit `--write` to preview.
Its committed report records the first migration, every touched file and every unmapped
single-variable colour class. Re-running it reports zero replacements; it never invents aliases.

### DS1-a history

Merge DS1-a into `main` only with `git merge --no-ff`; never squash or rebase its commits.
The ratchet audits the original correction-introduction edges, so a rewritten history followed
by a merge of the original commits is rejected as duplicate correction introductions.
Later lanes must branch from `main` after this merge. Do not merge the DS1-a tip into a stale
branch that already contains pre-correction DS1-a commits: the tip has retired allowances and
no longer matches the exact authorized correction snapshot, so that topology fails the audit.
The integrator deleted the old trial branch `integrate/ds1-a`; do not recreate that topology.
The optional merge-commit allowance bound is not implemented; this protocol is required.

## Gate extensions

Other lanes add `extensions/*.gate.mjs` or `extensions/*.gate.ts`, exporting a default gate
or array of gates. TypeScript registrations require Node 26 native type stripping and must
use erasable syntax with explicit ESM extensions; `.tsx` is not loaded. Catalog modules under
`gates/catalog/*.ts` are not registrations on their own: DS1-b supplies a registration module
that imports those checkers and adapts them to this contract:

```js
export default {
  id: 'G10',
  name: 'Catalog complete',
  mode: 'fast', // browser gates run only in the browser command
  seed: 'packages/ui/gates/seeds/G10.json',
  async check(context) {
    return { ok: true, errors: [] }
  },
}
```

The context exposes `root`, sorted `files`, async `read(path)`, `json(path)` and
`withFiles(overrides)`. Always use those reads so G17 can overlay a fixture without changing
the checkout. Paths in fixtures are repository-relative. A seed has
`{ "files": { "path": "replacement content" }, "expectedError": "distinctive violation" }`.
G17 runs the actual registered checker for every seed in the selected command's scope and requires both failure and the
specific diagnostic. An unrelated exception cannot satisfy the seed. G17 itself is tested
by injecting a checker that incorrectly accepts its seed. Extensions must provide their
own normal browser command where appropriate. `node packages/ui/gates/run.mjs --browser`
runs browser extensions and their G17; run it under the shared heavy lock. The fast command
never executes a browser extension, including its seed. Reports list all registrations and
the selected scope, so stage verification can require both scopes once browser gates exist.
