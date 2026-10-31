# U2-macos — Electron thin shell for macOS: plan

**Status:** plan (implementation follows in this lane) · **Updated:** 2026-11-01 ·
**Branch:** `lane/u2-macos` · **Base:** `lead/wave8` `2b8cf843` · **Ports:** 5241 / 4441 ·
**Decisions:** D-221 (macOS first, Linux/Fedora second, Windows last) · **ADR:**
[0026](../../decisions/0026-clients-desktop-web-mobile.md) (proposed; this slice implements part of §1)

## Goal and non-goals

U2's first slice: an Electron shell for macOS that is a thin window over the background Guanxi node
service on loopback. Exit gate of the stage (ROADMAP U2): **closing the window during a run does not stop
the run; the renderer has no Node access (test).**

In this slice: the `@guanxi/desktop` package, service handshake, sandboxed renderer, navigation lock,
visible localized failure states, DMG packaging configuration with signing and notarization wired through
environment variables (not executed), a disabled auto-update stub with a design note, and platform
isolation so U6 can add a Fedora rpm without reshaping the package.

Not in this slice: launchd agent and login auto-start, menu-bar (tray) icon, auto-update implementation,
authenticated handshake (needs server work, U3), Windows, a notarized build, a real model run through the
window (needs Ollama or a paid provider; see the test matrix for what is proved instead).

## Decision 1 — who owns the service lifetime

Options:

| Option | Window close | App quit | Reboot / login | Cost |
| --- | --- | --- | --- | --- |
| A. Child of the Electron main (`spawn`, not detached) | survives | **stops** | gone | smallest, but quitting the app kills runs |
| B. **Detached child** (`detached: true`, `unref()`, stdio to a log file) started by the shell | survives | **survives** | gone until the shell is opened again | small; no OS integration |
| C. launchd user agent (`~/Library/LaunchAgents`) | survives | survives | **restarts** | plist generation, install/uninstall, `launchctl bootstrap` states, signed helper path, upgrade story |

**Chosen: B for this slice; C is the next slice.** B satisfies the exit gate (the window and even the app
may close while a run continues) and keeps the shell a client: it attaches to a service that is already
listening, whoever started it (CLI, an earlier shell, a lane script), and starts one only when the port is
closed. C is deliberately postponed because it is a lifecycle product of its own (login item consent on
macOS 13+, `SMAppService`, uninstall, upgrade replacing the running binary); the handshake and the
service-location code written here are the same code C will call, so nothing is thrown away.

The shell never stops a service it did not start in this process, with two exceptions the user triggers
explicitly: the menu item "Stop background service…" (confirmation dialog that says runs end) and the
automatic cleanup of a child that it started itself and that never became healthy (`health_timeout`).
Quitting the app (Cmd-Q) and closing the last window never signal the service.

Bookkeeping: `<dataDir>/desktop/service.json` (mode 0600: `pid`, `port`, `startedAt`, `entry`) and
`<dataDir>/desktop/service.log` (service stdout/stderr, startup lines only; the node does not log
workspace contents, AGENTS.md). The manifest is a hint for the stop action and diagnostics, never an
authority: Stop signals the pid only if the manifest pid is alive **and** the loopback health probe on the
manifest port answers as Guanxi.

## Decision 2 — what runs the service

The service is the existing CLI entry (`packages/cli/src/bin.ts` in the checkout, `packages/cli/dist/bin.js`
in the app), started as `bin --port P --data-dir D --no-open`, so the shell reuses the CLI's single-instance
probing (`existing.ts`), static web serving and loopback default instead of embedding the server in the
Electron main (which would tie runs to the shell's lifetime and move SQLite/secrets into the shell process,
against the AGENTS.md invariant that the node owns them).

