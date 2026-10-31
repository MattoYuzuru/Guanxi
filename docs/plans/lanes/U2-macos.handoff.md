# U2-macos — hand-off

**Status:** first slice implemented and locally validated on the owner's Mac; not reviewed (no self-review by
instruction), no hosted CI run · **Updated:** 2026-11-01 · **Branch:** `lane/u2-macos` (from `lead/wave8`
`2b8cf843`) · **Ports:** 5241 / 4441 · **Plan:** [U2-macos.plan.md](U2-macos.plan.md)

## What changed

- New workspace `packages/desktop` (`@guanxi/desktop`): Electron 44.9.0 main + sandboxed preload, service
  handshake, detached service, failure screens (en/ru), navigation lock, platform adapter, disabled update
  stub, electron-builder config, service staging script. See its [README](../../../packages/desktop/README.md).
- **Service lifetime decision:** a detached child process (own process group) of the CLI entry, run by a real
  Node.js (the pinned one staged into the app; the `node` on `PATH` in a checkout); it survives window close
  **and** app quit. launchd is the next slice (plan, Decision 1). *(The first cut ran it as the Electron binary
  with `ELECTRON_RUN_AS_NODE`; review M1 below replaced that.)*
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
| `npm test --workspace @guanxi/desktop` | `tests 127 / suites 29 / pass 127 / fail 0 / skipped 0` (after the review fixes; 87 before) |
| `agent-dev run --resource heavy -- npm run test:electron --workspace @guanxi/desktop` | first cut: exit 0, 0 failed, 0 skipped, 31 tests (receipt `/Users/yuzuru/.local/state/agent-dev/check-mgxjqgzl/result.json`, HEAD `7ef4ce72`); after the review fixes see "Review findings and fixes" |
| `npm run typecheck --workspace @guanxi/desktop` | clean |
| `npx eslint packages/desktop scripts/ci` | clean |
| `npm run check:licenses` | `checked 875 packages, 0 not allowed` |
| `node --test scripts/ci/ci.test.mjs` | `tests 10 / pass 10 / fail 0` (inventory accepts the new workspace) |
| `npm run lint:md` | `Summary: 0 error(s)` over 328 files; links `checked 327 files, 865 links, 0 problems` |
| `npm run package:mac`-equivalent (`electron-builder --mac dmg`, unsigned) | first cut `release/guanxi-desktop-0.1.0-arm64.dmg`, 132 MB (now 187 MB with the bundled Node); `Resources/service/{bin.js,node_modules,web,node,...}` present |
| Packaged-app smoke (script, `release/mac-arm64/Guanxi.app`, port 4447, temporary data dir) | service started from `Contents/Resources/service/bin.js`, `/api/health` ok, UI document served, service **alive after the app was terminated** |

### New / regression envelope

- **New (first cut):** unit 87, Electron 31. **After the review fixes:** unit 127 in 11
  files, Electron 43 in 10 files (see the review section).
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

## Review findings and fixes

Independent review of `7ef4ce72`/`e5b2e8f4`: 1 High, 6 Medium, 8 Low. Fixed in `ced82d9f` (code and tests) and
the documentation commit after it. Each fix has a test; the mutation column is a negative control (the source
was broken, the named file failed, the source restored).

