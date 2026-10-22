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
- `packages/server/test/instructions/skills.test.ts` and `agents-md.test.ts` — 24 tests.

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

Results: `tests 24`, `pass 24`, `fail 0`, `skipped 0`; `tsc` exit 0 with no output;
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

- Only new files were added; no legacy source, contract, database, UI or dependency file
  changed. The native orientation still says `Skills=off`.
- Per the lane sandbox rules, only the targeted test files, `tsc -p packages/server` and
  markdownlint ran. No `npm test`, browser gate or full-suite regression claim.

## Defaults and open questions

- `SkillSummary.id` is source-qualified (`project:name` / `user:name`); integration must
  confirm whether the tool-facing id should instead be the bare skill name.
- `bytes` is the whole `SKILL.md` size from `stat`; the body is never parsed or returned.
- `maxDescriptionChars` truncates by code point with `…`; no cap is applied unless requested.
- AGENTS.md budget counts file bytes only, not headers or separators; the first non-fitting
  file stops inclusion and every farther file is reported. Confirm this precedence rule.
- Files skipped as outside-root symlinks appear in `files` and the text, but not in
  `overflow.omitted`, which is budget-only.
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
- Independent cross-family verification is still required before merge.