- **Packaged app:** a pinned official Node.js (26.9.0, the version CI runs; SHA-256 pinned in
  `scripts/stage-service.mjs`) at `Resources/service/node/bin/node` running `Resources/service/bin.js`. No
  system Node is required on the user's Mac, and the `RunAsNode` Electron fuse is **off**.
  *History (review M1, 2026-11-01):* the first cut ran the service as `Electron` with `ELECTRON_RUN_AS_NODE=1`
  and kept the fuse on. That is wrong for two reasons. (1) Impact: the fuse is not only "something already
  running as the user"; code run through the app binary executes under the app's **signed code identity**, and
  the Keychain ACL of items the app creates trusts that identity, so any process that can exec the binary could
  read them. (2) The node itself forks and spawns `process.execPath` for its sandbox, index and storage helpers
  (`native-agent/sandbox.ts` forks with an explicit environment, `store/pinned-directory.ts` spawns it), which
  under Electron would start the GUI instead of a script; deleting `ELECTRON_RUN_AS_NODE` from the service's
  environment, as first proposed, would break the helpers that currently work only because the variable
  leaks. A real Node fixes both. This is a **blocking item** that was done in this slice, not left as a follow-up.
- **Development checkout:** the `node` on `PATH` runs `packages/cli/src/bin.ts` (`<PREFIX>_DESKTOP_SERVICE_ENTRY`
  and `<PREFIX>_DESKTOP_NODE` may point elsewhere; honoured only when the app is not packaged, so an installed
  app cannot be redirected through the environment). The child's environment drops every `ELECTRON_*`
  variable, `NODE_OPTIONS`, `HOST`, `PORT` and the shell's own settings, because the service starts the user's
  tools with it.
- Port and data directory use the node's own variables: `GUANXI_API_PORT` (default 4310) and
  `GUANXI_DATA_DIR` (default `~/.guanxi`). The shell passes them explicitly as flags too. Lane runs
  therefore use the lane exports and never touch `~/.guanxi`.

## Decision 3 — handshake

```text
resolve config (port, dataDir, locale)
  → probe 127.0.0.1:port
      ready (Guanxi health + UI)          → attach, load UI
      closed (connection refused)         → locate entry → spawn detached → poll until deadline
      ui_missing (Guanxi API, no UI)      → error ui_missing
      foreign / hung listener             → error port_busy
  polling ends: ready → load UI | child exited → service_exited | deadline → health_timeout (kill own child)
  entry or runtime missing                → service_missing
```

Identity check: `GET /api/health` must be JSON with `ok === true`, a string `appVersion` and
`application.source === 'application_http'`; `GET /` must be the UI document (`<div id="root">`; not the
title, which the built page sets only at runtime, so `packages/cli/src/existing.ts` cannot use it either). **The
shape is not authentication.** Ownership is checked too (review M2) before the shell attaches, both in the
handshake and in the recovery path: `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpu` must show listeners that all
belong to this user (`port_owned_by_other_user` otherwise, which also covers a listener this user cannot see;
`port_unverified` when the lookup fails); a service the shell started must be the very pid of the manifest
(`port_busy` otherwise), and a service started in this handshake must be the child that was spawned. Manifests
that name a dead pid, or a pid whose command line (`ps -p <pid> -o command=`) no longer contains the manifest's
entry, are stale and removed (review M3), and the stop action signals nothing it cannot match the same way.
**A same-user process that imitates the node is still indistinguishable** until local authentication exists.
ADR-0026 asks for an "authenticated handshake"; the node has no local authentication today
(`packages/server/src/app.ts`: loopback "let everything through"), so a hostile local process that squats
the port and imitates the health shape cannot be told apart. The renderer is sandboxed and the shell
exposes no secrets to it, which bounds the damage to a spoofed UI; real authentication lands with U3
(per-installation credential in the keychain). Recorded as a residual, not claimed.

Failure states are screens in the window, never silent: starting, `service_missing`, `port_busy`,
`health_timeout`, `service_exited`, `ui_missing`, `port_owned_by_other_user`, `port_unverified`, and `load_failed`
(the interface was lost after a good handshake: `did-fail-load` or `render-process-gone`). Each has a localized
title and explanation, the port and the log path where relevant, and **no button** (D-203: no Retry controls):
the shell re-checks every 3 s and View > Reconnect (Cmd-R) runs the full handshake. A child that never became
healthy is ended with SIGTERM and then SIGKILL on its process group, and the screen says "stopped" only once the
child is confirmed gone. Strings are locale keys in the shell's own catalogue (English source and fallback,
curated Russian), selected from the system's preferred languages.

## Decision 4 — renderer security

