# U2-macos — hand-off

**Status:** first slice implemented and locally validated on the owner's Mac; not reviewed (no self-review by
instruction), no hosted CI run · **Updated:** 2026-11-01 · **Branch:** `lane/u2-macos` (from `lead/wave8`
`2b8cf843`) · **Ports:** 5241 / 4441 · **Plan:** [U2-macos.plan.md](U2-macos.plan.md)

## What changed

- New workspace `packages/desktop` (`@guanxi/desktop`): Electron 44.9.0 main + sandboxed preload, service
  handshake, detached service, failure screens (en/ru), navigation lock, platform adapter, disabled update
  stub, electron-builder config, service staging script. See its [README](../../../packages/desktop/README.md).
- **Service lifetime decision:** a detached child process of the CLI entry, run by Electron's own Node
  (`ELECTRON_RUN_AS_NODE=1`); it survives window close **and** app quit. launchd is the next slice (plan,
  Decision 1). Verified on this Mac that Electron 44.9.0's Node (v24.22.0) has `node:sqlite` and runs the
  repository's CLI, source and bundle.
- Exit gate (ROADMAP U2): window close during a run does not stop it (fake run in the fake service, plus the
  real service's process lifetime); the renderer has no Node access (test, with negative controls below).

### Shared edits (outside `packages/desktop`)

| File | Change | Why |
| --- | --- | --- |
| `packages/contract/package.json` | export `./brand` | the shell bundles the brand module without pulling zod/contract |
| `packages/cli/scripts/build.mjs` | banner gives the ESM bundle a `require` | **found bug:** `node packages/cli/dist/bin.js` fails at load ("Dynamic require of node:assert", bundled `undici`); the packaged service could not start. `packages/server/scripts/build.mjs` has the same defect (not touched; the app does not use `server.js`) |
| `scripts/check-licenses.mjs` | `REVIEWED` entry for `truncate-utf8-bytes@1.0.2` (WTFPL) | transitive of electron-builder (`sanitize-filename`), build-time only, never shipped. **Owner may veto**; the alternative is the `@electron/packager` chain |
| `scripts/ci/tasks.mjs`, `docs/operations/ci.md` | classify the workspace; tasks `desktop` (Linux units) and `desktop-electron` (macos-15) | `validateInventory` would fail otherwise; fourteen tasks now |
| `eslint.config.mjs` | ignore `packages/desktop/.stage/**` and `release/**` | generated output |
| `docs/decisions/0026-clients-desktop-web-mobile.md` | implementation-update paragraph | status stays `proposed` |
| `package-lock.json` | this lane's own `npm install` (no existing package version changed; checked against `lead/wave8`) | integrator regenerates |

## Commands and results

All from the worktree root with `GUANXI_API_PORT=4441`, `GUANXI_WEB_PORT=5241`, lane data dir where a server
runs; Electron tests use per-scenario temporary directories and free ports, never `~/.guanxi`.

| Command | Result |
| --- | --- |
| `npm test --workspace @guanxi/desktop` | `tests 87 / suites 19 / pass 87 / fail 0 / skipped 0` |
| `agent-dev run --resource heavy -- npm run test:electron --workspace @guanxi/desktop` | exit 0, 5 suites, 0 failed, 0 skipped (the receipt redacts the test count; per file below: 6 + 3 + 11 + 9 + 2 = 31). Receipt `/Users/yuzuru/.local/state/agent-dev/check-mgxjqgzl/result.json`, HEAD `7ef4ce72`, 19 s |
| `npm run typecheck --workspace @guanxi/desktop` | clean |
| `npx eslint packages/desktop scripts/ci` | clean |
| `npm run check:licenses` | `checked 875 packages, 0 not allowed` |
| `node --test scripts/ci/ci.test.mjs` | `tests 10 / pass 10 / fail 0` (inventory accepts the new workspace) |
| `npm run lint:md` | `Summary: 0 error(s)` over 328 files; links `checked 327 files, 865 links, 0 problems` |
| `npm run package:mac`-equivalent (`electron-builder --mac dmg`, unsigned) | `release/guanxi-desktop-0.1.0-arm64.dmg`, 132 MB; `Resources/service/{bin.js,node_modules,web,...}` present |
| Packaged-app smoke (script, `release/mac-arm64/Guanxi.app`, port 4447, temporary data dir) | service started from `Contents/Resources/service/bin.js`, `/api/health` ok, UI document served, service **alive after the app was terminated** |

### New / regression envelope

- **New:** unit 87 in 10 files (`packages/desktop/test/unit`); Electron 31 in 5 files (renderer-isolation 6,
  service-lifetime 3, navigation-lock 11, failure-screens 9, real-service 2).
- **Envelope (run in full, not credited as new):** `scripts/ci/ci.test.mjs` 10.

### Negative controls (the tests fail when the property is violated)

Each mutation was applied to `src/`, the bundle rebuilt, the named file run, then the source restored.

| Mutation | Result |
| --- | --- |
| `contextIsolation:false, nodeIntegration:true, sandbox:false` | renderer-isolation: 3 of 6 fail (Node globals visible, bridge shape, preferences) |
| navigation guards removed (`will-navigate`/`redirect`/`frame-navigate`) | navigation-lock: 4 fail (external link, scripted navigation, redirect, remote content) |
| `setWindowOpenHandler` returns `allow` | navigation-lock: 4 fail |
| request filter returns `cancel:false` | navigation-lock: the remote-content test fails (the counting remote server is hit) |
| app kills the service at `will-quit` | service-lifetime: 3 of 3 fail |

A unit test also caught a real bug during the lane: a response body cut by the probe timeout was classified
`foreign` instead of `hung` (`src/service/probe.ts`; fixed before the second commit).

## Findings outside the lane (not fixed)

1. **CLI single-instance probe is stale.** `packages/cli/src/existing.ts` identifies a running UI by
   `<title>Guanxi</title>`, but the built `index.html` has an empty `<title>` (set at runtime by
   `packages/web/src/main.tsx`), so a second `guanxi` on the same port reports "port busy" instead of
   attaching. The shell's probe does not use the title.
2. `packages/cli/dist/bin.js` did not run at all before the banner fix above; nothing in CI executes the
   bundle. A smoke (`node packages/cli/dist/bin.js --version`) in the CI `build` task would catch a repeat.
3. The node has no local authentication, so the shell's service identity check is shape-based (plan,
   Decision 3). ADR-0026 asks for an authenticated handshake; that needs U3.

