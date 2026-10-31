// electron-builder afterPack hook: the service must have arrived in the app intact and runnable.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { NODE_VERSION } from './lib/node-runtime.mjs'
import { verifyStagedService } from './lib/verify-stage.mjs'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  await verifyStagedService(join(app, 'Contents', 'Resources', 'service'), {
    nodeVersion: NODE_VERSION,
    run: (file, args) => execFileSync(file, args, { encoding: 'utf8' }),
  })
}