- `BrowserWindow.webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, `webviewTag: false`, `nodeIntegrationInWorker: false`,
  `nodeIntegrationInSubFrames: false`, `allowRunningInsecureContent: false`, `safeDialogs: true`.
- Preload (`contextBridge`, bundled to CommonJS because sandboxed preloads cannot be ESM): one frozen
  object `guanxiDesktop = { info() }`, `info()` returns `{ shell: 'electron', platform, shellVersion }`
  through a single validated `ipcMain.handle`. No generic IPC, no `ipcRenderer` leak, no file access.
- Navigation lock (applied to every `webContents` through `web-contents-created`, so popouts and
  iframes are covered): `will-navigate`, `will-redirect` and `will-frame-navigate` allow only the
  service origin `http://127.0.0.1:<port>` (and the shell's own `data:` status page when main loads it).
  `setWindowOpenHandler` denies by default; `http(s)` and `mailto:` URLs on another origin go to the system
  browser via `shell.openExternal` only for a main-frame navigation or `window.open` that follows a real user
  gesture (Electron's `input-event`: mouse, key, touch; one gesture opens one link), at most three per ten
  seconds (review L1); a script that navigates or opens on its own opens nothing. A same-origin `window.open` is allowed as a child
  window with the same hardened preferences because the web UI's workspace popouts
  (`/workspace-popout.html`) need it. `will-attach-webview` is denied.
- Session: `webRequest.onBeforeRequest` cancels every request that is not same-origin loopback
  (`http`/`ws` to the service origin) or a local `data:`/`blob:` URL, so remote content cannot load into
  the window even from content the node serves (for example images in a model's markdown). Every response of the
  service origin also gets a Content-Security-Policy header (`default-src 'self'`, connect to the node's
  origin and its WebSocket only, workers and previews from `blob:`, `object-src 'none'`; inline script and style
  stay allowed because the built `index.html` has an inline theme bootstrap, so a nonce or hash from the web
  build is a later tightening). Permissions (review H1): the top frame of the service origin gets
  `clipboard-sanitized-write` (every copy button) and `fullscreen`; everything else is denied, deliberately
  including `notifications` (the notification center, NC1, delivers OS notifications through the shell, not the
  Web Notification API), `clipboard-read`, and media (voice, V1, will grant the microphone deliberately).
- Fuses are set in the packaging step (`@electron/fuses` through electron-builder `electronFuses`):
  `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on, `EnableEmbeddedAsarIntegrityValidation`
  on, `GrantFileProtocolExtraPrivileges` off, `EnableNodeOptionsEnvironmentVariable` off and **`RunAsNode` off**
  (Decision 2).

## Decision 5 — platform isolation (D-221)

`src/platform/` holds everything that differs per OS behind one `PlatformAdapter` interface
(`id`, `appMenu(...)`, `quitWhenAllWindowsClosed`, `reopenOnActivate`, `serviceRuntime(...)`,
`packaging`): `darwin.ts` (dock behaviour, application menu, `Cmd` accelerators) and `generic.ts`
(used for everything else, which is Linux until U6 adds a `linux.ts` for rpm/AppImage/tray). Handshake,
navigation lock, messages and window code are platform-neutral and unit tested without Electron. The
packaging config keeps `mac` options in one function; U6 adds `linux` beside it. No Windows code.

## Decision 6 — packaging, signing, notarization, update

- electron-builder 26.17.0 (MIT) with `electron-builder.config.mjs`: `appId` is derived from an overridable
  variable (`GUANXI_DESKTOP_APP_ID`) because the reverse-DNS bundle id needs a domain or namespace the owner
  controls and **cannot change after the first signed release without losing Keychain and TCC grants**; the
  default is a placeholder that the config refuses for a signed build. `productName` and file names come from
  the central brand module (`@guanxi/contract` brand), not literals.
- `npm run package:mac --workspace @guanxi/desktop` builds the bundles, stages the service
  (`scripts/stage-service.mjs`: CLI dist with web assets plus production `node_modules`), and runs
  electron-builder for `dmg` + `zip`, arm64. Unsigned by default (`CSC_IDENTITY_AUTO_DISCOVERY=false`
  semantics through `GUANXI_DESKTOP_SIGN`), so a local DMG can be produced without credentials.
- Signing and notarization read only environment variables, never files in the repo: `CSC_LINK` /
  `CSC_KEY_PASSWORD` (Developer ID Application certificate) and notarization through either the App Store
  Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`; `GUANXI_DESKTOP_SIGN=1` turns hardened runtime signing on
  and `GUANXI_DESKTOP_NOTARIZE=1` turns notarization on. Entitlements are minimal (hardened runtime with the
  JIT/unsigned-executable-memory pair V8 needs, no network-server entitlement, no file-access exceptions).
  The owner steps (certificate, API key, repository secrets) are in the hand-off. Nothing here is run
  with credentials in this lane.
- Auto-update: **design note only plus a disabled stub** (`src/updater.ts` returns
  `{ state: 'disabled', reason: 'not_implemented' }` and has no network code). Design for the later slice:
  `electron-updater` (MIT) with a generic provider on the owner's `keykomi` host or GitHub Releases,
  signature verified by the notarized app identity, check on launch and daily, never replaces the app
  while a run is active in the service (the service is independent, so an app update does not touch it),
  but a *service* update must wait until no run is active (a new node API: `GET` of active runs, which does
  not exist in the contract yet). Staged rollouts and rollback are not designed here.

## Test matrix

| Claim | Test | How | Runs in |
| --- | --- | --- | --- |
| Renderer has no Node access | `renderer-isolation` | real Electron through Playwright `_electron`: in the page `typeof require`, `process`, `module`, `Buffer` are `undefined`; `window.guanxiDesktop` is frozen with exactly `info`; `webPreferences` read from main are as specified; preload's `ipcRenderer` is not reachable | darwin, Electron installed |
| Closing the window does not stop the service or a run | `service-lifetime` | real Electron, fake service (a Node script with a "run" that counts ticks into a file); close the window and quit the app; the service pid is alive, health answers, the tick counter keeps increasing; the same with the real CLI entry started by the shell (health only, no model); cleanup kills only pids the test started | darwin, Electron installed |
| Navigation and external-link lock | `navigation-lock` (unit, pure) and `navigation-electron` | unit: decisions for same-origin, other origin, `file:`, `javascript:`, `data:`, redirect targets, popout URLs; electron: link click to another origin and `window.open` leave the window URL unchanged and call the external opener (test seam), a `fetch` to another origin is cancelled | unit everywhere; electron on darwin |
| Handshake failure states are visible and localized | `handshake` (unit) and `failure-screens` (electron) | unit: `ready`, `closed→spawn→ready`, `ui_missing`, `foreign`, hung listener, `service_missing`, early exit, deadline with injected clock and spawn; electron: each screen in the window contains the localized text (en and ru) and the port | unit everywhere; electron on darwin |
| Packaging config is valid and has no secrets | `packaging-config` (unit) | config object has no credential values, signs/notarizes only on the opt-in variables, refuses the placeholder app id when signing, takes names from the brand module | everywhere |

Electron-launching tests need the Electron binary, which npm 11 does not download in `postinstall`
(install scripts are gated); `scripts/ensure-electron.mjs` runs Electron's own installer on demand and is
called by the test script. They are separate from the pure unit tests so a runner without a display or
without the binary still runs the unit set; the hand-off states which ran where. The shared lock
(`agent-dev --resource heavy`) wraps the Electron run on this Mac.

## Shared edits (outside the package)

- `scripts/ci/tasks.mjs`: classify the new workspace and its scripts so `validateInventory` stays green;
  one task for the desktop unit tests and one macOS task for the Electron tests.
- `eslint.config.mjs`: the new package is outside the React/CSS rules of `packages/web` (excluded like
  `server`/`cli`).
- `THIRD_PARTY_NOTICES.md` only if code is copied (none planned); license records in the package README.
- `package-lock.json` is changed only by this lane's own `npm install`; the integrator regenerates it.

## Verification plan

Scoped: `node --test packages/desktop/test/unit`, the Electron tests under the shared lock, `tsc --noEmit`
for the package, `npm run lint:md`, `npm run check:licenses`, `node --test scripts/ci/*.test.mjs` (inventory),
`eslint packages/desktop`. No `npm test`, no full builds beyond the package's own esbuild bundle and the
one-time CLI/web build needed to stage the service for the packaging smoke. Independent review is the
lead's separate action (this lane does no self-review).

## Next slice

U2-b: launchd agent with login item, tray/menu-bar presence, real notarized build with the owner's credentials, auto-update implementation, and
the service-update-waits-for-idle API. U6 then adds `linux.ts` and rpm.