## What could not be run on this Mac

- **Signing and notarization** (no credentials by design). `GUANXI_DESKTOP_SIGN`/`NOTARIZE` paths are covered
  only by config unit tests; the first real signed build may need entitlement changes (for example library
  validation for the `.node` prebuilds inside `Resources/service/node_modules`; electron-builder re-signs
  them with the owner's identity, which should be enough, but it is untested).
- Mounting the DMG, quarantine/Gatekeeper behaviour of a downloaded copy, running from `/Applications`.
- The hosted `desktop` and `desktop-electron` CI tasks (new; never run on GitHub runners). The macOS runner
  needs a window server for Electron; hidden windows are used (`GUANXI_DESKTOP_TEST_HIDDEN`), which should
  work, but is unverified. `real-service.test.ts` runs the web build if `packages/web/dist` is missing.
- Intel/universal builds (arm64 only), Linux, Windows (D-221: not built).
- A **real model run** through the window: no Ollama or paid provider is used. The survival of an
  actual agent run is proved only by the fake service's tick counter plus the real service's process
  lifetime and health. The node's own restart reconciliation after a crash is the existing R1 behaviour,
  untouched.
- The app icon: the default Electron icon is used (builder warning `application icon is not set`). The brand
  assets under `assets/brand` need an `.icns`.

## Owner steps for signing and notarization

Decision first: ADR-0026 §5 defers the Apple Developer account to after the PWA (D-156). A Developer ID
certificate and notarization need the **paid Apple Developer Program**, so the macOS release depends on that
decision; the unsigned DMG works without it (right-click Open on first launch).

1. Enrol the team in the Apple Developer Program.
2. Choose the **bundle id** (reverse DNS of a namespace you control) and set `GUANXI_DESKTOP_APP_ID`. It cannot
   change after the first release without losing Keychain items and privacy grants.
3. Create a **Developer ID Application** certificate (developer.apple.com > Certificates; the CSR comes from
   Keychain Access). Export it with its private key as `.p12` with a password. Provide `CSC_LINK` (path or
   base64 of the `.p12`) and `CSC_KEY_PASSWORD` as secrets of a protected CI environment, never in the
   repository.
4. Create an **App Store Connect API key** (Users and Access > Integrations; the Developer role suffices for
   notarization). Download the `.p8` once. Provide `APPLE_API_KEY` (path of the `.p8` written from a secret at
   build time), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. (Alternatives accepted by the config:
   `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN` +
   `APPLE_KEYCHAIN_PROFILE`.)
5. Build on the Mac or a macOS runner:

   ```bash
   GUANXI_DESKTOP_SIGN=1 GUANXI_DESKTOP_NOTARIZE=1 GUANXI_DESKTOP_APP_ID=... \
     npm run package:mac --workspace @guanxi/desktop
   ```

6. Verify the result: `codesign --verify --deep --strict --verbose=2 Guanxi.app`,
   `spctl --assess --type execute -vv Guanxi.app`, `xcrun stapler validate Guanxi.app`; then install the DMG on
   a second Mac that downloaded it (quarantine attribute set) and start it.
7. Add a manual-dispatch release workflow only after steps 1 to 6 work locally; keep credentials in an
   environment with required reviewers.

## Residual risk

- **Spoofable port:** any local process that imitates the health document can be shown by the shell until U3.
  The renderer is sandboxed and receives nothing but `info()` (and only from the service origin).
- **`RunAsNode` fuse stays on** so the service can run under the app binary; the other fuses are closed. A
  process that can exec the app binary as the user can run JS with the app's entitlements. Follow-up: bundle a
  dedicated Node for the service and turn the fuse off.
- **No service supervision:** if the service dies while the UI is shown, the web UI shows its own offline
  states and the user uses Reconnect (Cmd-R). The shell does not auto-restart it (that would also fight the
  explicit "Stop background service" action). launchd (next slice) is the supervisor.
- A service started by the CLI or a lane script has no manifest, so "Stop background service" refuses it
  (`not_managed`) by design.
- A pid recycled by the OS while a stale manifest exists is guarded by also requiring the port to answer as
  Guanxi, not by checking the listener pid.
- Remote images in model markdown are cancelled by the request filter (privacy by default); if a product
  decision wants them, it must be an explicit setting, not a loosened filter.
- Staged service is 60 MB of `node_modules` (tree-sitter grammars); DMG is 132 MB. Pruning is minimal.
- `NODE_OPTIONS` from the environment is not passed to the service.
- Shared-lock note: Electron tests were run under `agent-dev --resource heavy` once at the end; the
  intermediate runs during development were not.

## Next slice (U2-b)

1. launchd user agent plus login item (`SMAppService`), shell attaches to it; uninstall; upgrade replacing the
   running binary safely; service update waits for idle (needs an "active runs" API in the contract).
2. Menu-bar (tray) presence and quit behaviour; notification-center hooks (NC1).
3. Dedicated Node for the service; turn `RunAsNode` off.
4. A real signed and notarized build with the owner's credentials; app icon; DMG background.
5. Auto-update implementation (`electron-updater`, design in the plan); channel and rollback.
6. Authenticated handshake after U3.
7. U6: `src/platform/linux.ts`, `linux` section in `electron-builder.config.mjs`, Fedora rpm, then AppImage and
   Flatpak, with the `desktop-electron` job duplicated for a Linux runner (xvfb).
8. Lead: add a row for this lane to the lanes table, fold this hand-off into the status files, and consider the
   `node packages/cli/dist/bin.js --version` smoke in CI (finding 2).
