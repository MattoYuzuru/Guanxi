# P1-b hand-off — T1 plugin manager core

**Branch:** `codex/p1b-plugin-manager` (standalone clone, never pushed) · **Status:** library
slice implemented; **P1 remains in progress**.

## What exists

- `packages/server/src/plugins/integrity.ts` — canonical SHA-256 identity over sorted relative paths and file hashes; symlinks, non-regular entries and paths outside the source are refused.
- `packages/server/src/plugins/manager.ts` — `PluginManager` with read-only `inspect`, transactional `install`/upgrade, `uninstall`, `setEnabled`, `list`, `bootSet`, engine/peer checks and exported fault points.
- `packages/server/src/plugins/README.md` — API, state schemas, integrity format, supported ranges, transaction order and residual risks.
- `packages/server/test/plugins/manager.test.ts` — 16 tests, including install rollback at every exported fault point and uninstall/enable rollback loops.

Commits: `c6aecf04` feat(plugins): add T1 plugin inspection and integrity; `0989672c` feat(plugins): add transactional install with rollback and safe-mode boot set; `5e088cad` test(plugins): cover install rollback at every fault point; docs commit: this hand-off plus the plugin README.

## Commands and result lines

```bash
nice -n 10 node --test packages/server/test/plugins/manager.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/plugins/README.md docs/plans/lanes/P1-b.handoff.md
```

Results: `tests 16`, `pass 16`, `fail 0`, `skipped 0`; `tsc` exit 0 with no output; markdownlint `0 error(s)` for the README and this hand-off.

## New envelope

- `inspect` validates with the kernel manifest parser and never writes; integrity changes with content or path and is stable across copies. Source symlinks and a symlinked source root are refused with `SourceIntegrityError`.
- Engine (`^`, `~`, `>= <`, exact), peer, build-script approval, trust and expected-integrity checks all happen before the plugins directory or staging is created; tests assert the directory listing is unchanged.
- `plugins.json` holds the enabled set and `plugins.lock.json` pins version, integrity, directory, requires/provides, build scripts, approval and `installedAt`. Both use temp + `fsync` + `rename` + directory `fsync`; mutations are serialised in process.
- Install stages under `.staging/stage-<random>/`, re-hashes the copy, writes both state files and only then renames the stage into place. Every thrown failure restores previous manifest/lockfile bytes, removes staging/partial directories and restores a same-version backup. The old version survives upgrade failure and is removed only after commit.
- `bootSet({ safeMode: true })` returns `[]`; `bootSet()` returns sorted absolute directories of enabled plugins. `list()` reports disabled plugins too.
- Build scripts are never executed even when approved; the approval is recorded only. Semver tests cover `^`, `~`, `>= <`, exact and rejection of unsupported forms.

## Regression envelope

- Only new files under `packages/server/src/plugins/` and `packages/server/test/plugins/`; no package, dependency, contract, database, UI or legacy runtime file changed. No network or npm invocation.
- Per the lane sandbox rules, only the targeted test file, `tsc -p packages/server` and markdownlint ran. No `npm test`, browser gate or full-suite regression claim.

## Defaults and residual risk

- The canonical listing is a UTF-8 JSON array of `[path, sha256]` pairs sorted by path bytes; the published form is `sha256-<hex>`. `expectedIntegrity` also accepts the SRI base64 form of the same digest.
- State parsing tolerates earlier array/object variants, but the manager writes one canonical form. Hand-edited state is trusted local data, not signed.
- Only in-process throws are rolled back. A real process kill between the two metadata renames or the final directory rename is not recovered by this slice.
- Cleanup after `install:committed` is best-effort: a failed removal of the previous version leaves it behind rather than turning a successful install into a failure.
- The in-process queue does not coordinate with another process writing the same `pluginsDir`.

## Residuals (P1 remains in progress)

- Registry and tarball download with pinned integrity; this slice accepts only local folders.
- Running approved build scripts inside the OS sandbox.
- Wiring installed plugins and `bootSet` into kernel boot/profile rows.
- The agent-facing `plugin_manager` tool; UI for install/enable/remove.
- T2 out-of-process plugins and their capability broker.
- Recovery of interrupted metadata/directory renames across a real process crash.

## Independent verification

A separate reviewer subagent read the implementation and traced all 20 install fault points through `installLocked` -> catch -> `rollbackInstall`; it reported no findings. It checked byte-snapshot restoration, staging/partial cleanup, same-version backup restore, and that old-version deletion runs only after `install:committed`.
