# LP-lead-project-view — a node-served, read-only project view for the lead

**Status:** accepted bounded plan · **Updated:** 2026-10-31 · **Base:** `lead/wave7` `14b1d569`,
branch `lane/lead-project-view`, ports 5232 / 4432 (`GUANXI_DATA_DIR=$PWD/.lane-data`).

## Outcome and non-goals

MS1 finding 2: the official Claude Code lead runs with its cwd in an empty private directory and sees
the project only through the plan facts in its prompt. After this slice it can also **read the
delegated project's committed files** through three read-only tools on its own per-turn MCP server
(`mcp__guanxi`, the server that already exposes `guanxi_delegate` and is the only one the lead
pre-allows):

| Tool | Does |
| --- | --- |
| `guanxi_project_tree` | one page of a directory listing (or a recursive listing) at a commit |
| `guanxi_project_read` | one page of a UTF-8 text file at a commit, byte-offset paged |
| `guanxi_project_search` | bounded literal (fixed-string) search over the files of a commit |

Non-goals: write access of any kind; reading uncommitted, untracked or ignored files; a shell; a
change to the relay checkout, the plan schema or the wake packet; a UI; a native-agent tool.

## Design

### Root resolution (what "the checkout the node owns" means for a lead)

A lead is bound to a `projectId` (`lead_sessions.project_id`). The node already resolves a project to
its roots for the relay start (`native project filesystemBindings` -> `workspaces.get(...).rootPath`
-> `realpath`), and the owned-checkout allocator clones `roots[0]` at `plan.base`. The view uses the
**same resolution** (one shared function in `index.ts`, no second path to the filesystem) and reads
**git objects of `roots[0]`**, never its working tree:

- `ref` is `HEAD` (default) or a full 40/64-hex commit id; anything else is `ref_invalid`. The tool
  result names the resolved `commit`. A lead copies it into `plan.base`; the relay then clones the
  same commit, so the lead plans against exactly what the executor will get.
- Reading objects (`git ls-tree`, `git cat-file`, `git grep <commit>`) means untracked and ignored
  files (where secrets usually live), a dirty working tree and symlinks on disk are structurally out
  of reach, and no smudge/textconv filter, hook or config runs (same `gitEnv`/`gitFlags` as the relay).
- A project root that is not the top level of a git repository is `project_view_unavailable`
  (the relay cannot start there either).

### Policy and bounds (no hidden caps)

`ProjectViewPolicy` (all defaults overridable by the host, none invented by the model):
`treeEntries` 200 / `maxTreeEntries` 2000, `pageBytes` 16 KiB / `maxPageBytes` 64 KiB, `maxFileBytes`
4 MiB (largest blob that is scrubbed and paged), `searchMatches` 100 / `maxSearchMatches` 500,
`lineChars` 400, `maxResultBytes` 256 KiB, `timeoutMs` 15 s. Every result carries a `bounds` object with
the values in force and an explicit `truncated`/`more` with the cursor (`nextOffset`) to continue.
A request above a maximum is clamped and the result says so (`bounds` shows the value used). A file
above `maxFileBytes` answers `file_too_large` with its size and the limit; it is not silently cut.

### Security cases

1. Path: relative only; NUL, control characters, backslashes, `.`/`..`/empty segments, a leading `/`
   (absolute) and `~` are `path_invalid`.
