import type { DesktopConfig } from '../config.ts'
import type { ExitInfo, SpawnedService } from './launcher.ts'
import type { ServiceCommand } from './locate.ts'
import { ServiceMissingError } from './locate.ts'
import type { Listener, OwnerVerdict } from './owner.ts'
import { judgeOwner } from './owner.ts'
import type { ProbeResult } from './probe.ts'

/** Every way the handshake can fail; each has a screen (messages.ts) and a test. */
export type HandshakeFailure =
  /** The service entry or its runtime is not there (damaged install) or cannot be executed. */
  | { code: 'service_missing'; entry: string; detail?: string }
  /** Something else answers on the port, or not the process we expect. The shell never kills or reuses it. */
  | { code: 'port_busy'; port: number }
  /** Another user's process holds the port. */
  | { code: 'port_owned_by_other_user'; port: number }
  /** Ownership of the port could not be confirmed. */
  | { code: 'port_unverified'; port: number }
  /**
   * Nothing became healthy before the deadline (or the port accepts but never answers). `stopped` is false
   * only when the shell started the process and could not confirm that it is gone (`pid` names it).
   */
  | { code: 'health_timeout'; port: number; timeoutMs: number; startedByShell: boolean; stopped: boolean; pid?: number }
  /** The service process we started ended before it became healthy. */
  | { code: 'service_exited'; exitCode: number | null; signal: string | null; logPath: string }
  /** The node answers but has no UI to show. */
  | { code: 'ui_missing'; port: number }

export type HandshakeResult =
  | { ok: true; origin: string; attached: boolean; version: string; pid: number | null }
  | ({ ok: false } & HandshakeFailure)

export interface OwnerDeps {
  /** Listening sockets on the service port visible to this user; `null` when the lookup failed. */
  listeners(): Promise<Listener[] | null>
  /** This user's uid; `null` where the platform has none (no uid check then). */
  selfUid: number | null
}

export interface HandshakeDeps extends OwnerDeps {
  config: DesktopConfig
  logPath: string
  probe(): Promise<ProbeResult>
  /** Pid of the service the shell started earlier on this port while it is still that service; stale manifests are removed. */
  expectedPid(): Promise<number | null>
  /** Removes the manifest: called whenever a process this handshake started is not (or no longer) the service. */
  forgetManifest(): void
  /** Throws ServiceMissingError when the entry does not exist. */
  locate(): ServiceCommand
  /** Starts the detached service; rejects with SpawnFailedError when it cannot start. */
  spawn(command: ServiceCommand): Promise<SpawnedService>
  /** Called once with the pid of a service this handshake started. */
  onStarted?(pid: number, command: ServiceCommand): void
  /** Progress for the "starting" screen. */
  onPhase?(phase: 'checking' | 'starting' | 'waiting'): void
  sleep(ms: number): Promise<void>
  now(): number
}

function failed(failure: HandshakeFailure): HandshakeResult {
  return { ok: false, ...failure }
}

/** The owner check, before any attach: a Guanxi-shaped answer from the wrong owner is a failure screen. */
export async function verifyOwner(deps: OwnerDeps, expectedPid: number | null): Promise<OwnerVerdict> {
  return judgeOwner(await deps.listeners(), deps.selfUid, expectedPid)
}

/** Find a running service, or start one, and wait until the UI can be loaded. */
export async function ensureService(deps: HandshakeDeps): Promise<HandshakeResult> {
  const { config } = deps
  deps.onPhase?.('checking')

  const expected = await deps.expectedPid()
  const first = await deps.probe()
  if (first.kind === 'ready') {
    const verdict = await verifyOwner(deps, expected)
    if (!verdict.ok) return failed({ code: verdict.code, port: config.port })
    return { ok: true, origin: config.origin, attached: true, version: first.version, pid: expected }
  }
  if (first.kind === 'ui_missing') return failed({ code: 'ui_missing', port: config.port })
  if (first.kind === 'foreign') return failed({ code: 'port_busy', port: config.port })
  if (first.kind === 'hung') {
    // The port is taken by a listener that does not answer in time. Do not start a second process beside it
    // and never kill it: report a timeout the user can read.
    return failed({ code: 'health_timeout', port: config.port, timeoutMs: config.probeTimeoutMs, startedByShell: false, stopped: true })
  }

  // Port closed: start the service.
  let command: ServiceCommand
  try {
    command = deps.locate()
  } catch (error) {
    if (error instanceof ServiceMissingError) return failed({ code: 'service_missing', entry: error.entry })
    throw error
  }
  deps.onPhase?.('starting')
  let child: SpawnedService
  try {
    child = await deps.spawn(command)
  } catch (error) {
    return failed({ code: 'service_missing', entry: command.entry, detail: (error as Error).message })
  }
  deps.onStarted?.(child.pid, command)

  const state: { exit: ExitInfo | null } = { exit: null }
  void child.exited.then((info) => {
    state.exit = info
  })
  /** The process we started is not the service (or never will be): drop our claim on it. */
  const abandon = async (failure: HandshakeFailure): Promise<HandshakeResult> => {
    deps.forgetManifest()
    return failed(failure)
  }

  deps.onPhase?.('waiting')
  const deadline = deps.now() + config.healthTimeoutMs
  for (;;) {
    const result = await deps.probe()
    if (result.kind === 'ready') {
      // Something answers as Guanxi: it must be the process we just started, owned by this user.
      const verdict = await verifyOwner(deps, child.pid)
      if (verdict.ok) return { ok: true, origin: config.origin, attached: false, version: result.version, pid: child.pid }
      await child.terminate()
      return abandon({ code: verdict.code, port: config.port })
    }
    if (result.kind === 'ui_missing') return failed({ code: 'ui_missing', port: config.port })
    if (result.kind === 'foreign') {
      // Lost a race for the port to a non-Guanxi listener; our child cannot have bound it.
      await child.terminate()
      return abandon({ code: 'port_busy', port: config.port })
    }
    const ended = state.exit
    if (ended !== null) {
      // A concurrent starter may have won: the CLI exits cleanly when Guanxi already answers. That service is
      // not ours, so the manifest must not point at our dead child.
      const last = await deps.probe()
      deps.forgetManifest()
      if (last.kind === 'ready') {
        const verdict = await verifyOwner(deps, null)
        if (!verdict.ok) return failed({ code: verdict.code, port: config.port })
        return { ok: true, origin: config.origin, attached: true, version: last.version, pid: null }
      }
      return failed({ code: 'service_exited', exitCode: ended.code, signal: ended.signal, logPath: deps.logPath })
    }
    if (deps.now() >= deadline) {
      // A child that never became healthy serves nobody: remove only what this handshake started, and say so
      // only if it is really gone.
      const stopped = await child.terminate()
      if (stopped) deps.forgetManifest()
      return failed({
        code: 'health_timeout', port: config.port, timeoutMs: config.healthTimeoutMs, startedByShell: true, stopped,
        ...(stopped ? {} : { pid: child.pid }),
      })
    }
    await deps.sleep(config.pollIntervalMs)
  }
}
