// npm 11 gates install scripts, so `electron`'s postinstall (which downloads the binary) does not run
// on `npm ci`. Run Electron's own installer when the binary is absent; it honours the download cache.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const electronDir = dirname(require.resolve('electron/package.json'))

if (!existsSync(resolve(electronDir, 'path.txt'))) {
  const result = spawnSync(process.execPath, [resolve(electronDir, 'install.js')], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('Could not download the Electron binary (network or cache). Electron tests cannot run.')
    process.exit(result.status ?? 1)
  }
}
