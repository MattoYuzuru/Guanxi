# P1-b hand-off — T1 plugin manager core

**Branch:** `codex/p1b-plugin-manager` (standalone clone, never pushed) · **Status:** library
slice implemented; **P1 remains in progress**.

## What exists

- `packages/server/src/plugins/integrity.ts` — canonical SHA-256 identity over sorted relative paths and file hashes; symlinks, non-regular entries and paths outside the source are refused.
- `packages/server/src/plugins/manager.ts` — `PluginManager` with read-only `inspect`, transactional `install`/upgrade, `uninstall`, `setEnabled`, `list`, `bootSet`, engine/peer checks and exported fault points.
- `packages/server/src/plugins/README.md` — API, state schemas, integrity format, supported ranges, transaction order and residual risks.
- `packages/server/test/plugins/manager.test.ts` — 34 tests, including install and uninstall crash loops, lock-staleness and recovery-under-lock checks, missing-directory repair and byte-for-byte rollback at every exported fault point.

Commits: `c6aecf04` feat(plugins): add T1 plugin inspection and integrity; `0989672c` feat(plugins): add transactional install with rollback and safe-mode boot set; `5e088cad` test(plugins): cover install rollback at every fault point; docs commit: this hand-off plus the plugin README.

## Commands and result lines

```bash
nice -n 10 node --test packages/server/test/plugins/manager.test.ts
nice -n 10 npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/plugins/README.md docs/plans/lanes/P1-b.handoff.md
```

Results: `tests 29`, `pass 29`, `fail 0`, `skipped 0`; `tsc` exit 0 with no output; markdownlint `0 error(s)` for the README and this hand-off.

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
- A real process kill is recovered by `recover()`: the verified directory is committed before the state files, and leftover staging/unreferenced directories are swept.
- Cleanup after `install:committed` is best-effort: a failed removal of the previous version leaves it behind rather than turning a successful install into a failure.
- Mutations coordinate between processes through `<pluginsDir>/.lock`; a lock stale for more than 30 minutes can be taken over.

## Residuals (P1 remains in progress)

- Registry and tarball download with pinned integrity; this slice accepts only local folders.
- Running approved build scripts inside the OS sandbox.
- Wiring installed plugins and `bootSet` into kernel boot/profile rows.
- The agent-facing `plugin_manager` tool; UI for install/enable/remove.
- T2 out-of-process plugins and their capability broker.

## Independent verification

A separate reviewer subagent first read the implementation and traced all 20 install fault points through `installLocked` -> catch -> rollback; it reported no findings. A later independent review found the defects fixed above, so those findings supersede the clean first pass. The install order, recovery, reinstall and rollback-failure behaviour have changed since that pass.

## Independent review fixes

The independent review findings were fixed in separate commits, each with a failing-first test
(or a test-only commit where the existing behaviour already matched the new assertion):

- `9173bfc5` — commit the verified directory before the state files, fsync the parent, add
  `recover()`, make same-version reinstall a no-op or `version_exists`, and make `bootSet()` skip
  and report missing/tampered entries.
- `6f4f822f` — fresh-install and same-version every-fault-point loops, plus a happy-install
  self-check that deep-equals the fired points with `INSTALL_FAULT_POINTS`.
- `82433dcd` — attach rollback failures to the original error as an `AggregateError` cause.
- `003561a7` — refuse hard-linked source files (`source_hardlink`).
- `1217156e` — open source files with `O_NONBLOCK` and refuse non-regular handles; FIFO test
  skips only when `mkfifo` is unavailable.
- `4eef549e` — require the lock directory to equal `id@version` when reading.
- `72407999` — `<pluginsDir>/.lock` with `O_EXCL` and a 30-minute stale-lock policy; a second
  manager's install fails with `plugins_busy`.
- `0684a4d1` — `dependency_in_use` for uninstall, disable and upgrades that drop a required
  `provides` entry.
- `71343d0c` — trust check before build-script approval; T0 with scripts is a trust refusal.
- `2e586dc5` — caret-range tests for `^0.0.z` and `^1.y.z`.

Final checks after the fixes: `tests 29`, `pass 29`, `fail 0`, `skipped 0`; `tsc` exit 0 with
no output; markdownlint `0 error(s)` for the plugin README and this hand-off. macOS `fsync` is
documented as not being `F_FULLFSYNC` in the README residual risk; Node exposes no portable
`F_FULLFSYNC` in this slice.

## Independent re-check fixes

A second independent re-check confirmed install crash safety and found the problems below.
Each was fixed in its own commit with a failing-first test:

- `468e687f` — uninstall writes `plugins.json` and then `plugins.lock.json` before removing the
  directory, and the uninstall catch passes `SimulatedCrash` through. An uninstall crash loop
  asserts after every point plus a fresh `recover()` that no lock entry names a missing
  directory.
- `6404776c` — `recoverSync` takes `<pluginsDir>/.lock` with `O_CREAT | O_EXCL` for the whole
  sweep and returns `{ skipped: 'plugins_busy' }` while it is held; public `recover()` and the
  implicit recovery in `list()`/`bootSet()` share that path. A held lock now protects an
  in-flight, renamed-but-unreferenced directory.
- `1e40faa2` — the same-version no-op requires the installed directory to exist and match the
  lock; a missing directory falls through to a normal reinstall and is repaired.
- `ef6bcfcd` — the lock body is `{ pid, token, createdAt }`; staleness comes from a dead pid
  (`process.kill(pid, 0)` throws `ESRCH`) or a 30-minute-old `createdAt`, with mtime as the
  fallback for a non-JSON lock. A stale lock is re-read and its token confirmed before
  unlinking. Tests cover a reaped child pid, a live pid and an aged live lock.
- `6430f453` — recovery drops enabled ids that have no lock entry and reports them as
  `removedEnabledIds`.

Final checks after the re-check fixes: `tests 34`, `pass 34`, `fail 0`, `skipped 0`; `tsc`
exit 0 with no output; markdownlint `0 error(s)` for the plugin README and this hand-off.
