import type { ServicePaths } from './launcher.ts'
import { isProcessAlive, readManifest, removeManifest } from './launcher.ts'
import type { ProbeResult } from './probe.ts'

export type StopResult =
  | { ok: true; pid: number }
  /** No manifest: the running service (if any) was not started by the shell, so the shell does not own it. */
  | { ok: false; reason: 'not_managed' }
  | { ok: false; reason: 'not_running' }
  | { ok: false; reason: 'not_stopped'; pid: number }

export interface StopDeps {
  paths: ServicePaths
  /** Probes the manifest's port. */
  probe(port: number): Promise<ProbeResult>
  kill(pid: number, signal: NodeJS.Signals): void
  alive(pid: number): boolean
  sleep(ms: number): Promise<void>
  now(): number
  timeoutMs: number
}

export function defaultAlive(pid: number): boolean {
  return isProcessAlive(pid)
}

/**
 * Explicit user action only (menu "Stop background service"). The shell signals a pid only when the
 * manifest it wrote names it, the pid is alive and the manifest's port still answers as Guanxi, which
 * guards against a recycled pid. A service started by the CLI or by another tool has no manifest and is
 * never touched.
 */
export async function stopService(deps: StopDeps): Promise<StopResult> {
  const manifest = readManifest(deps.paths)
  if (manifest === null) return { ok: false, reason: 'not_managed' }
  const answering = await deps.probe(manifest.port)
  if (!deps.alive(manifest.pid) || answering.kind === 'closed') {
    removeManifest(deps.paths)
    return { ok: false, reason: 'not_running' }
  }
  if (answering.kind !== 'ready' && answering.kind !== 'ui_missing') return { ok: false, reason: 'not_running' }
  deps.kill(manifest.pid, 'SIGTERM')
  const deadline = deps.now() + deps.timeoutMs
  while (deps.alive(manifest.pid)) {
    if (deps.now() >= deadline) return { ok: false, reason: 'not_stopped', pid: manifest.pid }
    await deps.sleep(100)
  }
  removeManifest(deps.paths)
  return { ok: true, pid: manifest.pid }
}
