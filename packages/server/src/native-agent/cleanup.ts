import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

export const CLEANUP_TIMEOUT_MS = 5000
export const STOP_GRACE_MS = 1000
const exec = promisify(execFile)
/** An unreachable runtime is never evidence that a namespace has stopped. */
export async function removeContainer(docker: string, endpoint: string, name: string, timeoutMs = CLEANUP_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const run = (args: string[]) => exec(docker, ['--host', endpoint, ...args], { timeout: Math.max(1, Math.min(1000, deadline - Date.now())), killSignal: 'SIGKILL', maxBuffer: 256 * 1024 })
  do {
    try { await run(['rm', '--force', name]) } catch { /* Also inspect after an ambiguous removal response. */ }
    if (Date.now() >= deadline) break
    try { if (!(await run(['ps', '-aq', '--filter', `name=^/${name}$`])).stdout.trim()) return } catch { /* fail closed */ }
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
  } while (Date.now() < deadline)
  throw new Error('cleanup_unconfirmed')
}
/** Persistent quarantine survives session settlement, plugin reload and node restart. */
export function assertRootsClean(dataDir: string, roots: string[]): void {
  if (!roots.length) return
  const directory = join(dataDir, 'native-cleanup')
  let entries: string[]
  try { entries = readdirSync(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('cleanup_unconfirmed')
  }
  for (const entry of entries) {
    try {
      const record: unknown = JSON.parse(readFileSync(join(directory, entry), 'utf8'))
      if (!Array.isArray(record) || !record.every(root => typeof root === 'string')) throw new Error('invalid_quarantine')
      if (roots.some(root => record.some(held => root === held || root.startsWith(held + sep) || held.startsWith(root + sep)))) throw new Error('cleanup_unconfirmed')
    } catch { throw new Error('cleanup_unconfirmed') }
  }
}
