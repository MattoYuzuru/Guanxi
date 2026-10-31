// electron-builder configuration for the macOS shell (U2). Read docs/plans/lanes/U2-macos.plan.md,
// Decision 6, and the "Owner steps" in docs/plans/lanes/U2-macos.handoff.md.
//
// Nothing here holds a credential. Signing and notarization are opt-in through environment variables and
// fail loudly when asked for without the material they need; a plain `npm run package:mac` produces an
// UNSIGNED local DMG. Linux (U6) adds its section next to `mac`; Windows is not built (D-221).
import { PRODUCT_FILE_PREFIX, PRODUCT_NAME } from '@guanxi/contract/brand'

/** A reverse-DNS bundle id the owner has not chosen yet. A signed build refuses it (see below). */
export const PLACEHOLDER_APP_ID = 'invalid.placeholder.guanxi.desktop'

const truthy = (value) => value === '1' || value === 'true'
const present = (value) => typeof value === 'string' && value.length > 0

/** The credential variable sets electron-builder accepts for notarization (see app-builder-lib macOptions). */
export function notarizationCredentials(env) {
  if (present(env.APPLE_API_KEY) && present(env.APPLE_API_KEY_ID) && present(env.APPLE_API_ISSUER)) return 'api-key'
  if (present(env.APPLE_ID) && present(env.APPLE_APP_SPECIFIC_PASSWORD) && present(env.APPLE_TEAM_ID)) return 'apple-id'
  if (present(env.APPLE_KEYCHAIN) && present(env.APPLE_KEYCHAIN_PROFILE)) return 'keychain-profile'
  return null
}

export function createConfig(env = process.env) {
  const sign = truthy(env.GUANXI_DESKTOP_SIGN)
  const notarize = truthy(env.GUANXI_DESKTOP_NOTARIZE)
  const appId = present(env.GUANXI_DESKTOP_APP_ID) ? env.GUANXI_DESKTOP_APP_ID : PLACEHOLDER_APP_ID

  if (notarize && !sign) throw new Error('GUANXI_DESKTOP_NOTARIZE=1 needs GUANXI_DESKTOP_SIGN=1: only a signed build can be notarized')
  if (sign) {
    if (!present(env.CSC_LINK) && !present(env.CSC_NAME)) {
      throw new Error('GUANXI_DESKTOP_SIGN=1 needs a Developer ID Application certificate: set CSC_LINK (+ CSC_KEY_PASSWORD) or CSC_NAME')
    }
    if (appId === PLACEHOLDER_APP_ID) {
      throw new Error('A signed build needs the real bundle id: set GUANXI_DESKTOP_APP_ID (it cannot change after the first release without losing Keychain and privacy grants)')
    }
  }
  if (notarize && notarizationCredentials(env) === null) {
    throw new Error('GUANXI_DESKTOP_NOTARIZE=1 needs APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or APPLE_KEYCHAIN + APPLE_KEYCHAIN_PROFILE')
  }

  return {
    appId,
    productName: PRODUCT_NAME,
    artifactName: `${PRODUCT_FILE_PREFIX}-desktop-\${version}-\${arch}.\${ext}`,
    directories: { output: 'release', buildResources: 'packaging' },
    // The renderer is the node's own web UI; the app carries only the shell bundle. @guanxi/contract is
    // bundled by esbuild (devDependency), so no node_modules ship in the asar.
    files: ['dist/**/*', '!dist/**/*.map', 'package.json'],
    asar: true,
    // The service (CLI bundle + web UI + production node_modules) is staged by scripts/stage-service.mjs.
    // electron-builder never copies the ROOT node_modules of a file set, so the set is rooted one level up
    // (`.stage`) and the node_modules of the service are a sub-directory of it.
    extraResources: [{ from: '.stage', to: '.', filter: ['service/**/*'] }],
    npmRebuild: false,
    // Auto-update is a design note in this slice (src/updater.ts): no publish target, no update feed.
    publish: null,
    // RunAsNode stays on: the service runs under the app binary (Decision 2). Everything else is closed.
    electronFuses: {
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      // Flipping fuses invalidates Electron's ad-hoc signature, and arm64 macOS kills a binary with a broken
      // one. An unsigned local build re-signs ad hoc; a Developer ID build is signed after the flip anyway.
      resetAdHocDarwinSignature: !sign,
    },
    mac: {
      category: 'public.app-category.developer-tools',
      target: [
        { target: 'dmg', arch: ['arm64'] },
        { target: 'zip', arch: ['arm64'] },
      ],
      minimumSystemVersion: '13.0',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'packaging/entitlements.mac.plist',
      entitlementsInherit: 'packaging/entitlements.mac.plist',
      // `null` stops electron-builder from picking up whatever certificate happens to be in the keychain.
      ...(sign ? {} : { identity: null }),
      notarize,
    },
    dmg: { sign: false },
  }
}

// A function, so a bad signing setup fails when the packager asks for the configuration, not on import.
export default () => createConfig(process.env)
