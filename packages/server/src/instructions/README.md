# Instructions: Agent Skills and AGENTS.md

**Status:** implemented (P1-a, library only) · **Updated:** 2026-10-22

Filesystem-only readers for Agent Skills and repository instructions. They are not wired into
the native agent loop: legacy orientation reports `Skills=off`, so skills stay off by default.
Every byte or count budget must be a finite non-negative number; non-finite or negative values
throw `TypeError` before any comparison.

## Agent Skills

`discoverSkills({ projectRoot, userSkillDirs, maxSkills?, maxDescriptionChars? })` scans:

- `<projectRoot>/.agents/skills/*/SKILL.md`
- `<projectRoot>/.claude/skills/*/SKILL.md`
- every directory in `userSkillDirs`, one level deep (`<dir>/<skill>/SKILL.md`)

Only YAML front matter is read, in a bounded window of at most 8 KiB; discovery never asks the
reader for more. The minimal parser accepts `key: value` scalars (quoted or plain) and folded
`>` / literal `|` description blocks; it adds no dependency and stores keys in a null-prototype
object. A block scalar's content must be indented more than its key, so a following top-level
key is never swallowed. Explicit indentation indicators (`|2`, `>2`) and plain multi-line
continuation are unsupported: an indented line after a plain scalar is ignored. A missing or
empty `name`/`description`, or a `name` outside `^[a-z0-9][a-z0-9-]{0,63}$`, is skipped with
`invalid_front_matter`.

Each `SkillSummary` carries `id` (`<source>:<name>`), `name`, `description`, `source`,
canonical `dir` and `bytes` (the `SKILL.md` file size from `stat`); the body is never parsed or returned.
Project skills shadow user skills with the same name (`shadowed`); duplicates inside one
source keep the first sorted path (`duplicate`). Real paths outside the project root (for
project skills) or outside a user directory (for user skills) are skipped (`outside_root`).
An unreadable `SKILL.md` is skipped with `unreadable`; a non-regular one with
`not_regular_file`. A symlink that resolves inside the project root is allowed and
de-duplicated by real path without a warning. `maxSkills` truncation emits `max_skills`;
`maxDescriptionChars` truncates by code point and ends the summary with `…`.

`skillContext(index, count, budget)` renders only `- name: description` lines sorted by
name and returns `{ text, included, omitted }`. The final line reports omitted skills. If
even that line cannot fit, `text` is empty; `count(text) <= budget` holds for non-negative
budgets. A 50 KiB body cannot change the count because no body byte reaches this function.

`loadSkill(index, id, { maxBodyBytes })` returns the byte-exact body after the closing `---`
for a discovered id, `truncated: false`, and sorted relative sibling paths. Bodies over the
limit return `too_large` (never a partial body); unknown ids return `not_found`; redirected
paths outside the captured boundary return `outside_root`; unreadable files return
`unreadable`. File listing is recursive and
skips anything whose real path leaves the skill directory. Instruction files are opened
read-only, non-blocking and without following symlinks; handles are `fstat`ed and non-regular
files (FIFOs, devices) are refused with `not_regular_file`. A body larger than `maxBodyBytes`
is detected with a `cap + 1` read and returns `too_large`, so growth after `stat` is never
silently truncated. Discovery reports a non-regular `SKILL.md` as `not_regular_file`.

## AGENTS.md

`loadInstructions({ projectRoot, cwd, budgetBytes, fileNames? })` walks from `cwd` up to and
including `projectRoot`; `cwd` outside the root throws `TypeError`. `fileNames` defaults to
`['AGENTS.md']`; pass `['AGENTS.md', 'CLAUDE.md']` to opt in to Claude files. The returned
text is project-root first and nearest last, each file prefixed with `## <relative path>`.

Whole files are included from the nearest outward while their bytes fit; a file is never
cut. The first file that does not fit and every farther file are listed in
`overflow.omitted`, and the text ends with the omitted paths, budget and total found bytes.
Symlinked files resolving outside the project root are skipped and reported in `files` and
the text; they are never read. An unreadable file (EACCES) is skipped the same way, listed in
`unreadable` and the text, without rejecting the call. `files` reports every candidate with
its byte size and `included` flag.

## Checks

```bash
node --test packages/server/test/instructions/*.test.ts
npx tsc --noEmit -p packages/server
```