| Finding | Fix | Evidence |
| --- | --- | --- |
| **H1** all permissions denied, so `navigator.clipboard.writeText` (every copy button) failed with NotAllowedError | `allowPermission` is per request: top frame of the service origin gets `clipboard-sanitized-write` and `fullscreen`; `notifications` stays denied on purpose (NC1 owns OS delivery through the shell), `clipboard-read`, media, geolocation and the rest too | `permissions.test.ts`: a real click copies to the system clipboard, the page cannot read it, notifications/geolocation/microphone denied (the test saves and restores the owner's clipboard); `security.test.ts` pins subframes, other origins and the status page; mutation `deny-all-permissions` fails the copy test. Fullscreen is unit-tested only (hidden test windows cannot enter native fullscreen) |
| **M1** `ELECTRON_RUN_AS_NODE` leaks to every child (`bash.ts` passes `...process.env`) | **Not done as asked.** Deleting the variable at the service entry would break the node: `native-agent/sandbox.ts` forks `process.execPath` with an explicit environment and `store/pinned-directory.ts` spawns it, which on the Electron binary starts the GUI. So the service no longer runs on Electron at all: a pinned official Node.js 26.9.0 (SHA-256 pinned in `stage-service.mjs`) is staged at `Resources/service/node/bin/node`, a checkout uses the `node` on `PATH`; `RunAsNode` fuse **off** (read back with `@electron/fuses read`: "RunAsNode is Disabled"); `ELECTRON_*`, `NODE_OPTIONS`, `HOST`, `PORT` and the shell's settings are not passed. The plan's impact statement is corrected (code run through the app binary has the signed identity that Keychain ACLs trust). The dedicated Node is marked a **blocking item before any signed release** in the README and plan, and is done | `service-lifetime.test.ts` (the fixture service and a tool it starts have no `ELECTRON_*`, `NODE_OPTIONS`, `HOST`, shell-setting key and are not on Electron; this assertion replaced the old one that expected `ELECTRON_RUN_AS_NODE=1`, which was the behaviour being removed), `locate.test.ts`, `packaging-config.test.ts` (fuse pinned off); mutation `leak-electron-env`. Packaged unsigned app re-smoked: service from the bundled Node, UI served, alive after the app was terminated |
| **M2** a process imitating the health document on the port is attached to | Before every attach (handshake and recovery) `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpu`: all listeners must be this user's (`port_owned_by_other_user`; a listener this user cannot see counts as another user's), a lookup failure is `port_unverified`, a shell-started service must be the manifest pid and a service started in this handshake the spawned child (`port_busy`). Localized screens for all three. The same-user impostor stays a U3 residual | `owner.test.ts`, `handshake.test.ts` (fake listeners for every verdict, including after our own spawn); the real happy path runs `lsof` in the Electron tests |
| **M3** stale manifest could send SIGTERM to a reused pid | The manifest is removed on every path where the process the handshake started is not the service (lost race, `port_busy` after terminate, child exited and attached elsewhere, `service_exited`, confirmed-stopped `health_timeout`); a manifest whose pid is dead or whose command line (`ps -p <pid> -o command=`) lacks the manifest entry is stale and removed (`liveManifestPid`); `stopService` verifies the command line before signalling | `owner.test.ts`, `launcher.test.ts` (reused pid: nothing signalled, manifest removed), `handshake.test.ts` |
| **M4** no CSP; no handling of a lost interface | CSP header on every response of the service origin (`contentSecurityPolicy`, appended so it can only narrow). `did-fail-load` (main frame, not abort/blocked) and `render-process-gone` show a `load_failed` status screen and restart recovery | `content-security.test.ts` (header on page and API; the page's own load-time `new Function` gets EvalError; blob worker, inline script work), `real-service.test.ts` (the real built UI mounts after a reload with no CSP violation and no failed request: Vite assets, fonts, workers), `interface-loss.test.ts` (crash and dead service recover by themselves); mutations `no-csp`, `no-interface-loss`. One earlier assertion changed: the frame check in the remote-content test used the iframe `load` event, which a CSP-blocked frame still fires; it now asserts that no frame shows the remote origin, with the zero-hits assertion on the counting remote kept |
| **M5** lifetime gate did not discriminate detachment | `service-lifetime.test.ts` compares the service's process group with the shell's (`ps -o pgid=`) and requires it to lead its own; new `process-group.test.ts` starts the shell as a plain process in its own group, SIGKILLs the whole group and checks the service is alive and answering | mutations `no-detach` and `no-detach-lifetime` (`detached:false`) both fail |
| **M6** licensing | ADR-0016 **not** amended. `OPEN_QUESTIONS.md` Q-246 (Electron's dynamically linked LGPL `libffmpeg.dylib`, Chromium components, the Node.js binary and its bundled licenses in the app; default: approve) and Q-247 (build-time WTFPL `truncate-utf8-bytes`; default: approve, alternative `@electron/packager`); `THIRD_PARTY_NOTICES.md` rows for Electron, Chromium and the Node.js binary; the license-gate exception now points at Q-247. README and this hand-off: **a distributed DMG waits on Q-246/Q-247**; unsigned local builds do not | `lint:md`, `check:licenses` |
| **L1** `openExternal` | Main-frame navigations only, a real user gesture (`input-event` mouse/key/touch) within 2 s, one open per gesture, three per ten seconds, subframes never. **Pinned test changed on purpose:** "a script navigating the window to another origin is stopped" used to expect the scripted URL to reach the system browser; it now asserts it does not (no gesture) and the click-driven cases still open | `external-open.test.ts`, `navigation-lock.test.ts` (scripted navigation and scripted `window.open` open nothing, a click opens), `external-rate-limit.test.ts` (six clicks, exactly three opens); mutation `no-user-activation` |
| **L2** brand strings | `PRODUCT_ENV_PREFIX` added to the brand module; the IPC channel, bridge name, env-variable names (shell and packaging config), the `GUANXI_API_PORT` advice (`{portVariable}`) and the staged package name derive from it | `messages.test.ts` |
| **L3** persisted port setting | Residual (above). The `port_busy` advice is now actionable for a Dock-launched app: close the other program and reopen; the variable is for a terminal start | `messages.test.ts` |
| **L4** `process.kill` EPERM | `stopService` catches it (`not_permitted` screen text; ESRCH becomes `not_running`); the menu handler has a catch | `launcher.test.ts` |
| **L5** SIGTERM only | `terminate()` sends SIGTERM then SIGKILL to the process group and confirms exit; "stopped" is shown only when confirmed, otherwise the pid is named | `launcher.test.ts` (ignores SIGTERM; grandchild in the group), `handshake.test.ts` |
| **L6** weak Node-globals test | A probe of the preload's isolated world (id 999) added: `nodeIntegration:true, sandbox:false` alone now fails it | mutation `node-integration-only`: 2 fail |
| **L7** docs | broken sentence in `docs/operations/ci.md` fixed; "retry link" and the `<title>` claim removed from the plan (no Retry controls, D-203; the probe uses `<div id="root">`) | `lint:md` |
| **L8** | stated under Residual risk: hosted `desktop`/`desktop-electron` unverified until the wave PR | |

### Results after the review fixes (HEAD `ced82d9f` plus the documentation commit)

| Command | Result |
| --- | --- |
| `npm test --workspace @guanxi/desktop` | `tests 127 / suites 29 / pass 127 / fail 0 / skipped 0` |
| `agent-dev run --resource heavy -- npm run test:electron --workspace @guanxi/desktop` | exit 0; `tests 43 / pass 43 / fail 0 / skipped 0` (renderer-isolation 7, service-lifetime 3, navigation-lock 11, permissions 4, failure-screens 9, real-service 3, content-security 2, interface-loss 2, external-rate-limit 1, process-group 1). Receipt `/Users/yuzuru/.local/state/agent-dev/check-zq5owdki/result.json` (taken on the tree that became `ced82d9f`) |
| `npm run typecheck --workspace @guanxi/desktop` | clean |
| `npx eslint packages/desktop scripts/ci` | clean |
| `npm run check:licenses` | `checked 875 packages, 0 not allowed` |
| `node --test scripts/ci/ci.test.mjs` | `tests 10 / pass 10 / fail 0` |
| `npm run lint:md` | `Summary: 0 error(s)` over 328 files; links `checked 327 files, 867 links, 0 problems` |
| unsigned DMG + packaged smoke | `guanxi-desktop-0.1.0-arm64.dmg` 187 MB; fuses read back (RunAsNode Disabled, EnableNodeOptionsEnvironmentVariable Disabled, OnlyLoadAppFromAsar Enabled, EmbeddedAsarIntegrity Enabled); service started from the bundled Node, UI served, alive after the app was terminated |

New in this round: unit 40, Electron 12 (43 total, 31 before). Envelope unchanged: `ci.test.mjs` 10.

Two things found while fixing, outside the review list: a hung `permissions.test.ts` run (an attempted native
fullscreen of a hidden window never settles; the Electron fullscreen test was removed, see above), and the shared
scratchpad `mutate.py` of another agent overwriting mine (mutation scripts now live in a private subdirectory).

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
- The `RunAsNode` fuse is **off** and every other fuse is closed (review M1); the service runs on its own pinned
  Node.js. The Node binary is 146 MB (DMG 187 MB); its digest is pinned in `scripts/stage-service.mjs` and must
  be bumped deliberately for Node security releases (26.9.0 is the version CI runs).
- Fullscreen is allowed by policy but unit-tested only: a hidden test window cannot enter native fullscreen, so
  an Electron test cannot tell allowed from denied.
- Inline script and style stay allowed in the shell's CSP because the built `index.html` has an inline theme
  bootstrap; a nonce or hash from the web build would tighten it.
- A port the user must change has no persisted setting (review L3): `GUANXI_API_PORT` from a terminal start is
  the only way; a Dock-launched app needs a settings file, next slice.
- Ownership checks use `lsof` (macOS); U6 must give Linux its own lookup (`ss`/`/proc`), and the check fails
  closed (`port_unverified`) where `lsof` is absent.
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
- Shared-lock note: the full Electron run was made under `agent-dev --resource heavy`; single-file runs during
  development were not.
- **Hosted CI is unverified (review L8):** the new `desktop` and `desktop-electron` tasks have never run on
  GitHub runners (macOS needs a window server for Electron; the real-service test builds the web UI); they are
  verified only when the wave PR runs. A distributed DMG also waits on Q-246 and Q-247 (review M6).

## Next slice (U2-b)

1. launchd user agent plus login item (`SMAppService`), shell attaches to it; uninstall; upgrade replacing the
   running binary safely; service update waits for idle (needs an "active runs" API in the contract).
2. Menu-bar (tray) presence and quit behaviour; notification-center hooks (NC1).
3. A real signed and notarized build with the owner's credentials; app icon; DMG background.
4. Auto-update implementation (`electron-updater`, design in the plan); channel and rollback.
5. Authenticated handshake after U3; a persisted port setting for a Dock-launched app.
6. U6: `src/platform/linux.ts`, `linux` section in `electron-builder.config.mjs`, Fedora rpm, then AppImage and
   Flatpak, with the `desktop-electron` job duplicated for a Linux runner (xvfb).
7. Lead: add a row for this lane to the lanes table, fold this hand-off into the status files, and consider the
   `node packages/cli/dist/bin.js --version` smoke in CI (finding 2).
