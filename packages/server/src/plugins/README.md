# Plugins: T1 manager core

**Status:** local T1 manager and node startup implemented; wider P1 remains partial · **Updated:** 2026-11-01

`manager.ts` installs **T1** plugins from a local directory into
`<pluginsDir>/<id>@<version>/`. Registry and tarball downloads, approved build-script
execution, the agent-facing `plugin_manager` tool and T2 out-of-process
plugins are later slices. Nothing here uses the network or runs an npm command.

Trust is checked, not granted: T0 is core-only and T2 needs the later OS sandbox, so both are
refused. The trust check runs before build-script approval, so a T0 source with scripts is a
trust refusal rather than an approval prompt. Build scripts are never executed; an explicit
approval is only recorded in the lock.

## Trusted node startup

The real node and CLI now read enabled installations under `<dataDir>/plugins` after all core
services load and before opening the HTTP listener. Absent/empty state loads no addon.
`start({ trustedPlugins: { directory } })` is a trusted host override, never an HTTP option.
`start()` returns `trustedPlugins`, a typed report of loaded/skipped ids and stable codes.
Missing/tampered directories are skipped; malformed state, invalid packages, dependency
failures, imports or apply errors abort startup with a content-free `TrustedPluginStartupError`.
Successful earlier addon activations are disposed on failure. No source text, module error or
filesystem path is copied into the loader error/report.

Use `guanxi --safe-mode --no-open` to recover: it skips **all** addon state and imports and
keeps the core session/run/connection/agent services. A running node must first be stopped;
the CLI refuses to describe attaching an existing process as safe-mode recovery. The host
equivalent is `trustedPlugins.safeMode: true`. Installed enable/lock files are not changed by
recovery mode or startup inspection; startup uses `bootEntries({ recover: false })`, so it
does not sweep retained/unreferenced directories. Explicit manager recovery keeps its existing
semantics below. Installation/enabling is still through the trusted library, with no CLI
install command, registry, HTTP mutation or plugin UI. Changes take effect on node restart.

Startup packages must declare `type: "module"`, a relative `main` pointing to a regular `.mjs`
or `.js` file inside the installed directory, and a T1 `guanxi` manifest. The entry's default
export is a kernel plugin whose validated manifest exactly matches the package. Other export
maps and CommonJS are not supported in this slice. Core ids/services and duplicate addon
providers are refused; required services/declared slots are ordered and checked before import.

Every enabled directory is copied into a fresh private runtime snapshot and its copied bytes
are checked against the captured lock integrity before import. Mutation/removal of installed
files cannot silently substitute the imported source. Snapshot paths give each start a fresh
ESM entry and relative module graph. Snapshots remain until addon disposal, then are removed;
registered effects are cleaned by the kernel. A process kill can leave a private temporary
snapshot; this slice does not sweep old runtime snapshots.

Packages must be bundled/self-contained or carry their own installed dependencies: the fresh
snapshot does not inherit the application's `node_modules` or resolve its `@guanxi/kernel`.
Context-based service/effect plugins work; a portable shared plugin SDK and the slot-helper
bridge are future work (a bundled second kernel copy has a separate context registry). Do not
infer general UI extension support from this startup slice.

**T1 is full trust.** Pinning and snapshots are not an OS sandbox: absolute/transitive imports,
top-level effects, arbitrary logging and host access by trusted code remain possible. Import
top-level effects cannot be rolled back by the kernel. Node retains ESM module records for the
process lifetime, even after files are removed; restart is the update boundary. MCP and skills
remain disconnected/off; no model-visible tool or prompt changes are introduced here.

The kernel bounds `apply`/cleanup steps, but dynamic module import itself is not bounded or
cancellable here. A pending top-level await can leave startup unresolved; terminate that node
and restart with `--safe-mode`. The guarded entry sanitizes errors from `apply` and its
returned cleanup only. Errors from callbacks registered through `ctx.effect` or `ctx.on`
still reach the normal kernel logger with their original text. This is a full-trust plugin
runtime, not a general plugin diagnostic scrubber.

## API

```ts
const manager = new PluginManager({
  pluginsDir,
  kernelApiVersion: KERNEL_API_VERSION,
  loaded: () => ({ provides: ['some.service'] }),
  clock: () => new Date(),
  hooks: { point(name) { /* optional fault injection */ } },
})

await manager.inspect(sourceDir)
// { manifest, integrity, buildScripts, license }

await manager.install(sourceDir, { approveBuildScripts, expectedIntegrity })
await manager.uninstall(id)
await manager.setEnabled(id, enabled)
manager.list()
manager.bootSet({ safeMode, onSkip(skip) { /* missing/tampered entry */ } })
manager.bootEntries({ recover: false }) // same validated set with captured identity + canonical integrity
manager.recover()
```

