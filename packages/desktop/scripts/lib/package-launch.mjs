/** Chromium-only test isolation; never added to the installed app's normal startup. */
export function packageLaunchArguments(userDataDir, debugPort) {
  return [
    `--user-data-dir=${userDataDir}`,
    // Match Playwright's Electron launcher. A fresh HOME/profile must not reach the owner's
    // macOS Keychain while Chromium initializes cookie encryption (Electron PR #53790).
    '--use-mock-keychain',
    '--password-store=basic',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${debugPort}`,
  ]
}
