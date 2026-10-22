# P1-a hand-off — Agent Skills and AGENTS.md loading

**Branch:** `codex/p1a-skills-instructions` (standalone clone, never pushed)
**Status:** library slice implemented; **P1 remains in progress**.

## What exists

- `packages/server/src/instructions/skills.ts` — `discoverSkills`, `skillContext`,
  `loadSkill`. Project roots are `.agents/skills` and `.claude/skills`; user roots are the
  given directories. Only front matter is parsed (bounded 8 KiB window). Project skills
  shadow user skills; real-path dedup and `outside_root` checks cover symlinks.
- `packages/server/src/instructions/agents-md.ts` — `loadInstructions`. Walks `cwd` to
  `projectRoot`, emits project-root-first/nearest-last text with `## <relative path>`
  headers, and reports budget overflow instead of cutting files.
- `packages/server/src/instructions/README.md` — API and guarantee summary.
- `packages/server/test/instructions/skills.test.ts` and `agents-md.test.ts` — 24 baseline tests;
  the independent-review fixes add 17 more (41 total).

Commits on the branch:

- `00a64251` feat(instructions): add Agent Skills discovery with progressive disclosure
- `33125d6e` feat(instructions): load AGENTS.md hierarchy within a reported budget
- `21ff1fa0` test(instructions): cover skill disclosure, symlinks and instruction budgets
- docs commit: this hand-off plus the instructions README

## Commands and result lines

```bash
nice -n 10 node --test packages/server/test/instructions/*.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/instructions/README.md docs/plans/lanes/P1-a.handoff.md
```

Results after the independent-review fixes: `tests 41`, `pass 41`, `fail 0`, `skipped 0`; `tsc` exit 0 with no output;
markdownlint `0 error(s)` for both files.

## New envelope

- Discovery from both project scan dirs and user dirs, summary fields and `bytes`, shadowing,
  duplicate path order, invalid front matter, inside-root symlink dedup, outside-root skips.
- Body isolation: a 50 KiB body with a marker and an injected second front matter is absent
  from the index; the context text and `estimateTokens` count are byte-identical to an empty
  body. A closing delimiter split across the 512-byte read window is covered by a regression
  test.
- Budget property: 250 seeded random sets assert `count(text) <= budget`,
  `included + omitted == skills.length`, sorted names and the omission notice.
- `loadSkill`: exact body, `too_large`, `not_found`, redirected `outside_root`, recursive
  sibling listing that excludes symlinks resolving outside the skill directory.
- AGENTS.md: nearest-last ordering, whole-file inclusion, overflow `omitted` list,
  outside-root symlink skip/report, `CLAUDE.md` opt-in, `cwd` outside root `TypeError`.

## Regression envelope

- The original slice added only new files. The independent-review fixes below changed only
  the instructions library, its tests and README; no legacy source, contract, database, UI or
  dependency file changed. The native orientation still says `Skills=off`.
- Per the lane sandbox rules, only the targeted test files, `tsc -p packages/server` and
  markdownlint ran. No `npm test`, browser gate or full-suite regression claim.

## Defaults and open questions

- `SkillSummary.id` is the bare skill name, unique after shadowing; `source` remains a
  separate field (independent-review fix P3-10).
- `bytes` is the whole `SKILL.md` size from `stat`; the body is never parsed or returned.
- `maxDescriptionChars` truncates by code point with `…`; no cap is applied unless requested.
- AGENTS.md budget counts file contents only, not `##` headers, separators or notices; the
  first non-fitting file stops inclusion and every farther file is reported. Confirm this
  precedence rule.
- Files skipped as outside-root symlinks, unreadable, or changed while reading appear in
  `files` and the text, but not in `overflow.omitted`, which is budget-only. Outside-root
  skips stay out of `overflow` by design.
- The body is the exact suffix after the closing `---` line, including a blank line if the
  file has one. Confirm whether the loader should trim it.

## Residuals (P1 remains in progress)

- Wire discovery/context into the native agent orientation and add a `skill_load` tool.
- Add the per-project enable switch; skills stay off by default in the legacy code per
  `AGENTS.md`.
- Plugin manager install/rollback and engine checks; safe mode.
- Sandboxed MCP client (default off) and MCP tool-description budget.
- Slot enforcement already exists from K1; plugin trust tiers and the remaining P1 gates are
  still open.
- The independent review findings are fixed below; integrator merge remains.

## Independent review fixes

Independent review findings fixed on top of `affe54f5` in separate commits. Each behaviour
change has a regression test observed red before the fix; the bounded-discovery and
stop-at-first-overflow tests were additionally mutation-checked (a whole-file discovery read
and a removed `!stopped` guard both went red, then were restored).

| Finding | Commit(s) | Coverage |
| --- | --- | --- |
| P2-1 `loadSkill` root bypass | `007fe5fa` | cloned, hand-built and original indexes; only the original boundary loads |
| P2-2 discovery-read proof | `680bda38` | injectable `readHead(path, maxBytes)` seam; per-file request/read <= 8192; >8 KiB without closing `---` is `invalid_front_matter` |
| P3-1 skill name form | `733fbe13` | `^[a-z0-9][a-z0-9-]{0,63}$`; newline name cannot inject a listing line |
| P3-2 block scalars | `733fbe13` | content must be indented past its key; dedented `name:` is parsed, not swallowed; indicators/continuations documented |
| P3-3 null-prototype front matter | `733fbe13` | parser returns `Object.create(null)` |
| P3-4 regular-file reads | `650ce5cb` | `O_RDONLY \| O_NONBLOCK \| O_NOFOLLOW`, `fstat().isFile()`, FIFO refused without blocking, `cap + 1` growth detection |
| P3-5 budget validation | `bd4d8952`, `e3e774bc` | non-finite/negative budgets throw `TypeError`; fractional caps are floored |
| P3-6 unreadable files | `ffbc3ced` | skills warning `unreadable`; `loadInstructions` reports `unreadable` and does not reject |
| P3-7 AGENTS.md bounds | `ae27c3aa` | read bounded by `stat` size + growth (`changed`); real-path dedupe; stop-at-first-overflow test; README budget wording |
| P3-8 deterministic warnings | `6ee30edc` | directory entries sorted by name; reversed-readdir test |
| P3-9 listing budget | `7ba0dfa7` | `maxFiles` default 200, never lists beyond it, `overflow: true` |
| P3-10 skill ids | `8a581776` | `id === name`, `source` stays a field; tests and README updated |

New envelope: `tests 41`, `pass 41`, `fail 0`, `skipped 0` (`skills` 27,
`agents-md` 14); 17 tests added over the 24-test baseline. `tsc --noEmit -p packages/server`
exits 0 with no diagnostics. Markdownlint reports `0 error(s)` for the instructions README and
this hand-off.

Regression envelope: only `packages/server/src/instructions/*` and
`packages/server/test/instructions/*` changed. No contract, database, UI, dependency or legacy
runtime file changed; `Skills=off` remains. No `npm test` or browser gate was run because the
slice is library-only.

Design notes: outside-root skips stay out of `overflow` by design; `overflow` is budget-only.
The successful `loadSkill` result has a separate `overflow: true` flag only for the truncated
file listing. Unreadable and changed instruction files are likewise reported separately from
`overflow`.

Residual risk: selection uses the `stat` size before a file is read, so an unreadable or
changed file's bytes still count while choosing the prefix; a farther candidate that would fit
after freeing that budget remains omitted. Growth of a `loadSkill` body is detected, but a
body that shrinks between `stat` and the read returns the shorter current body.