`inspect` is read-only: it validates the `guanxi` field with the kernel validator, computes
the source integrity, and reports the build-script names among `preinstall`, `install`,
`postinstall` and `prepare`. `license` comes from `package.json` (`license` string or
`license.type`), or is `null`.

`install` upgrades an existing id in place, keeps its enabled/disabled state, and removes the
previous version directory only after the commit. A fresh install is enabled. Installing the
same version again is a no-op only when the source integrity equals the locked integrity and
the installed directory still exists with matching bytes; a missing directory is reinstalled
and repaired, and different source content fails with `version_exists`; an upgrade must use a
new version. `list()` and
`bootSet()` are synchronous and sorted by id. `bootSet({ safeMode: true })` returns `[]`
without reading state (ADR-0022 invariant: safe mode disables all T1 and T2 plugins).
`bootSet()` returns the absolute directories of enabled plugins whose directory exists and
whose current bytes still match the locked integrity. Other enabled entries are skipped and
reported through `onSkip` with reason `missing_directory` or `integrity_mismatch`.

`PluginManagerError` exposes a stable `code`: `engine_mismatch`, `peer_missing`,
`build_scripts_unapproved`, `trust_tier_unsupported`, `integrity_mismatch`,
`invalid_package_json`, `invalid_plugin_version`, `invalid_state`, `plugin_not_installed`,
`plugin_directory_exists`, `version_exists`, `plugins_busy`, `dependency_in_use` and
`invalid_arguments`. Source walk failures use `SourceIntegrityError` from `integrity.ts` with
`source_not_found`, `source_not_directory`, `source_symlink`, `source_outside_root`,
`source_hardlink`, `source_not_regular` or `source_unreadable`.

## State files

```json
{ "version": 1, "enabled": ["guanxi.example-plugin"] }
```

`plugins.json` contains only the enabled set. `plugins.lock.json` pins the exact install:

```json
{
  "version": 1,
  "plugins": {
    "guanxi.example-plugin": {
      "version": "1.2.3",
      "integrity": "sha256-<64 lower-case hex characters>",
      "directory": "guanxi.example-plugin@1.2.3",
      "requires": [],
      "provides": ["example.service"],
      "buildScripts": ["postinstall"],
      "buildScriptsApproved": true,
      "installedAt": "2026-10-22T12:00:00.000Z"
    }
  }
}
```

A lock entry is accepted only when `directory` is exactly `<id>@<version>`; a missing or
redirected directory is `invalid_state`. Both files are written through a same-directory
temporary file, `fsync`, `rename` and a directory `fsync`. Readers accept the small
array/object variants used by earlier hand-written states, but the manager always writes this
canonical form.

## Integrity

A source is identified by every regular file below its root, excluding directories, modes and
timestamps. The canonical listing is the UTF-8 JSON array `[[path, sha256], ...]`, sorted by
the UTF-8 bytes of the relative `/`-separated path; the published string is
`sha256-<sha256 of that JSON>`. Symbolic links (including a symlinked source root), files with
`nlink > 1`, non-regular entries and paths resolving outside the root are refused.
`expectedIntegrity` also accepts the SRI base64 form (`sha256-<base64>`) of the same digest.

Source files are opened with `O_NOFOLLOW | O_NONBLOCK` and classified from the opened handle,
not only from the directory walk. A FIFO or other non-regular entry is therefore refused with
`source_not_regular` instead of blocking the manager; a handle that turns out to be
hard-linked is `source_hardlink`.

`engines.guanxi` supports only `x.y.z`, `^x.y.z`, `~x.y.z`, and whitespace-separated
conjunctions of `>=x.y.z` and `<x.y.z` (for example `>=0.1.0 <0.2.0`). Caret ranges use the
npm rule: `^0.0.z` stays on `0.0.z`, `^0.y.z` stays below `0.(y+1).0`, and `^x.y.z` for
`x > 0` stays below `(x+1).0.0`. Wildcards, `||`, pre-release tags, `>`, `<=` and hyphen
ranges are rejected by the kernel validator rather than half-supported.

## Transaction and rollback

