# ADR-0037: Guanxi's own plugin kernel

**Status:** accepted (owner decision D-183), implemented in lane K1 · **Date:** 2026-10-20
**Supersedes:** the Cordis part of [ADR-0015](0015-refoundation-on-own-cordis-kernel.md)
(Decision 1 and the Cordis items of its validation). The rest of ADR-0015 (`pi-ai`,
`pi-agent-core`, copying DSH ideas, the strangler port, the invariants) stands.

## Context

ADR-0015 put `@guanxi/kernel` on Cordis 4 and named rejection criteria. The K1 spike ran
upstream `cordis` 4.0.0-rc.11 with `@cordisjs/plugin-loader` 1.0.0-rc.8 behind the facade and
found:

- Upstream accepts registrations (effects, listeners, child plugins) on fibers that are
  unloading, have never activated or have failed. They are never disposed. A canary test
  reproduced two of these leaks without the kernel's guard. The fixes were open, unmerged PRs:
  cordiverse/cordis #96, #185 and #91. Two related issues were also open: #194 (async update
  races) and #218 (a loader entry stays bound to its first plugin).
- Containing them took five workarounds, including a runtime wrapper on Cordis prototypes. The
  loader also evaluates `{ __jsExpr }` config as JavaScript, parses `CORDIS_SHARED` at
  construction, and probes for a native addon.
- Cordis's shipped type declarations did not resolve under NodeNext, and server-side HMR needed
  Node internals.
