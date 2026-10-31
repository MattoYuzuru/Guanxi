# LP-lead-project-view hand-off

**Status:** implemented, locally validated (author evidence only; independent review and hosted CI follow) ·
**Updated:** 2026-10-31 · **Branch:** `lane/lead-project-view` from `lead/wave7` `14b1d569` · **Plan:**
[LP-lead-project-view.plan](LP-lead-project-view.plan.md)

## What changed

The official Claude Code lead (MS1 finding 2: empty private cwd, plan facts only from the prompt) now has a node-served,
read-only view of the delegated project's **committed** files on its own per-turn MCP tool server (`mcp__guanxi`):

- `guanxi_project_tree`, `guanxi_project_read`, `guanxi_project_search` (`leads/project-view.ts`). They read git objects of the
  project's source repository at `HEAD` or a full commit id (never the working tree, so untracked, ignored and uncommitted files and
  on-disk symlinks are out of reach), with the relay's `gitEnv`/`gitFlags`, an absolute binary, argv only, a hard timeout and
  `GIT_LITERAL_PATHSPECS`. Every result names its `commit`, a valid `plan.base` the relay will clone.
- Root resolution is the relay start's own (`observeProject` in `index.ts`, extracted from the inline `project` callback and used by both);
  the project comes from the stored lead session, never from tool input. `start({ leads })` enables the view by default;
  `leads.projectView: false` disables it, `{ policy }` overrides the bounds.
- Bounds (`ProjectViewPolicy`, defaults in the README) are reported in every result as `bounds`; cut results say `more`/`truncated` and carry a
  cursor; clipped search lines carry a marker; oversize files are `file_too_large: size N bytes, limit M`.
- Secrets: name denylist (`path_denied`, per segment, case-insensitive) on read, tree and search; the index scanner's rule is reused
  (`blocked` exported from `indexing/snapshot.ts`) plus credential names. Denied entries are omitted and counted (`withheld`), not
  named, not searched. Symlinks are listed, never followed (`symlink_denied`). The whole file is scrubbed by the egress scrubber
  before paging; paths, entries and search lines are scrubbed; a clipped line uses `scrubTruncatedPrefix`.
- Tool server: grants carry optional extra tools (`ExtraTool`); `tools/list` and `tools/call` dispatch per grant, so a grant without a view
  lists exactly `guanxi_delegate` as before. `guanxi_delegate`'s description names the project tools when they exist.
- Audit: one `agent.note` `{lead: {action: 'project_view', ...}}` per call (refusals included) through `runs.mutate` under the attempt's
  fence, before the result is returned; no file text, only the query length for a search. If the note cannot be written the lead gets the
  code and no content. Calls of one turn are serialized.
- Prompt-carried plan facts are untouched; the tool descriptions and the MS1 runbook tell the lead and the operator the tools exist.

## Commits

`715d93d8` plan · `ef87b0fc` feat(leads) · `5623fd7a` style · `e2e34972` tests · `353a373d` docs · (this hand-off file).

## Commands and results

```text
npx tsc --noEmit -p packages/server                                  exit 0
npx eslint <changed ts files>                                         0 errors, 0 warnings (after the style commit)
npx markdownlint-cli2 <3 changed md>; node scripts/check-doc-links.mjs   0 errors; checked 316 files, 825 links, 0 problems
node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test \
  leads/project-view leads/tool-server lifecycle limits boot children resilience store packet contract stale-holder relay-mirror
                                                                     tests 128 / pass 128 / fail 0
... --test ms1-live/lead ms1-live/lead-project-view indexing/index indexing/service
                                                                     tests 51 / pass 51 / fail 0
... --test ms1/rehearsal (15 SIGKILL boundaries, real relay start through the changed index.ts)
                                                                     tests 25 / pass 25 / fail 0
```

All with `GUANXI_WEB_PORT=5232 GUANXI_API_PORT=4432 GUANXI_DATA_DIR=$PWD/.lane-data`. No `agent-dev` lock was used (focused files, no browser).

**New / regression envelope:** 23 new (22 in `test/leads/project-view.test.ts`, 1 in `test/ms1-live/lead-project-view.test.ts`) /
181 envelope (106 other `test/leads` tests, 50 in `ms1-live/lead` and `indexing`, 25 in `ms1/rehearsal`). Files are credited once.

**Guard mutation check** (each mutation applied to the source, the project-view test file run, source restored; 25 mutations, 25 killed
after two tests were added for the first run's survivors): dot segments accepted; nothing denied; credential names dropped; scanner
rule dropped; symlink read allowed; symlink as directory; whole-file scrub before paging removed; payload scrub removed; clipped-line
prefix scrub removed; ref validation removed; literal pathspecs off; tree page not limited; limit not clamped; result bound ignored
(tree/search and read); binary check removed; file size limit removed; tree does not omit denied entries; search does not skip denied
files; multi-line search text accepted; nested root accepted; unknown task served; unaudited content served; calls not serialized;
project taken from the input. The two first-run survivors (read result bound; project taken from the input) got their own tests.

## Shared edits (outside the lane's own files)

- `packages/contract/src/lead.ts`: three tool-name constants.
- `packages/server/src/indexing/snapshot.ts`: `blocked` is now exported (one word; behaviour unchanged).
- `packages/server/src/index.ts`: `observeProject` extracted from the relay start host's `project` callback; `leads.projectView` option.
- `packages/server/test/external-agents/fixture-process.mjs`: scenario `lead.projectCalls` (additive).
- `packages/server/test/ms1-live/live-world.ts`: `restartHomeWithLead`/`writeScenario` accept extra `lead` scenario fields (additive).
- `docs/operations/ms1-live-run.md`: one bullet in section 7.

## Verification findings and fix commits

None yet: the independent review is the lead's separate action.

## Residuals

- A name denylist is not a secret classifier. A credential inside an ordinary committed source file is redacted only if its value is
  registered with the egress scrubber; committed `.env.example` templates are denied too (the scanner's rule), which hides variable names.
- The view needs the project root to be the top level of a git repository (the relay's own requirement); other roots answer
  `project_view_unavailable`. Only `roots[0]` is read, as in the relay.
- Cursors are byte positions in the scrubbed text; if a secret is registered or rotated between two pages of one file, the offsets of
  the later pages can move (the page is still scrubbed). Search offsets count matches, so a new commit between pages can shift them;
  every page names its `commit` and the lead can pin `ref`.
- `git grep` scans whole blobs before the line clip; a pathological repository is bounded only by `timeoutMs` (15 s default).
- No UI and no web client use the audit notes yet; they sit in the lead run's session log like `delegation_intent`.
- Real Claude Code behaviour with the new tools (whether Sonnet 5.5 uses them sensibly, tool-call cost in the lead's two turns) is not
  measured; the fixture agent proves the protocol, not the model. An MS1 re-run with the real lead is the live check.
- The MS1 evidence record (`ms1-fault-runs-2026-10-24.md`) still lists "not started" in its residuals; it is dated evidence and was not edited.
  The integrator should fold this slice into PHASE_STATUS and the next prompt.

## Next slice

Independent read-only review of `ef87b0fc..HEAD` (security focus: path and ref handling, git argv, scrub-before-page, audit-before-serve),
then fold into the wave 7 candidate and `npm run ci:finish`. A live check with the real lead on `Guanxi-Test-Repo` shows whether
the lead's plan quality improves with the view.
