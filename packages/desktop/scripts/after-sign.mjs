// electron-builder afterSign hook (runs before notarization). With signing on, every nested binary of the service
// (the bundled Node.js and the native addons) must carry the app's Team ID and exactly the app's entitlements.
// With signing off nothing is checked; an unsigned local build keeps Node.js's own, more permissive entitlements.
// The first signed build is the first time this runs against real signatures.
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { PRODUCT_ENV_PREFIX } from '@guanxi/contract/brand'
import { verifyNestedSignatures } from './lib/verify-signature.mjs'

const root = resolve(import.meta.dirname, '..')

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const flag = process.env[`${PRODUCT_ENV_PREFIX}_DESKTOP_SIGN`]
  if (flag !== '1' && flag !== 'true') {
    console.log('  • nested signature check skipped: this is an unsigned build')
    return
  }
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const result = await verifyNestedSignatures({
    appPath,
    entitlementsFile: join(root, 'packaging', 'entitlements.mac.plist'),
    // codesign prints its report on stderr and the entitlements plist on stdout: hand back both.
    run: (file, args) => {
      const result = spawnSync(file, args, { encoding: 'utf8' })
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || `exit ${result.status}`).trim())
      return `${result.stdout}\n${result.stderr}`
    },
  })
  console.log(`  • nested signatures verified: ${result.checked} binaries, Team ID ${result.team}`)
}
