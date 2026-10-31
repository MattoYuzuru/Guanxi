import type { ServicePaths } from './launcher.ts'
import { isProcessAlive, readManifest, removeManifest } from './launcher.ts'
import type { Listener, ProcessInfo } from './owner.ts'
import { matchesManifest } from './owner.ts'
import type { ProbeResult } from './probe.ts'

export type StopResult =
  | { ok: true; pid: number }
  /** No manifest: the running service (if any) was not started by the shell, so the shell does not own it. */
  | { ok: false; reason: 'not_managed' }
  | { ok: false; reason: 'not_running' }
  /** The pid, its command line, its start time or the port's listener could not be tied to the manifest. Nothing was signalled and the manifest is kept. */
  | { ok: false; reason: 'unverified' }
  | { ok: false; reason: 'not_stopped'; pid: number }
  /** The operating system refused the signal (EPERM): the pid is not ours to stop. */
  | { ok: false; reason: 'not_permitted'; pid: number }

export interface StopDeps {
  paths: ServicePaths
  /** Probes the manifest's port. */
  probe(port: number): Promise<ProbeResult>
  /** Listening sockets on the port this user can see; `null` when the lookup failed. */
  listeners(port: number): Promise<Listener[] | null>
  kill(pid: number, signal: NodeJS.Signals): void
  alive(pid: number): boolean
  /** `ps` facts about a pid (command line and start time). */
  processInfo(pid: number): Promise<ProcessInfo>
  sleep(ms: number): Promise<void>
  now(): number
  timeoutMs: number
}

export function defaultAlive(pid: number): boolean {
  return isProcessAlive(pid)
}

/**
 * Explicit user action only (menu "Stop background service"). The shell signals a pid only when ALL of these tie
 * it to the service the manifest describes:
 * - the manifest it wrote names it and it is alive;
 * - its command line carries the manifest's entry and `--port <port>` as whole arguments, and its start time
 *   (when `ps` gives one) is close to the manifest's `startedAt` (a recycled pid runs something else);
 * - the manifest's port answers as Guanxi, and the listener on that port IS the manifest pid.
 * If `ps` or `lsof` fails the answer is `unverified`: nothing is signalled and the manifest stays. A service started
 * by the CLI or by another tool has no manifest and is never touched.
 */
export async function stopService(deps: StopDeps): Promise<StopResult> {
  const manifest = readManifest(deps.paths)
  if (manifest === null) return { ok: false, reason: 'not_managed' }
  if (!deps.alive(manifest.pid)) {
    removeManifest(deps.paths)
    return { ok: false, reason: 'not_running' }
  }
  const verdict = matchesManifest(await deps.processInfo(manifest.pid), manifest)
  if (verdict === 'unknown') return { ok: false, reason: 'unverified' }
  if (verdict === 'mismatch') {
    // The pid now belongs to something else: the manifest is stale. Signal nothing.
    removeManifest(deps.paths)
    return { ok: false, reason: 'not_running' }
  }
  const answering = await deps.probe(manifest.port)
  if (answering.kind !== 'ready' && answering.kind !== 'ui_missing') return { ok: false, reason: 'not_running' }
  const listeners = await deps.listeners(manifest.port)
  if (listeners === null || listeners.length === 0 || listeners.some((listener) => listener.pid !== manifest.pid)) {
    return { ok: false, reason: 'unverified' }
  }
  try {
    deps.kill(manifest.pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      removeManifest(deps.paths)
      return { ok: false, reason: 'not_running' }
    }
    return { ok: false, reason: 'not_permitted', pid: manifest.pid }
  }
  const deadline = deps.now() + deps.timeoutMs
  while (deps.alive(manifest.pid)) {
    if (deps.now() >= deadline) return { ok: false, reason: 'not_stopped', pid: manifest.pid }
    await deps.sleep(100)
  }
  removeManifest(deps.paths)
  return { ok: true, pid: manifest.pid }
}
