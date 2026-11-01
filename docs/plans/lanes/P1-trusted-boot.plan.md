# P1 — trusted plugin startup

**Status:** autonomous implementation under the owner's 2026-11-01 continuation; root accepted
this bounded slice. Base `af254dae`; lane `lane/p1-trusted-boot`, Mac only, Node 26.9.0.

## Outcome

The real node startup consumes enabled local T1 installations under `<dataDir>/plugins` after
core services have loaded. Missing/empty state means no addons. A trusted host override can
select the directory; `start({ trustedPlugins: { safeMode: true } })` and CLI `--safe-mode`
skip all addon state, copying and imports without disabling core services. An already running
node cannot be changed into safe mode by attaching another CLI.

The existing manager captures enabled entries and pinned integrity from one state read.
Each candidate is copied into a fresh private runtime directory and verified there before
any import. Its package must be ESM, name one confined `.mjs` or `.js` entry through `main`,
and carry a T1 manifest matching the installed identity/engine/services. The default export
must be a kernel plugin with the same manifest. Reject core-id/service collisions and order
required-service/slot dependencies before applying addons. Failure rolls back loaded addons
and aborts node startup; shutdown disposes addons and their snapshots exactly once.

The operator gets a typed content-free startup report; skipped entries name stable codes,
not paths, module errors or source content. No install UI, HTTP mutations, MCP, skill/native
tools, schema migration or dependency is added. T1 has full process rights, not isolation.

## Integrity, lifecycle and compatibility

Copying then hashing the private snapshot avoids importing mutable installed bytes after a
check; each start gets a fresh module URL/relative graph rather than an old ESM cache entry.
Snapshots live until disposal. Plugins must be bundled/self-contained or carry their own
dependencies: runtime snapshots do not resolve the host's `@guanxi/kernel` by ancestor lookup.
Trusted absolute imports, top-level effects, arbitrary plugin logging and Node's ESM module
cache lifetime remain outside isolation claims. Build scripts still never execute here.

The loader does not mutate installed enabled/lock state. Rollback is disabling addons via
safe mode or reverting the new code; no user data down migration. Existing manager recovery
and its documented live-lock timeout heuristic remain unchanged.

## Acceptance and checks

Use temporary plugin sources/installations and synthetic services: real startup sees the
addon and all core services; safe mode ignores malformed state and executes zero top-level
effects; disabled/missing/tampered and malformed entries never apply; T0/T2/core-id and
service collisions, manifest mismatch, traversal/symlink entries, missing dependencies and
cycles fail closed; reverse dependency order works; failed apply removes earlier effects;
close disposes once; installed mutation cannot change snapshot execution; two starts use
fresh entry/relative modules. CLI default loading and safe-mode recovery use subprocesses
with temporary data/ports only. No Docker, real models or owner `~/.guanxi`.

Run new plugins tests plus the manager/kernel boot envelope, server/CLI typechecks and changed
file lint under the shared `agent-dev` resource `heavy`; root owns independent review and
final hosted CI. Evidence splits new/regression and names untested environments.
