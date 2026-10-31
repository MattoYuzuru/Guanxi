import { access, constants, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The staged (or packaged) service directory must be runnable: the CLI bundle, its dependencies and the pinned
 * Node.js, which must report exactly the pinned version. Used before electron-builder runs (`.stage/service`) and
 * again after it has copied the files into the app.
 * @param run (file, args) => stdout string; throws on failure
 */
export async function verifyStagedService(serviceDir, { nodeVersion, run }) {
  const need = async (path, what, mode = constants.R_OK) => {
    try {
      await access(path, mode)
    } catch {
      throw new Error(`The service is not packaged correctly: ${what} is missing or not usable at ${path}`)
    }
  }
  await need(join(serviceDir, 'bin.js'), 'the CLI bundle')
  const modules = join(serviceDir, 'node_modules')
  await need(modules, 'node_modules')
  if ((await readdir(modules)).length === 0 || !(await stat(modules)).isDirectory()) throw new Error(`The service has an empty node_modules at ${modules}`)
  const node = join(serviceDir, 'node', 'bin', 'node')
  await need(node, 'the bundled Node.js', constants.X_OK)
  const reported = String(run(node, ['--version'])).trim()
  if (reported !== `v${nodeVersion}`) throw new Error(`The bundled Node.js reports ${reported}, expected v${nodeVersion}`)
}
