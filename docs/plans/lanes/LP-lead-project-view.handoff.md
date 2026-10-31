# LP-lead-project-view hand-off

**Status:** implemented, locally validated (author evidence only; independent review and hosted CI follow) ·
**Updated:** 2026-10-31 · **Branch:** `lane/lead-project-view` from `lead/wave7` `14b1d569` · **Plan:**
[LP-lead-project-view.plan](LP-lead-project-view.plan.md)

## What changed

The official Claude Code lead (MS1 finding 2: empty private cwd, plan facts only from the prompt) now has a node-served,
read-only view of the delegated project's **committed** files on its own per-turn MCP tool server (`mcp__guanxi`):

- `guanxi_project_tree`, `guanxi_project_read`, `guanxi_project_search` (`leads/project-view.ts`). They read git objects of the
  project's source repository at `HEAD` or a full commit id (never the working tree, so untracked, ignored and uncommitted files and
  on-disk symlinks are out of reach), with the relay's `gitEnv`/`gitFlags`, an absolute binary, argv only, a hard timeout,
  `GIT_LITERAL_PATHSPECS` and only object plumbing (`rev-parse`, `ls-tree -z`, `cat-file`). Every result names its `commit`, a valid `plan.base` the relay will clone.
- Root resolution is the relay start's own (`observeProject` in `index.ts`, extracted from the inline `project` callback and used by both);
  the project comes from the stored lead session, never from tool input. **Opt-in** (review M3): `home.lead.projectView: true` or
  `leads.projectView: true | { policy, roots }`; otherwise the lead has `guanxi_delegate` alone.
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

`715d93d8` plan · `ef87b0fc` feat(leads) · `5623fd7a` style · `e2e34972` tests · `353a373d` docs · `38af9b17` hand-off · review fixes: `65c5c22e` fix, `72bf75a4` tests, then the docs commit (plan amendments, README, runbook, this review section).

## Commands and results

Final state after the review fixes (`72bf75a4` and the docs commit that follows):

```text
npx tsc --noEmit -p packages/server                                  exit 0
npx eslint <changed ts files>                                         0 errors, 0 warnings
npx markdownlint-cli2 <4 changed md>; node scripts/check-doc-links.mjs   0 errors; checked 317 files, 827 links, 0 problems
node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test \
  leads/project-view leads/tool-server lifecycle limits boot children resilience store packet contract stale-holder relay-mirror
                                                                     tests 137 / pass 137 / fail 0
... --test ms1-live/lead ms1-live/lead-project-view ms1-live/config ms1-live/boot indexing/index indexing/service
                                                                     tests 81 / pass 81 / fail 0
... --test ms1/rehearsal (15 SIGKILL boundaries, real relay start through the changed index.ts)
                                                                     tests 25 / pass 25 / fail 0
```

All with `GUANXI_WEB_PORT=5232 GUANXI_API_PORT=4432 GUANXI_DATA_DIR=$PWD/.lane-data`. No `agent-dev` lock was used (focused files, no browser).
`npm run lint:md` was run as its two parts on the changed files (`markdownlint-cli2` and `scripts/check-doc-links.mjs`).

**New / regression envelope:** 33 new (31 in `test/leads/project-view.test.ts`, 2 in `test/ms1-live/lead-project-view.test.ts`) /
210 envelope (106 other `test/leads` tests, 79 in `ms1-live/{lead,config,boot}` and `indexing`, 25 in `ms1/rehearsal`). Files are credited once.
(`ms1-live/config` and `ms1-live/boot` joined the envelope because the configuration schema and the boot wiring gained `projectView`.)

**Guard mutation checks** (each mutation applied to the source, the project-view test file, or for the opt-in the production-boot file, run;
source restored after each):

