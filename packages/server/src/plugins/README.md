# Plugins: T1 manager core

**Status:** implemented (P1-b, library only) · **Updated:** 2026-10-22

`manager.ts` installs **T1** plugins from a local directory into
`<pluginsDir>/<id>@<version>/`. Registry and tarball downloads, approved build-script
execution, kernel boot wiring, the agent-facing `plugin_manager` tool and T2 out-of-process
plugins are later slices. Nothing here uses the network or runs an npm command.

Trust is checked, not granted: T0 is core-only and T2 needs the later OS sandbox, so both are
refused. Build scripts are never executed; an explicit approval is only recorded in the lock.

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
manager.bootSet({ safeMode })
```

`inspect` is read-only: it validates the `guanxi` field with the kernel validator, computes
the source integrity, and reports the build-script names among `preinstall`, `install`,
`postinstall` and `prepare`. `license` comes from `package.json` (`license` string or
`license.type`), or is `null`.

`install` upgrades an existing id in place, keeps its enabled/disabled state, and removes the
previous version directory only after the commit. A fresh install is enabled. `list()` and
`bootSet()` are synchronous and sorted by id. `bootSet({ safeMode: true })` returns `[]`
without reading state (ADR-0022 invariant: safe mode disables all T1 and T2 plugins).
`bootSet()` returns the absolute directories of enabled plugins.

`PluginManagerError` exposes a stable `code`: `engine_mismatch`, `peer_missing`,
`build_scripts_unapproved`, `trust_tier_unsupported`, `integrity_mismatch`,
`invalid_package_json`, `invalid_plugin_version`, `invalid_state`, `plugin_not_installed`,
`plugin_directory_exists` and `invalid_arguments`. Source walk failures use
`SourceIntegrityError` from `integrity.ts` with `source_not_found`, `source_not_directory`,
`source_symlink`, `source_outside_root`, `source_not_regular` or `source_unreadable`.

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

Both files are written through a same-directory temporary file, `fsync`, `rename` and a
directory `fsync`. Readers accept the small array/object variants used by earlier
hand-written states, but the manager always writes this canonical form.

## Integrity

A source is identified by every regular file below its root, excluding directories, modes and
timestamps. The canonical listing is the UTF-8 JSON array `[[path, sha256], ...]`, sorted by
the UTF-8 bytes of the relative `/`-separated path; the published string is
`sha256-<sha256 of that JSON>`. Symbolic links (including a symlinked source root),
non-regular entries and paths resolving outside the root are refused. `expectedIntegrity`
also accepts the SRI base64 form (`sha256-<base64>`) of the same digest.

`engines.guanxi` supports only `x.y.z`, `^x.y.z`, `~x.y.z`, and whitespace-separated
conjunctions of `>=x.y.z` and `<x.y.z` (for example `>=0.1.0 <0.2.0`). Wildcards, `||`,
pre-release tags, `>`, `<=` and hyphen ranges are rejected by the kernel validator rather than
half-supported.

## Transaction and rollback

Before copying, `install` checks the engine range, needs (`requires` must be provided by the
loaded kernel or an enabled installed plugin), build-script approval, trust and expected
integrity. It then copies into `<pluginsDir>/.staging/stage-<random>/`, recomputes the staged
integrity, and writes both state files. Only then does it rename the stage into place. The
previous version directory is kept until the commit point and removed afterwards.

A thrown failure at any step restores `plugins.json` and `plugins.lock.json` from their exact
previous bytes (or removes them when they did not exist), removes the staging or partial
directory and restores a same-version backup. Commit is final at the `install:committed`
fault point; later cleanup of the old version is best-effort and cannot turn a successful
install into a failure. A real process kill between the two metadata renames is not recovered
by this slice; only in-process throws are rolled back.

`INSTALL_FAULT_POINTS` enumerates every install step, `UNINSTALL_FAULT_POINTS` and
`SET_ENABLED_FAULT_POINTS` do the same for the other mutations, and `FAULT_POINTS` aliases the
install list. Tests throw at each point and assert byte-identical state.

## Checks

```bash
node --test packages/server/test/plugins/manager.test.ts
npx tsc --noEmit -p packages/server
npx markdownlint-cli2 packages/server/src/plugins/README.md
```
