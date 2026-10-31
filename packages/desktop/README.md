# @guanxi/desktop

**Status:** implemented for macOS, first slice (U2) · **Updated:** 2026-11-01 · Linux (U6) and Windows are not built

The Electron thin shell. It shows the web UI that the local Guanxi node serves, and it never owns the
node. Design and decisions: [U2-macos plan](../../docs/plans/lanes/U2-macos.plan.md); product context:
[ADR-0026](../../docs/decisions/0026-clients-desktop-web-mobile.md), owner decision D-221 (macOS first, then
Linux with Fedora as reference, Windows last).

## What it does

1. Resolves the node's port and data directory from the node's own variables, `GUANXI_API_PORT` (default
   4310) and `GUANXI_DATA_DIR` (default `~/.guanxi`), and talks to `127.0.0.1` only.
2. **Handshake** (`src/service/handshake.ts`): probe the port. A Guanxi that answers is attached. A closed
   port starts the service as a **detached process** (the CLI entry, run by a real Node.js: the pinned one
   staged into the app, or the `node` on `PATH` in a checkout; never the Electron binary), with its output in `<dataDir>/desktop/service.log` and its pid in
   `<dataDir>/desktop/service.json`. The window loads the UI when the UI document and the health document
   both answer. Before it attaches it checks **who owns the port** (`lsof`: every listener must be this
   user's, and for a service the shell started the very manifest pid); other owners get a failure screen.
3. **Does not own the service.** Closing the window, quitting the app or crashing it never signals the
   service, so a run continues. The only ways the shell ends a service are the explicit menu action "Stop
   background service…" (confirmation dialog; only a service the shell started, only while its pid is alive
   and its port still answers as Guanxi, and its command line still names the manifest's entry) and removing a
   child it started itself that never became healthy (SIGTERM, then SIGKILL on its process group, confirmed
   gone before the screen says so).
4. **Failure screens** (`src/status-page.ts`): `service_missing`, `port_busy`, `health_timeout`,
   `service_exited`, `ui_missing`, `config_invalid`, plus progress and "stopped". English source, curated
   Russian (`src/messages.ts`; system language, `GUANXI_DESKTOP_LOCALE` overrides in an unpackaged app). The
   screens have no button: the shell re-checks every 3 s and picks up a service that appears; View >
   Reconnect (Cmd-R) runs the full handshake again.

## Security properties

| Property | Where | Test |
| --- | --- | --- |
| `contextIsolation`, `sandbox`, no `nodeIntegration` (also in workers and frames), `webviewTag` off | `src/security.ts` (`SECURE_WEB_PREFERENCES`), every window and popout | `test/electron/renderer-isolation.test.ts`, `test/unit/security.test.ts` |
| Permissions: only `clipboard-sanitized-write` (the copy buttons) and `fullscreen`, top frame of the service origin; notifications, clipboard read, media, geolocation and the rest are denied | `allowPermission` | `test/electron/permissions.test.ts`, `test/unit/security.test.ts` |
| A CSP on every response of the service origin | `contentSecurityPolicy`, `lockSession` | `test/electron/content-security.test.ts`, `real-service.test.ts` (the real UI loads without a violation) |
| External links open the system browser only after a real user gesture, one per gesture, three per ten seconds, main-frame navigations only | `src/external-open.ts`, `src/windows.ts` | `test/unit/external-open.test.ts`, `navigation-lock`, `external-rate-limit` |
| A lost interface (service gone, renderer crashed) shows a status screen and recovers | `src/main.ts` | `test/electron/interface-loss.test.ts` |
| One preload function, `guanxiDesktop.info()`, answered only for pages of the service origin | `src/preload.ts`, `src/windows.ts` | renderer-isolation, failure-screens |
| Navigation locked to `http://127.0.0.1:<port>`; other `http(s)`/`mailto` go to the system browser; everything else is dropped | `decideNavigation`, `decideWindowOpen` | `test/electron/navigation-lock.test.ts` |
| No remote content: every renderer request outside the service origin is cancelled; no permission is granted | `allowRequest`, `lockSession` | navigation-lock (a counting "remote" server sees zero hits) |
| The service is a separate, detached process of its own process group | `src/service/launcher.ts` | `test/electron/service-lifetime.test.ts` (process group), `process-group.test.ts` (SIGKILL to the shell's whole group), `test/unit/launcher.test.ts` |
| The service sees no `ELECTRON_*`, `NODE_OPTIONS`, `HOST` or shell setting, and neither does a tool it starts | `src/service/locate.ts` | `service-lifetime`, `test/unit/locate.test.ts` |
| The Electron `RunAsNode` fuse is off | `electron-builder.config.mjs` | `test/unit/packaging-config.test.ts` |

The identity check of the node is a health document of the right shape plus the owner check above; it is **not
authenticated** (the node has no local authentication yet; U3), so a same-user process that imitates the node
cannot be told apart. See the plan, Decision 3.

## Blocking before any signed or distributed release

1. **A dedicated Node.js for the service with `runAsNode: false`** (review M1). Done in this slice (the
   service runs on the pinned Node staged under `Contents/Resources/service/node`, the fuse is off and pinned
   by a test); keep it: with the fuse on, anything able to exec the app binary runs JavaScript under the app's
   signed identity and can reach Keychain items whose ACL trusts it.
2. **Owner answers to [Q-247 and Q-248](../../docs/plans/OPEN_QUESTIONS.md)** (review M6): Electron's
   dynamically linked LGPL `libffmpeg.dylib` and the bundled Node.js licenses in the app, and the build-time-only
   WTFPL `truncate-utf8-bytes`. ADR-0016 is not amended; **a distributed DMG waits on that answer**.
   Unsigned local builds do not.

## Commands

Run from the repository root; lane ports and data directory as in the [lane rules](../../docs/plans/lanes/README.md).

```bash
npm run build --workspace @guanxi/desktop          # esbuild: dist/main.js (ESM), dist/preload.cjs
npm test --workspace @guanxi/desktop               # pure unit tests, no Electron, any OS
npm run test:electron --workspace @guanxi/desktop  # launches Electron (needs the binary and a window server)
npm run typecheck --workspace @guanxi/desktop
npm start --workspace @guanxi/desktop              # build and run the shell against the checkout's CLI
npm run package:mac --workspace @guanxi/desktop    # unsigned arm64 DMG + zip in packages/desktop/release
```

`npm ci` does not download the Electron binary (npm 11 gates install scripts);
`scripts/ensure-electron.mjs` runs Electron's own installer when the binary is missing, and
`test:electron` calls it. The Electron tests use a private temporary data directory and a free port per
scenario and never touch `~/.guanxi`.

## Packaging, signing, notarization

`electron-builder.config.mjs` builds an **unsigned** DMG by default. Signing and notarization are opt-in
through environment variables and fail loudly without their material; nothing is read from a file in the
repository.

| Variable | Meaning |
| --- | --- |
| `GUANXI_DESKTOP_SIGN=1` | sign with the Developer ID Application certificate (hardened runtime, entitlements in `packaging/`) |
| `CSC_LINK`, `CSC_KEY_PASSWORD` (or `CSC_NAME`) | the certificate (base64 or path) and its password |
| `GUANXI_DESKTOP_APP_ID` | the reverse-DNS bundle id; required for a signed build, cannot change after the first release without losing Keychain and privacy grants |
| `GUANXI_DESKTOP_NOTARIZE=1` | notarize (needs signing) |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key (recommended) |
| or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Apple ID credentials |
| or `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE` | a notarytool keychain profile |

The owner steps are in the [hand-off](../../docs/plans/lanes/U2-macos.handoff.md). The service is staged by
`scripts/stage-service.mjs` (CLI bundle, web UI, production dependencies installed with
`--ignore-scripts`, plus the official Node.js 26.9.0 verified against a SHA-256 pinned in the script) into
`.stage/service`, shipped as `Contents/Resources/service`.
Auto-update is **disabled** (`src/updater.ts`, a stub); its design note is in the plan.

## Layout and platform isolation

```text
src/main.ts            composition root (Electron)
src/windows.ts         window, navigation lock, session policy (Electron)
src/preload.ts         sandboxed preload, bundled as CommonJS
src/security.ts        pure policy and decisions
src/service/           Electron-free: probe, handshake, launcher, locate, stop
src/status-page.ts     failure/progress screens (static HTML, no script)
src/messages.ts        shell strings (en, ru)
src/platform/          PlatformAdapter: darwin.ts, generic.ts (U6 adds linux.ts here)
src/updater.ts         disabled stub
```

Everything under `src/service/`, `security.ts`, `messages.ts` and `status-page.ts` is platform-neutral and
tested without Electron. Per-OS behaviour (dock, menu, last-window policy) lives only in `src/platform/`;
per-OS packaging only in `electron-builder.config.mjs` (`mac`; U6 adds `linux` beside it).

## Dependencies and licenses

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `electron` | 44.9.0 (released 2026-10-17) | MIT; Chromium and its components (incl. LGPL `libffmpeg.dylib`) under `LICENSES.chromium.html`, shipped in the app; pending Q-247 | runtime, devDependency |
| Node.js | 26.9.0 (released 2026-09-16), official tarball, digest pinned | MIT plus bundled components listed in its `LICENSE` | the service's runtime, staged into the app (not an npm dependency); pending Q-247 |
| `electron-builder` | 26.17.0 (2026-09-26) | MIT | packaging, devDependency |
| `@playwright/test` | 1.62.1 (same as `@guanxi/web`) | Apache-2.0 | `_electron` test driver, devDependency |
| `truncate-utf8-bytes` | 1.0.2, transitive of electron-builder | WTFPL, not on ADR-0016's list | build-time only, never shipped; reviewed exception in `scripts/check-licenses.mjs`; pending Q-248 |

No source is copied, but the shipped binaries (Electron, Chromium, Node.js) are listed in `THIRD_PARTY_NOTICES.md`. `@guanxi/contract` is bundled at build
time only for the brand module (`@guanxi/contract/brand`).
