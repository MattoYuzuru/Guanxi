# Fast gates and extensions

`npm run ui:check --silent` emits one JSON report and exits nonzero on a failed gate.
G1–G7 and G17 run without a browser. `npm run test:gates --workspace @guanxi/ui` exercises
additional negative cases, file provenance and byte determinism.

G1 checks all resolved contexts, DTCG names, types, alias cycles/types, equivalent hex fallbacks and
CSS-name collisions. G2 compares all five generated files in memory. G3 checks all 18
FOUNDATIONS colour pairs in four themes and text/control contrast for normal/strong versions
of three materials over white, black and six saturated RGB backdrops (HC uses Solid).
G4 checks CSS-variable references in web/UI source and generated files. Local legacy and
geometry variables are explicitly scoped in `local-variables.json` and require definitions.

G5 uses the pinned Tailwind compiler plus CSS-declared custom classes, follows class constants,
and reads `cva` variants, class helpers and CSS `@apply`. Arbitrary classes
always require a legacy allowance. G6 parses CSS declarations and functions; G7 checks CSS
motion plus TypeScript strings and motion object properties. Source tests, fixtures, fonts,
token sources and generated outputs have separate authoring contracts and are excluded from
literal scanning. Stories and catalog source are included.

`legacy-allowlist.json` freezes occurrence counts by gate, file and exact value. It accepts
only legacy `packages/web/src/` paths, rejects unused counts and compares its entire Git
history so a removed allowance cannot return. The owner authorized one initial correction:
six missed lexical occurrences in unchanged legacy `INPUT_CLASS`, balanced by removing six
false positives. `legacy-ratchet-policy.json` binds the exact before/after snapshots by hash;
only that transition is exempt. Do not regenerate it to accept a new violation.
DS1-c can remove entries as it migrates the legacy UI. This is the DS1-a fast ratchet;
DS1-c separately owns ESLint bulk suppressions.

Other lanes add `extensions/*.gate.mjs`, exporting a gate or array of gates:

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
