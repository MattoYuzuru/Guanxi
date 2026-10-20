# @guanxi/kernel

**Status:** implemented (K1) · **Updated:** 2026-10-20

Guanxi's own plugin kernel ([ADR-0037](../../docs/decisions/0037-own-plugin-kernel.md)), with no
runtime dependency. It replaced Cordis after the K1 spike (D-183). The model is Cordis's: a
plugin tree, services as reactive dependencies, revertible effects, events and profiles. The
concurrency rules are new. `test/boundary.test.ts` fails if any package imports or depends on
Cordis.

## Entry points

- `@guanxi/kernel` (Node and browser):
  - plugins and the context: `definePlugin`, `PluginContext`, `GuanxiPlugin`;
  - helpers: `effect`, `on`, `emit`, `provide`, `service`, `optionalService`, `timeout`,
    `interval`, `declareSlot`, `contribute`;
  - the host side: `createKernel` → `Kernel`, `SlotRegistry`;
  - data: `parseManifest`, `readPackageManifest`, `satisfiesEngine`, `resolveProfile`.

  The export list in `src/index.ts` is the whole public surface.
- `@guanxi/kernel/node` (Node only): `bootNode` → `NodeKernel` (profile boot, reconciliation,
  safe mode, pinned rows, `replacePlugin`), `readProfileLayer`, `processResources`.
- `bin/empty-node.ts`: boots an empty node and prints boot time and idle RSS as JSON.

## Writing a plugin

```ts
import { definePlugin, effect, provide, service } from '@guanxi/kernel'

export const clockPlugin = definePlugin({
  manifest: {
    id: 'vendor.clock',
    engines: { guanxi: '^0.1.0' },
    provides: ['clock'],
    requires: ['governor'],
    trust: 'T1',
  },
  apply(ctx) {
    const governor = service<Governor>(ctx, 'governor')
    const timer = setInterval(() => governor.snapshot(), 1_000)
    effect(ctx, () => () => clearInterval(timer), 'tick')
    provide(ctx, 'clock', { now: () => Date.now() })
  },
})
```

Rules the kernel enforces:

- `apply` runs when every `requires` service and every contributed slot exists. It may be
  async and may return a cleanup. Do not wait inside it for another plugin; use `requires`.
- Register everything through `ctx`, so unload reverts it. A context belongs to one activation:
  - it refuses registrations once its plugin starts to unload, fails or restarts;
  - its `signal` aborts at that moment, so async work can stop.
- Provide exactly `manifest.provides`, and only while loading. Read services only through
  `requires` (`service`) or `uses` (`optionalService`). A plugin restarts when one of its `uses`
  appears or leaves. Slots are reached through `declareSlot`/`contribute` only.
- Do not wait inside `apply` for another plugin or a lifecycle call; put long initialisation in
  an effect.
- `kernel/*` event names are reserved.
- Child plugins (`ctx.plugin`) start after their parent's `apply` returns and unload with it.

## Lifecycle

States: `pending → loading → active → unloading → pending | disposed`, and `failed`.

- One transition runs at a time per kernel; loads, unloads, config changes and profile
  reconciliation queue in order.
- When a provider unloads, its children and its dependents unload first, then its cleanups run
  in reverse order, then its services disappear.
- A throwing cleanup or listener is logged and the teardown continues.
- Each plugin step, one `apply` or one cleanup, is bounded by `stepTimeoutMs` (default 10 s):
  - a stuck apply fails its plugin, and a stuck cleanup is skipped;
  - the transition still finishes consistently, and the kernel stays usable;
  - the caller gets `KernelTimeoutError` naming every abandoned step.
- Each plugin starts or restarts at most twice per settle, so optional-service cycles cannot
  loop. A plugin may not `use` a service it provides.

`test/lifecycle.test.ts` pins these rules against the race classes found in upstream Cordis
(ADR-0037).

## Manifest

A plugin package declares a `guanxi` field in `package.json` (ADR-0022 §2). In-tree T0 plugins
pass the same object to `definePlugin`.

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

The kernel checks at load:

- `engines.guanxi` against `KERNEL_API_VERSION` (ranges: exact, `^`, `~`, `>=`, `<`);
- that the plugin provides and declares exactly what it lists;
- that slot contributions stay inside `contributes.slots`;
- that it is not T2, because T2 runs out of process (ADR-0022).

The other contribution kinds are validated as name lists and enforced by the stages that own
them. ADR-0022 is still `proposed`, so the manifest, trust tiers and slots are provisional.

## Profiles

A node's plugin tree is a list of ordered layers. Each layer has `insert` rows and `patch` rows:
`config` replaces the row's config, `disabled` toggles it, `remove` deletes it.

- **Rows:** a row names a registered plugin by manifest id. A profile never imports a module and
  never evaluates code; `__jsExpr` values are refused.
- **Reconciliation:** only rows whose plugin or config changed reload.
- **Patches:** a patch naming an unknown row fails.
- **Requirements:** a required service or contributed slot that no row provides fails, and so do
  rows that require each other in a cycle.
- **Failures:** a failed row, or one still waiting for an enabled provider, fails the change
  (`NodeLoadError`). The profile stays applied and failed rows load again on the next `apply`.
- **Safe mode:** boots the base layer only, disables every non-T0 row, and then every row that
  depends on a disabled one.
- **Pinned rows** refuse any change that would restart them, including through their
  dependencies. These are rows whose services were handed to code outside the kernel, such as
  the legacy server context.

## Slots

`list` slots only, for now (ADR-0022 §3):

- **Ownership:** declaring a slot claims it. Contributions to an undeclared slot fail.
- **Lifecycle:** a declaration is a `slot:<name>` service that contributors need, so contributors
  leave before the slot's owner and return with it.
- **Swaps:** `SlotRegistry#hold()` freezes what renderers see during a plugin swap, so a hot
  update shows no empty frame.

## Hot reload

- **Browser:** Vite HMR. The web runtime accepts each built-in plugin module's update and swaps
  the plugin under `hold()`, so a focused entry keeps focus. See
  `packages/web/src/kernel/runtime.ts`.
- **Node:** `NodeKernel.replacePlugin(plugin)` unloads every row of that plugin, waits until it
  has unloaded, and loads the new code with the same manifest. A fresh `import()` per change
  creates one ES module record that Node never frees (about 12.5 KB each in the K1
  measurement).

## Leak counters

`kernel.counters()` reports:

- listeners, fibers, pending and failed fibers;
- services and effects;
- slots, slot entries, subscribers, holds and orphaned entries.

`processResources()` reports active timers and libuv handles.

`packages/server/test/kernel-reload-leaks.test.ts` compares them over 100 reload cycles and
checks with `WeakRef`s that unloaded instances are collected. `test/leak-detection.test.ts`
proves the counters move.
