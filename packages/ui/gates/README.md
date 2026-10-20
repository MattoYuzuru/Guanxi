# Fast gates and extensions

`npm run ui:check --silent` emits one JSON report and exits nonzero on a failed gate.
G1–G7 and G17 run without a browser. `npm run test:gates --workspace @guanxi/ui` exercises
additional negative cases, file provenance and byte determinism.
Both commands are also mandatory parts of the root `npm test` command. The gate tests parse
FOUNDATIONS tables to verify all ramps, status/data colours, spacing, radii, densities, motion
and material values across the 16 resolver contexts.

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
always require a legacy allowance. G6 parses CSS declarations and functions; G7 checks CSS
motion plus TypeScript strings, motion object properties and `@apply` parameters. HTML, JSX,
JS and SCSS source are covered, as are raw fallbacks inside `var()`. Off-scale numeric spacing,
including logical offsets, scroll padding/margins and text indents, fails even when Tailwind
can compile it. Special exclusions are anchored to the package's own
token/font/brand/generated/gate and top-level test directories; a feature directory with the
same name remains scanned. Stories and catalog source are included.

`legacy-allowlist.json` freezes occurrence counts by gate, file and exact value. It accepts
only legacy `packages/web/src/` paths, rejects unused counts and compares its entire Git
history against each commit's actual parents, including every merge parent. Deleting the ledger
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