- Before the review (25 mutations, 25 killed after two tests were added for the first run's survivors): dot segments accepted; nothing
  denied; credential names dropped; scanner rule dropped; symlink read allowed; symlink as directory; whole-file scrub before paging
  removed; payload scrub removed; ref validation removed; literal pathspecs off; tree page not limited; limit not clamped; result bound
  ignored (tree and read); binary check removed; file size limit removed; tree does not omit denied entries; multi-line search text
  accepted; nested root accepted; unknown task served; unaudited content served; calls not serialized; project taken from the input.
- After the review fixes the same set was re-run against the rewritten code: 21 killed; the 4 whose code was rewritten were re-expressed and
  killed (binary check in read and in search, tree without the hidden-path filter, nested root accepted); 2 no longer exist (the
  `git grep` clipped-line prefix scrub and the search denied-file skip, replaced by the H1 design below).
- New for the review (20 mutations, 20 killed): search lists hidden paths; search over raw text; oversize blobs requested; record cap off;
  scan budget off; excerpt not around the match; view on by default; five name-policy rules dropped or re-anchored; several roots accepted;
  timeout does not reject; output limit off; text bound off; path bound fixed; cursor ignored; cursor combinable with `ref`; search listing
  without `-z`.

## Shared edits (outside the lane's own files)

- `packages/contract/src/lead.ts`: three tool-name constants.
- `packages/server/src/indexing/snapshot.ts`: `blocked` is now exported (one word; behaviour unchanged).
- `packages/server/src/index.ts`: `observeProject` extracted from the relay start host's `project` callback; `leads.projectView` option.
- `packages/server/test/external-agents/fixture-process.mjs`: scenario `lead.projectCalls` (additive).
- `packages/server/test/ms1-live/live-world.ts`: `restartHomeWithLead`/`writeScenario` accept extra `lead` scenario fields (additive).
- `docs/operations/ms1-live-run.md`: one bullet in section 7.

## Review findings and fixes

The independent security review (coordinator, 2026-10-31) is addressed in the fix commits after `38af9b17` (`fix(leads): review fixes ...`,
`test(leads): ...`, `docs: ...`). Plan amendments: [plan](LP-lead-project-view.plan.md#review-amendments-2026-10-31).

| Finding | Fix | Evidence |
| --- | --- | --- |
| H1 search was an oracle on hidden files (`withheld` counted matches in them) | search lists blobs with `ls-tree -r -z`, drops every hidden path **before** any blob is requested, reads the rest through one `cat-file --batch`, matches over the scrubbed text of each whole blob; no hidden-path figure anywhere in a search (a constant `note` only) | **Test change (H1):** the assertion that pinned `found.withheld === 6` now asserts `'withheld' in found === false` and the constant note. New test: two repos whose hidden `.env`, `.env.production` and `id_rsa` differ only in content give byte-identical search output (commit normalised) for eight queries; a registered secret is not findable either |
| M1 unbounded line/record buffering | `git grep` removed. Blobs above `maxFileBytes` are never requested; a pending listing record is capped (`maxPathBytes + 512`) and dropped unread; `cat-file` frames are parsed in a stream; excerpts are cut around the match; `maxScanBytes` bounds one search and `scan` reports what was skipped | test with 3 MB and 600 KB single-line blobs, a binary blob and a tiny scan budget; test with a 600-byte path against a 20-byte bound. The handoff claim "bounded only by `timeoutMs`" is removed |
| M2 repo-local config (`submodule.recurse`) | no `grep` at all; explicit `-c` overrides (submodule recursion, attributes file, untracked cache) as defence in depth; every invocation reviewed (only `rev-parse`, `ls-tree`, `cat-file`) | test sets submodule recursion, filter/textconv/fsmonitor/pager commands, hooks path, attributes file and a gitlink in the repository config; no marker file is created and the gitlink is only listed. The overrides themselves are not killed by a mutation (object plumbing ignores those settings); the test pins the behaviour, not the flags |
| M3 opt-in (lead default, 2026-10-31) | `leads.projectView` and `home.lead.projectView` default to off | production-boot tests: enabled lists the four tools and audits; default lists `guanxi_delegate` only and a project call is `unknown_tool`. README, `ms1-live-run.md` updated |
| M4 denylist gaps | added `secret(s).<data format>`, `*.secret(s)`, a `secret(s)` directory, `*service-account*.json`, `*.tfstate*`, `*.tfvars*`, `p8 ppk gpg asc pgp jceks`, `.s3cfg .boto .dockercfg .vault* .azure .gcloud .yarnrc.yml .terraformrc kubeconfig` | one test per class (`deniedPath`, a read refused, a flat committed file per name omitted and counted); negatives `secrets.ts`, `service.ts`, `keyboard.ts`. Known false positives: a directory named `secrets` and `*.asc` documents are hidden |
| L1 exactly one root | `roots.length === 1` or `project_view_unavailable` | none/two/one root test |
| L2 per-line scrub of multi-line secrets | search scrubs each whole blob before matching or excerpting (a clipped line is cut from scrubbed text, so `scrubTruncatedPrefix` is no longer needed) | multi-line registered value: no query for any piece of it matches and no line leaks |
| L3 untested timeout/overflow, comment/code mismatch | timeout rejects at once; overflow is `project_view_output_limit` in code, comment and README; `git` binary injectable for tests | fake `git` that sleeps (timeout, returns in under 5 s) and one that floods stdout (output limit), plus a missing binary |
| L4 hard-coded limits | `maxPathBytes`, `maxTextChars`, `maxScanBytes` in the policy, reported in `bounds` (the zod/JSON-schema `maxLength` literals are gone) | bounds test with non-default policy; **test update:** the `bounds` deep-equal in the first test gained `maxPathBytes: 4096` |
| L5 cursor pinning | `nextCursor` `<commit>:<offset>` for tree, read and search; `cursor` excludes `ref`/`offset` | HEAD moves between pages: 14 entries, 14 distinct on each of tree and search, read reassembles; bad and combined cursors refused |
| L6 audit volume | **not done**, residual: one small note per call, no coalescing (a count-only note would weaken the per-call audit) | - |
| L7 newline filenames | `-z` everywhere; no line-oriented parsing | file names with a newline, tab and non-ASCII listed and searched exactly |

## Verification findings and fix commits (first review)

None for the author; the review above is the lead's.

## Residuals

- A name denylist is not a secret classifier. A credential inside an ordinary committed source file is redacted only if its value is
  registered with the egress scrubber; committed `.env.example` templates are denied too (the scanner's rule), which hides variable names.
- The view needs the project root to be the top level of a git repository (the relay's own requirement); other roots answer
  `project_view_unavailable`. Exactly one root is required (review L1), as in the relay.
- Read cursors are byte positions in the scrubbed text; if a secret is registered or rotated between two pages of one file, the offsets of
  the later pages can move (the page is still scrubbed). Search `line` counts lines of the scrubbed text, so a redacted multi-line
  region shifts later line numbers relative to the raw file.
- A search scrubs every allowed blob it scans (at most `maxScanBytes`, 256 MiB, and each blob at most `maxFileBytes`, 4 MiB) synchronously on
  the event loop; a very large repository can hold the node busy for up to the git timeout per process. Nothing is cached between calls.
- Audit notes are not coalesced (review L6): one small note per call; a lead that makes thousands of calls writes thousands of notes.
- The name policy hides a directory called `secrets`/`secret` and `*.asc` documents (review M4 asked for both).
- No UI and no web client use the audit notes yet; they sit in the lead run's session log like `delegation_intent`.
- Real Claude Code behaviour with the new tools (whether Sonnet 5.5 uses them sensibly, tool-call cost in the lead's two turns) is not
  measured; the fixture agent proves the protocol, not the model. An MS1 re-run with the real lead is the live check.
- The MS1 evidence record (`ms1-fault-runs-2026-10-24.md`) still lists "not started" in its residuals; it is dated evidence and was not edited.
  The integrator should fold this slice into PHASE_STATUS and the next prompt.

## Next slice

Re-review of the fix commits after `38af9b17` (search rewrite, cursors, denylist), then the original scope: `ef87b0fc..HEAD` (security focus: path and ref handling, git argv, scrub-before-page, audit-before-serve),
then fold into the wave 7 candidate and `npm run ci:finish`. A live check with the real lead on `Guanxi-Test-Repo` shows whether
the lead's plan quality improves with the view.