2. Denylist (`path_denied`, checked per segment, case-insensitive, for read, tree, search and the
   `path` argument alike; denied entries are omitted from listings and counted in `withheld`, never
   named): `.env*` (the index scanner's rule, now exported from `indexing/snapshot.ts` and reused), `.git`,
   `node_modules`, and credential names: `.ssh .aws .gnupg .kube .docker .npmrc .pypirc .netrc _netrc
   .pgpass .htpasswd .git-credentials id_rsa* id_dsa* id_ecdsa* id_ed25519* credentials*
   client_secret*.json *.pem *.key *.p12 *.pfx *.jks *.keystore *.kdbx *.tfstate *.tfvars`. This is a name
   list, not a classifier: a secret inside an ordinary source file is only caught by the egress scrubber
   when its value is registered. Stated as a residual.
3. Symlinks: tree entries of mode 120000 are listed as `symlink` (no target) and never followed;
   `read` answers `symlink_denied`. Git trees cannot be traversed through a symlink, so `link/..` or
   `link/secret` is `not_found`. Submodules are listed, not entered.
4. Output: every string that leaves is passed through the egress scrubber (paths, entries, file text,
   search lines). Whole-file scrubbing happens **before** paging so a secret straddling a page boundary
   is redacted; `nextOffset` counts bytes of the scrubbed text. Binary or non-UTF-8 content is
   `binary_file`. Search lines are clipped with an explicit marker.
5. Child processes: absolute git binary, argv only (no shell), `GIT_LITERAL_PATHSPECS=1`, the ref is
   validated before use, text is passed after `-e`/`--`, hard timeout and kill, one view call at a time
   per turn (a lead cannot fan out processes).
6. Authority: the tools exist only on a grant of a live lead turn (random bearer token, revoked at turn
   end); the project comes from the stored lead session, never from tool input. An unknown run is
   `lead_not_found`. Nothing returned can name a path outside the project.

### Errors

Fixed lower-case codes returned as the tool text with `isError: true`, the style of `guanxi_delegate`:
`invalid_input: <field>: <issue>`, `path_invalid`, `path_denied`, `not_found`, `not_a_file`,
`not_a_directory`, `symlink_denied`, `binary_file`, `file_too_large`, `invalid_offset`, `ref_invalid`,
`ref_not_found`, `project_view_unavailable`, `project_view_timeout`, `lead_not_found`, plus the fence
codes of the audit (`stale_lease`, ...) because an unaudited read is never served.

### Audit

Each call (including refusals) is recorded in the lead run's session log as one `agent.note`
`{lead: {action: 'project_view', tool, path, commit, outcome, bytes, truncated, withheld}}` through
`runs.mutate` under the attempt's fence, the way `delegation_intent` is. The note is written before the
result is returned; if it cannot be written the lead gets the error code, not the content. Notes never
carry file text; a search records the length of its query, not the query.

## Files

| Path | Change |
| --- | --- |
| `packages/contract/src/lead.ts` | the three tool-name constants (next to `LEAD_DELEGATE_TOOL`) |
| `packages/server/src/leads/project-view.ts` | new: policy, path/denylist, git reader, three operations |
| `packages/server/src/leads/tool-server.ts` | per-grant extra tools; `tools/list` and `tools/call` dispatch |
| `packages/server/src/leads/service.ts` | `projectView` option, grant wiring, audit note |
| `packages/server/src/leads/plugin.ts` | type only (option flows through `LeadPluginConfig`) |
| `packages/server/src/index.ts` | shared `observeProject`; `leads.projectView` opt-in (see the review amendments) |
| `packages/server/src/indexing/snapshot.ts` | export `blocked` as the shared secret-name rule (shared edit) |
| `packages/server/test/leads/project-view.test.ts` | new: unit + integration tests |
| `packages/server/src/leads/README.md`, `docs/operations/ms1-live-run.md` | current-state docs |

## Test matrix

Every guard has a test that fails when the guard is removed (checked by mutation in the hand-off):
happy path (tree, recursive tree, read, paged read to the end, search); `..`, absolute, backslash, NUL
and encoded traversal; a symlink to an outside file and to an outside directory (tree lists it as
`symlink`, read refuses, nothing outside leaks); `.env`, nested `.env.local`, `id_rsa`, `*.pem` (read,
tree omission with `withheld`, search never matches inside them, `path` argument); registered secret
scrubbed in text and across a page boundary; tree/read/search truncation markers and cursors; file over
`maxFileBytes`; binary file; unknown `ref`, non-hex `ref`, option-looking `ref`; uncommitted and ignored
files absent; unknown run -> `lead_not_found`; no project -> `project_view_unavailable`; audit note
written for ok and refused calls and the content withheld when the audit fails; tools listed only when
enabled; one lead turn end to end through the K5 fixture agent and the HTTP tool server.

Commands: `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test` on the new file plus
`tool-server.test.ts`, `lifecycle.test.ts`, `limits.test.ts`; `npx tsc --noEmit -p packages/server`.

## Review amendments (2026-10-31)

The independent security review changed the design before integration:

- **Opt-in, not default-on (M3, lead default, 2026-10-31).** The view exists only through explicit owner configuration:
  `home.lead.projectView: true` (MS1 live) or `leads.projectView: true | { policy, roots }` in `start()`. Both the enabled and the
  default-disabled path are tested through `start()`.
- **Search never opens hidden paths (H1).** A search lists blobs with `ls-tree -r -z`, drops every path the name policy hides, and reads
  the rest through one `cat-file --batch`, matching over the scrubbed text of each whole blob. `git grep` is gone (which also removes the
  repository-config influence of M2, the unbounded line buffering of M1 and the per-line scrub of L2). The search reports no count of hidden
  paths, only a constant note.
- **Cursors (L5)** `<commit>:<offset>` keep a continuation on the first page's commit. **Bounds (L4)** for path length, search text and scan bytes
  come from the policy and are reported. **Exactly one root (L1)**. **Own codes (L3)** `project_view_timeout` and `project_view_output_limit`.
  **Wider name policy (M4)**. Audit-note volume (L6) is a listed residual.

**Round 2 (same day):** `GIT_NO_LAZY_FETCH=1` for every git call; hidden paths leave no figure in any search output; cancellation and shutdown kill running git processes; the scan budget (64 MiB) is applied while listing; the name policy gained token, VPN and CLI credential names. See the hand-off, "Review round 2".