- The independent architecture review found that the literal rejection criterion ("a lifecycle
  race found in review that upstream does not fix") was met.

On 2026-10-20 the owner chose to reject Cordis and build the fallback ADR-0015 names (D-183),
rather than accept with an amended criterion or accept until P1.

## Decision

`@guanxi/kernel` is Guanxi's own kernel, about 1.8k lines of TypeScript with no runtime
dependency. It keeps Cordis's model and changes its concurrency rules.

### Surface

| Area | API |
| --- | --- |
| Plugins | `definePlugin({ manifest, apply(ctx, config) })`; `apply` may be async and may return a cleanup |
| Context (one per activation) | `PluginContext`: `pluginId`, `manifest`, `signal`, `effect`, `on`, `emit`, `provide`, `service`, `optionalService`, `plugin` (child) |
| Helpers | `effect`, `on`, `emit`, `provide`, `service`, `optionalService`, `timeout`, `interval`, `declareSlot`, `contribute` |
| Host | `createKernel()` → `Kernel`: `plugin`, `service`, `emit`, `counters`, `dispose`, `slots`; handles report `PluginState` |
| Node | `@guanxi/kernel/node`: `bootNode({ plugins, profile, safeMode, pinned })` → `NodeKernel`: `apply`, `replacePlugin`, `stateOf`, `entries`; `readProfileLayer`, `processResources` |
| Data | `parseManifest`, `readPackageManifest`, `satisfiesEngine`, `resolveProfile`, `SlotRegistry` |

No Cordis type, class or name is exported. The export list in `packages/kernel/src/index.ts` is
the whole surface.

### Kept from Cordis's design

- A plugin tree: root plugins, and child plugins owned by one activation of their parent.
- Services as reactive dependencies:
  - a plugin with unmet `requires` waits (`pending`) and starts when its providers appear;
  - when a provider leaves, its dependents unload first and come back with a new provider;
  - `uses` are optional, and a plugin restarts when one appears or leaves.
- Revertible effects: everything a plugin registers is undone on unload, in reverse order.
- Events with listeners owned by the registering plugin.
- Profiles built from ordered patch layers, reconciled so only changed rows reload.

### Designed out

| Upstream class | Own-kernel rule | Regression test |
| --- | --- | --- |
| Registration while unloading (#96, #176) and late async registration (#91) | A context accepts registrations only while its own activation is LOADING or ACTIVE and its `signal` is not aborted; an unload request aborts the signal at once | `lifecycle.test.ts`: unloading, async apply, failed apply |
| Never-activated fiber keeps effects (#185 item 1, #127) | A pending fiber has no context, so nothing can register on it; disposal reaches `disposed` from every state | `lifecycle.test.ts`: never activated |
| Stale context after restart | Every activation gets a new context; the old one refuses registrations, service reads and `emit` | `lifecycle.test.ts`, `review-findings.test.ts`: stale context |
| Optional-service restart loops | A plugin may not `use` what it provides; each plugin starts or restarts at most twice per settle, and a skipped restart is logged | `review-findings.test.ts`: optional-service cycles |
| Concurrent update races (#194) | One lifecycle transition at a time per kernel; config changes restart a plugin in queue order | `lifecycle.test.ts`: concurrent config changes |
| Loader rebind (#218) | A profile row that changes plugin or config is unloaded, then loaded fresh | `lifecycle.test.ts`: rebind |
| Throwing observer aborts disposal (#185 item 3) | Listener and cleanup errors are logged per item; teardown always continues | `lifecycle.test.ts`: ordering and isolation |
| Unbounded waits | Each plugin step (one `apply`, one cleanup) is bounded (`stepTimeoutMs`, default 10 s). A stuck apply fails its plugin; a stuck cleanup is skipped. The transition still finishes consistently, the kernel stays usable, and the caller gets `KernelTimeoutError` naming the abandoned steps | `lifecycle.test.ts`: bounded steps |
| Executable config (`__jsExpr`), module paths in profiles | Profiles are plain JSON and name registered plugins by id only | `profile.test.ts` |

### Contract enforced at load

- `engines.guanxi` must accept the kernel version, and T2 plugins are refused in process
  (ADR-0022).
- A plugin must provide exactly `manifest.provides` and must declare exactly
  `contributes.slotDeclarations`. Services can be provided only while loading.
- `service()` reads only `requires`, and `optionalService()` reads only `uses`.
- Plugins reach the slot registry only through `declareSlot`/`contribute`, never as a service.
- `bootNode` adds these rules:
  - it refuses a required service or contributed slot that no row provides, and rows that
    require each other in a cycle;
  - a failed row, or a row still waiting for a service an enabled row provides, fails the change;
    failed rows load again on the next `apply`;
  - safe mode boots the base layer only, disables every non-T0 row, and then every row that
    depends on a disabled one;
  - pinned rows (services handed to code outside the kernel) refuse any change that would restart
    them, including through their dependencies.

### Not provided

These are out of scope by design:

- isolation, which T2 plugins get from running out of process (ADR-0022);
- source HMR inside Node, where code replacement imports a new module and calls `replacePlugin`;
- async `internal/update`-style hooks.

`apply` must not wait for another plugin's activation or for a lifecycle call, because
transitions are serialised. Use `requires`. A child's `ready()` inside its parent's `apply` is
refused with an explanation; a cleanup disposing its own child does not queue a new transition.
A slow step delays the queue until its bound; long initialisation belongs in an effect, not in
`apply`. Per-subtree queues are to be revisited before P1 loads many plugins.

## Consequences

- Positive:
  - no upstream RC churn and no runtime patches;
  - the lifecycle rules are small enough to review and are pinned by tests;
  - the facade is Guanxi-shaped, so later stages build on `PluginContext`.
- Negative:
  - Guanxi maintains the kernel;
  - serialised transitions make a slow `apply` delay other loads (bounded by the timeout);
  - Cordis's wider ecosystem (Koishi plugins, `@cordisjs/*`) is not usable.

## Validation (K1 exit gate, against the own kernel)

Every K1 exit-gate assertion stays and passes:

- legacy governor and Ollama tests run through the facade;
- 100 reload cycles under load leave 0 leaked listeners, timers, handles and slot entries;
- total V8 heap growth after forced GC ≤ 5% over 100 cycles, measured after 50 warm-up cycles
  so JIT compilation is not counted (object heap reported alongside), with every unloaded
  governor, fiber and context collected (`WeakRef` and `retainedObjects`);
- code reloads keep one fixture module record each within a coarse per-reload budget, and every
  replaced fiber and context is collected;
- the web slot appears, hot-updates through Vite HMR and disappears on unload;
- the empty node stays within 2 s and 200 MB.

Measured on Apple M5 Pro with Node 26.9.0: the empty node boots in 40–43 ms with 78–81 MB RSS.
Evidence is in `docs/plans/lanes/K1.handoff.md`.

## Evidence

- K1 spike against Cordis (branch `claude/lane-k1-kernel-5fdf49` up to `020ee10`) and its three
  independent reviews.
- D-183 in the [2026-10-20 addendum](2026-10-20-owner-decisions-addendum.md).
- DSH `vendor/README.md` local-modification log (MIT, read, not copied).
