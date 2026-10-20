# @guanxi/kernel

**Status:** implemented (K1 spike) · **Updated:** 2026-10-20

The Guanxi plugin kernel: a thin facade over upstream [Cordis](https://github.com/cordiverse/cordis)
4 ([ADR-0015](../../docs/decisions/0015-refoundation-on-own-cordis-kernel.md)). Nothing outside
`packages/kernel/src` imports Cordis; `test/boundary.test.ts` fails if anything does.

## Pinned upstream

| Package | Version | Why this one |
| --- | --- | --- |
| `cordis` | `4.0.0-rc.11` (exact) | Latest upstream RC; plain npm dependency, MIT |
| `@cordisjs/plugin-loader` | `1.0.0-rc.8` (exact) | The loader matching rc.11 |

DeepSeek Harness's hardened Cordis (`vendor/cordis`, rc.7 plus 24 local changes) was read for
its lifecycle fixes, not copied: its base is older than rc.11, and the one class of defect that
matters for Guanxi is contained by the guard below. No DSH or Cordis file is copied into this
package, so `THIRD_PARTY_NOTICES.md` has no entry for it. Slot and profile semantics follow DSH's
documented model (MIT) and are implemented from scratch.

## Entry points

- `@guanxi/kernel` (Node and browser): `Context`, `Service`, `definePlugin`, `effect`, `on`,
  `emit`, `inject`, `provide`, `service`, `optionalService`, `timeout`, `interval`,
  `declareSlot`, `contribute`, `SlotRegistry`, `parseManifest`, `readPackageManifest`,
  `satisfiesEngine`, `resolveProfile`, `createKernel`, `countKernel`. The export list in
  `src/index.ts` is the whole surface a replacement kernel would have to provide.
- `@guanxi/kernel/node` (Node only): `Loader`, `bootNode` (profile boot, reconciliation, safe
  mode, `replacePlugin`), `readProfileLayer`, `processResources`.
- `bin/empty-node.ts`: boots an empty node and prints boot time and idle RSS as JSON.

The Cordis type declarations shipped with rc.11 use extensionless relative re-exports that
NodeNext resolution cannot follow, so `src/cordis-runtime.d.ts` and `src/loader-runtime.d.ts`
declare by hand exactly the Cordis surface the kernel uses. Update them with any version bump.

## Manifest

A plugin package declares a `guanxi` field in `package.json` (ADR-0022 §2):

```json
{
  "guanxi": {
    "id": "vendor.plugin-name",
    "engines": { "guanxi": "^0.1.0" },
    "provides": ["service-name"],
    "requires": ["governor"],
    "uses": ["ollama"],
    "contributes": { "slots": ["sidebar.items"], "slotDeclarations": [], "locales": ["en"] },
    "trust": "T1"
  }
}
```

In-tree T0 plugins pass the same object to `definePlugin`. The kernel enforces at load:

- `engines.guanxi` against `KERNEL_API_VERSION` (ranges: exact, `^`, `~`, `>=`, `<`; no
  pre-release tags, no `||`);
- `requires` become Cordis injections: the plugin waits until they exist and unloads before
  its providers do;
- the plugin must provide exactly its `provides` and declare exactly its `slotDeclarations`;
- contributions only to slots listed in `contributes.slots`, which are also injected, so a
  contributor waits for its slot and leaves before the slot's owner;
- T2 plugins are refused in process (ADR-0022: they run out of process).

`uses` services are read with `optionalService` (Cordis 4 injections are all required). The other
contribution kinds are validated as name lists and enforced by the stages that own them.

## Profiles

A node's plugin tree is a list of ordered layers, each with `insert` rows and `patch` rows
(`config` replaces, `disabled`, `remove`). Rows map to loader entries named `cordis:<plugin id>`,
so a profile can only load plugins the node registered; it never imports a module path. Two
deliberate differences from DSH: a patch naming an unknown row fails, and any `__jsExpr` value is
refused, because the Cordis loader evaluates it as JavaScript. Safe mode disables every non-T0
row. `bootNode` also refuses a profile in which a plugin contributes to a slot no enabled plugin
declares.

## Lifecycle guard (vendored patch budget: 1 of 10)

Upstream rc.11 accepts registrations on a fiber that is unloading or has never activated; such
effects, listeners and child plugins are never disposed. `installLifecycleGuard` (applied by
`createKernel`) refuses them by wrapping `Fiber#effect` and `RegistryService#plugin`. Upstream
fixes are open, not merged: cordiverse/cordis#96, #185 and #91. `test/upstream-canary.test.ts`
pins the upstream behaviour without the guard; when an upgrade makes it fail, retire the guard.

Rules for plugin code that follow from the review of rc.11:

- register everything through the context (`effect`, `on`, `timeout`, `interval`, `provide`,
  `contribute`) so unload reverts it;
- do not register asynchronous `internal/update` handlers (upstream issue #194: concurrent
  updates race); configuration changes restart the plugin;
- do not observe `internal/plugin` from features (upstream #185 item 3: a throwing observer
  aborts a disposal).

## Hot reload

- Browser: Vite HMR. The web runtime accepts each built-in plugin module's update and swaps the
  plugin; see `packages/web/src/kernel/runtime.ts`.
- Node: `NodeKernel.replacePlugin(plugin)` unloads every row of that plugin and loads the new
  code. `@cordisjs/plugin-hmr` is not used: it needs Node internals (`--expose-internals` or a
  native addon) to evict the ESM cache. A fresh `import()` per change creates one ES module
  record that Node never frees (about 12.6 KB each in the K1 measurement).

## Leak counters

`kernel.counters()` reports listeners, plugin runtimes, fibers, services, root effects, slots,
slot entries, slot subscribers and orphaned slot entries; `processResources()` reports active
timers and libuv handles. `packages/server/test/kernel-reload-leaks.test.ts` compares them over
100 reload cycles; `test/leak-detection.test.ts` proves they detect a leaking plugin.

## Logging

Upstream Cordis keeps logger output in an in-memory buffer only. `createKernel` drops that buffer
and sends errors and warnings to `onLog` (default: the console), so a failing plugin is visible.
