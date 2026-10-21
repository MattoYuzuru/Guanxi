# DOCLINKS lane hand-off

Lane: `lane/doc-link-check`. A dependency-free Markdown link and anchor checker, its tests,
and one npm script entry. No other repository files were changed.

## What I built

- `scripts/check-doc-links.mjs` — an ES module using only `node:fs`, `node:path` and
  `node:url`. It exports `checkLinks({ root, files })`, `slugify(text)`,
  `collectAnchors(markdownText)` and `listMarkdownFiles(root)`.
- Inline links and images, angle-bracket targets, titles, reference definitions, fenced code,
  inline code, HTML comments, ATX and setext headings, duplicate slug suffixes, explicit HTML
  anchors, and the four problem kinds from the specification.
- Command line `node scripts/check-doc-links.mjs [--json] [root]`, with exit codes 0, 1 and 2,
  the summary line, JSON mode, and the documented discovery exclusions.
- `scripts/check-doc-links.test.mjs` — 20 `node:test` cases, one per specification case, each
  using a fresh `mkdtempSync` fixture and asserting the exact kind and line.
- `package.json` — one added line: `"check:links": "node scripts/check-doc-links.mjs"`.

## Commands and results

`node --test scripts/check-doc-links.test.mjs`

```text
tests 20
pass 20
fail 0
```

`npx markdownlint-cli2 docs/plans/lanes/DOCLINKS.handoff.md`

```text
Summary: 0 error(s)
```

`node scripts/check-doc-links.mjs` on the repository (exit code 1, expected findings)

```text
checked 142 files, 570 links, 3 problems
```

`npm run check:links` printed the same three findings and exited 1, confirming the script
entry. `node scripts/check-doc-links.mjs --json` parsed as an object with `files`, `links` and
`problems` keys.

The three findings are listed in the next section. They are pre-existing stale links and were
not fixed, as instructed.

## Mutation checks

Each mutation was applied to `scripts/check-doc-links.mjs`, the test suite was run, and the
original file was restored byte-for-byte (`cmp` confirmed). All four mutations were caught.

| Mutation | Temporary change | Failing test |
| --- | --- | --- |
| (a) duplicates | dropped the `-N` suffix | `5. duplicate headings get numeric suffixes` |
| (b) Unicode | used `/[^a-z0-9 _-]/g` in `slugify` | `7. Cyrillic headings keep their letters` |
| (c) fences | disabled the opening-fence branch | `11. links in fenced and inline code are ignored` |
| (d) schemes | removed the scheme skip | `12. external and protocol-relative links are ignored` |

After restoration the suite was green again: `tests 20`, `pass 20`, `fail 0`.

## Repository findings

Full output of `node scripts/check-doc-links.mjs` (three `missing-file` problems):

- `docs/legacy/alamo/NAVIGATION.md:31:3` — `missing-file` — `../AGENTS.md` —
  target does not exist
- `docs/plans/evidence/K4.md:8:1` — `missing-file` — `../lanes/K4F.handoff.md` —
  target does not exist
- `packages/server/src/runs/README.md:158:9` — `missing-file` —
  `../../../../docs/plans/lanes/R1.handoff.md` — target does not exist

Summary: `checked 142 files, 570 links, 3 problems`.

## Spec notes and residual risk

- Indented code blocks are not skipped; only fenced blocks are. The specification explicitly
  allows fenced-only handling when documented, and this hand-off documents it. The repository
  docs use fenced blocks for code samples.
- A malformed percent-encoding in a fragment is reported as `bad-encoding`, the same kind used
  for a malformed path. The specification requires decoding the fragment but names the kind
  only for path decoding.
- Inline links and images are scanned per line, so a link split across lines is not extracted.
  The specification's cases and the repository docs keep inline targets on one line.
- `listMarkdownFiles` ignores symlinked entries; the repository has no symlinked Markdown docs.

## Files changed

- `scripts/check-doc-links.mjs`
- `scripts/check-doc-links.test.mjs`
- `package.json` (one script line)
- `docs/plans/lanes/DOCLINKS.handoff.md`

## Commit status

The four files are ready in the working tree, but this session's file sandbox denies writes to
the linked worktree's git metadata at
`/Users/yuzuru/Projects/Guanxi/.git/worktrees/doclinks` (`index.lock`: Operation not
permitted). `git add` and `git commit` therefore could not run here, and escalation prompts are
disabled in this session. The intended command, from the worktree root, is:

```bash
git add scripts/check-doc-links.mjs scripts/check-doc-links.test.mjs package.json docs/plans/lanes/DOCLINKS.handoff.md
git commit -m "feat(scripts): add a relative link and anchor checker for Markdown docs"
```

Run it once git metadata is writable. No other branch or repository file was touched.

## Next step

The integrator can merge this lane. The three stale links above remain for a documentation
owner to repair; the checker itself is ready for `npm run check:links`.
