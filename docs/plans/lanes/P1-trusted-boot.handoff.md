# P1 trusted plugin startup handoff

**Status:** author implementation and focused checks complete; independent review and hosted
integration remain root duties. **Date:** 2026-11-01. **Base:** `af254dae`.
**Branch:** `lane/p1-trusted-boot`. Plan `2639e162`; implementation `f297769e`.

## Implemented scope

- Real node/ordinary CLI startup reads enabled T1 installations under `<dataDir>/plugins`
  after core plugins and before the listener. Empty state is unchanged. A trusted host can
  override the directory; no HTTP, UI or agent-controlled option was added.
- `manager.bootEntries()` captures validated enabled identities and canonical integrity in
  one state read; existing `bootSet()` remains compatible. Startup selects `recover: false`,
  so retained/unreferenced installation directories and enabled/lock bytes are preserved.
- Fresh private snapshots are hashed against the captured pin before import. A confined ESM
  package `main` and default plugin export must match the validated package manifest. Core
  ids/services/slots, duplicate providers, missing dependencies and cycles fail closed;
  required providers load before consumers.
- Failure rolls back prior registered addon activations and their snapshot files and aborts
  node startup. Normal close disposes addon effects once and removes runtime snapshots before
  core/database cleanup. Typed errors/reports contain stable codes and valid plugin ids, not
  raw source, filesystem paths or imported exception text.
- `guanxi --safe-mode --no-open` and the host safe-mode option bypass addon state and imports
  while keeping core session/run/connection/native services. The CLI refuses to attach an
  already-running node and mislabel it as safe mode. New launcher messages have English source
  and curated Russian locale keys; existing agent/relay JSON modes are untouched.

No dependency, DB migration, REST schema, model prompt/tool set, MCP or skills exposure changed.
No third-party source was copied. The manager library still owns installation/enabling;
registry, build-script execution and install UI/CLI remain future slices.

## Evidence — new / regression

**New: 31 tests**, all in `packages/server/test/plugins/startup.test.ts`:

- real node and ordinary CLI default loading; exactly-once close; safe-mode malformed-state
  recovery with all core services present; existing-node safe-mode refusal;
- absent/disabled/missing/tampered state; retained unreferenced data; SRI base64 compatibility;
  malformed skipped ids cannot echo source-like data;
- reverse service dependency order; missing/cyclic dependencies; core id/service/slot and
  duplicate addon provider collisions; undeclared slot; four invalid entry variants; symlink
  refusal; export/package manifest mismatch; pinned T0 and T2 state refusal before import;
- apply rollback, listener refusal and same-state safe-mode recovery; snapshot removal,
  private permissions, fresh relative ESM graph on the second start; installed mutation after
  snapshot capture cannot substitute executed bytes; absent host SDK resolution is explicit.

**Regression: 41 inherited tests**, `plugins/manager.test.ts` and `kernel-plugins.test.ts`.
Assertions were not weakened. The focused union passed **72/72, zero skipped** at the final
source bytes of `f297769e` (the test run preceded its commit).

## Commands and results

New worktree setup: `npm ci`, then `node -e "console.log(require.resolve('@guanxi/contract'))"`
resolved inside this worktree. Node `v26.9.0`; ports 5262/4462, data `$PWD/.lane-data`. Tests
actually use private temporary directories and free ports. No Docker, remote host, inference,
paid provider, installed owner plugin or `~/.guanxi` data was used.

Heavy checks used `python3 -B /Users/yuzuru/.agents/skills/workstation-dev/scripts/dev.py run
--cwd "$PWD" --node 26 --resource heavy --lock-timeout 3600 -- <command>`:

| Command | Observed result |
| --- | --- |
| `node --import ./packages/server/test/setup/no-ambient-key-file.mjs --test packages/server/test/plugins/startup.test.ts packages/server/test/plugins/manager.test.ts packages/server/test/kernel-plugins.test.ts` | 72 pass, 0 fail, 0 skipped; `check-y11itkvw`, no source drift |
| `npm run typecheck --workspace @guanxi/server --workspace guanxi` | exit 0 at clean `f297769e`; `check-1d_33lpm`, no source drift |
| ESLint over changed production and test TS files | exit 0 |
| Targeted markdownlint on plugin README, plan and handoff | 3 files, 0 errors |
| `node scripts/check-doc-links.mjs` | 336 files, 918 links, 0 problems |
| `git diff --check` | exit 0 |

The first test attempt returned `resource_busy` without executing; a queued run then passed.
An initial typecheck exposed the test logger option (`log` instead of `onLog`); corrected,
then the final server/CLI typechecks passed. Earlier 21/69/71 test runs are iteration evidence,
not additional coverage. Receipts under `~/.local/state/agent-dev` remain non-reusable because
the tracked `.claude/skills/guanxi-ui` directory symlink is unsupported for source attestation.
Report the actual check results; root's exact hosted candidate provides final CI identity.

## Boundaries and next work

T1 has full process rights. Absolute/transitive imports, arbitrary logging and top-level
effects are not sandboxed; top-level effects cannot be undone by kernel rollback. This slice
does not claim isolation, general SDK delivery or native/plugin UI integration. Snapshot
packages must be bundled/self-contained or include their own dependencies; host
`@guanxi/kernel` is not inherited through ancestor `node_modules`. A bundled second kernel's
slot helpers have a separate context registry; a shared plugin SDK/slot bridge remains to
implement. Context-based services/effects are the validated portable surface here.

Node retains ESM module records until process exit even after files are removed. Runtime
snapshots get fresh paths at each start, and updates require restart. Process kills can leave
private temporary snapshots; there is no automatic sweep. Concurrent installed-state changes
may make startup fail closed or observe the earlier committed version; it does not hot-reload.
Existing manager recovery/power-loss and lock-timeout residuals remain documented.

P1 remains partial: MCP needs its K4 duplex sandbox transport, skills/native loop wiring needs
its benchmark gate, and plugin management/SDK/UI surfaces remain. No live/Fedora, packaged-DMG,
hardware-signing or final hosted claim follows from these local checks. Root assigns a separate
read-only reviewer; review fixes must be separate commits before integration and hosted CI.
