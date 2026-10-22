import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'

export function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolvePromise()
        if (Date.now() >= deadline) return reject(new Error('fixture timeout'))
        setTimeout(tick, 20)
      } catch (error) { reject(error) }
    }
    tick()
  })
}
export function alive(pid: number | null): boolean {
  if (!pid || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
export async function waitGone(pid: number): Promise<void> {
  await waitFor(() => !alive(pid), 5_000)
}
export async function groupedHolder(t: TestContext, root: string, suffix = '') {
  const groupFile = join(root, `group${suffix}.json`)
  const holderScript = `const {spawn}=require('node:child_process');` +
    `const fs=require('node:fs');` +
    `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
    `fs.writeFileSync(process.argv[1],JSON.stringify({client:child.pid}));` +
    `setInterval(()=>{},1000)`
  const supervisor = spawn(process.execPath, ['-e', holderScript, groupFile], { detached: true, stdio: 'ignore' })
  let clientPid: number | undefined
  let cleaned = false
  const cleanupGroup = async () => {
    if (cleaned) return
    cleaned = true
    if (supervisor.pid) {
      try { process.kill(-supervisor.pid, 'SIGKILL') } catch { /* already gone */ }
      try { process.kill(supervisor.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    if (clientPid) { try { process.kill(clientPid, 'SIGKILL') } catch { /* already gone */ } }
    if (supervisor.pid) await waitGone(supervisor.pid).catch(() => undefined)
    if (clientPid) await waitGone(clientPid).catch(() => undefined)
  }
  // Register ownership before setup/record validation can throw.
  t.after(cleanupGroup)
  await waitFor(() => typeof supervisor.pid === 'number' && existsSync(groupFile))
  clientPid = JSON.parse(readFileSync(groupFile, 'utf8')).client as number
  return { supervisor, clientPid, cleanup: cleanupGroup }
}