Before copying, `install` checks the engine range, needs (`requires` must be provided by the
loaded kernel or an enabled installed plugin), trust, build-script approval and expected
integrity. It then copies into `<pluginsDir>/.staging/stage-<random>/`, recomputes the staged
integrity, and renames the stage into its final `<id>@<version>` directory. Only after that
rename and a `syncDirectory(pluginsDir)` does it write `plugins.json` and
`plugins.lock.json`. A crash before the state write leaves an unreferenced plugin directory,
never a lock entry whose directory is missing.

`uninstall` commits `plugins.json` and then `plugins.lock.json` before removing the directory.
A crash before the lock write leaves the plugin installed (possibly disabled); a crash after
it leaves only an unreferenced directory that `recover()` sweeps, never a lock entry whose
directory is missing.

A thrown failure at any step before commit restores `plugins.json` and `plugins.lock.json`
from their exact previous bytes (or removes them when they did not exist), removes the
staging or partial directory, and removes a plugins directory that the attempt created.
Uninstall has no directory backup: it restores the two state files and removes the directory
only after a successful commit. Rollback steps are attempted independently; if one fails, the
original error carries all rollback failures as an `AggregateError` in `error.cause` instead
of swallowing them. Commit is final after the state writes: cleanup of the old version is
best-effort and cannot turn a successful install or uninstall into a failure. There is no
`previous-*` same-version backup path anymore.

`recover()` removes `.staging`, the manager's own stale state temporary files, enabled ids in
`plugins.json` that have no lock entry (reported as `removedEnabledIds`), and every
`<id>@<version>` directory that the lock does not reference. It runs once per manager instance
on the first `install`, `list` or `bootSet` (and on the first `uninstall`/`setEnabled`), and
can be called explicitly. The whole sweep holds `<pluginsDir>/.lock`; when another manager
holds it, `recover()` removes nothing and returns `{ skipped: 'plugins_busy' }` with empty
removal arrays. A manager that already holds the lock sweeps under it. Recovery only deletes
unreferenced directories, so it never removes a directory the lock references; an entry whose
directory was already missing is reported by `bootSet()` through `onSkip`.

`uninstall`, `setEnabled(false)` and an upgrade that drops a `provides` entry fail with
`dependency_in_use` while an enabled installed plugin `requires` a service that would
disappear. Disabled consumers do not block the change.

## Concurrency

Mutations take `<pluginsDir>/.lock` with `O_CREAT | O_EXCL` and write
`{ pid, token, createdAt }`. A second manager attempting `install`, `uninstall` or
`setEnabled` while the lock is held fails with `plugins_busy`; the in-process queue serialises
one instance, the file lock serialises processes. The token prevents one manager from removing
another manager's lock. A lock is stale when its `pid` is not alive (`process.kill(pid, 0)`
throws `ESRCH`) or when `createdAt` is older than **30 minutes**; the file mtime is the
fallback for a lock that is not our JSON. Before unlinking a stale lock the manager re-reads it
and confirms the same token, so a fresh lock taken by another contender is not removed. A
stale lock is removed once and acquisition is retried. `list()` and `bootSet()` are read-only
apart from implicit recovery: they take the lock for that sweep and skip it while another
manager is active.

## Fault injection and checks

`INSTALL_FAULT_POINTS` enumerates every reachable install step in call order,
`UNINSTALL_FAULT_POINTS` and `SET_ENABLED_FAULT_POINTS` do the same for the other mutations,
and `FAULT_POINTS` aliases the install list. A happy install records the points it fires and
the test deep-equals them with `INSTALL_FAULT_POINTS`, so the list cannot silently drift.
Tests throw at each point for upgrade, fresh and same-version installs and assert
byte-identical state and listings. `SimulatedCrash` thrown from a hook bypasses rollback so a
fresh manager can exercise `recover()` after every install and uninstall crash point; the
uninstall loop asserts that no lock entry survives without its directory.

## Residual risk

- Node's `fsync` is not macOS `F_FULLFSYNC`: the state files and parent directory are synced
  with `fsync`, but a power loss can still lose a rename on macOS. `F_FULLFSYNC` is not
  exposed by Node's `fs` API in this slice.
- The 30-minute stale-lock threshold is still a heuristic: a live mutation can be taken over
  after it, and a reused pid is treated as alive until then.
- Recovery writes `plugins.json` to drop ids without a lock entry; a hand-edited enabled id
  that the operator intended to keep is therefore not preserved across recovery.
- Hand-edited state is trusted local data, not signed.

## Checks

```bash
nice -n 10 node --test packages/server/test/plugins/manager.test.ts
npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/plugins/README.md docs/plans/lanes/P1-b.handoff.md
```
