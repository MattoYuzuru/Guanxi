import type { DesktopConfig } from '../config.ts'
import type { ExitInfo, SpawnedService } from './launcher.ts'
import type { ServiceCommand } from './locate.ts'
import { ServiceMissingError } from './locate.ts'
import type { ProbeResult } from './probe.ts'

/** Every way the handshake can fail; each has a screen (messages.ts) and a test. */
export type HandshakeFailure =
  /** The service entry or its runtime is not there (damaged install) or cannot be executed. */
  | { code: 'service_missing'; entry: string; detail?: string }
  /** Something else answers on the port. The shell never kills or reuses it. */
  | { code: 'port_busy'; port: number }
  /** Nothing became healthy before the deadline (or the port accepts but never answers). */
  | { code: 'health_timeout'; port: number; timeoutMs: number; startedByShell: boolean }
  /** The service process we started ended before it became healthy. */
  | { code: 'service_exited'; exitCode: number | null; signal: string | null; logPath: string }
  /** The node answers but has no UI to show. */
  | { code: 'ui_missing'; port: number }

export type HandshakeResult =
  | { ok: true; origin: string; attached: boolean; version: string; pid: number | null }
  | ({ ok: false } & HandshakeFailure)

export interface HandshakeDeps {
  config: DesktopConfig
  logPath: string
  probe(): Promise<ProbeResult>
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

/** Find a running service, or start one, and wait until the UI can be loaded. */
export async function ensureService(deps: HandshakeDeps): Promise<HandshakeResult> {
  const { config } = deps
  deps.onPhase?.('checking')

  const first = await deps.probe()
  if (first.kind === 'ready') return { ok: true, origin: config.origin, attached: true, version: first.version, pid: null }
  if (first.kind === 'ui_missing') return failed({ code: 'ui_missing', port: config.port })
  if (first.kind === 'foreign') return failed({ code: 'port_busy', port: config.port })
  if (first.kind === 'hung') {
    // The port is taken by a listener that does not answer in time. Do not start a second process beside it
    // and never kill it: report a timeout the user can read.
    return failed({ code: 'health_timeout', port: config.port, timeoutMs: config.probeTimeoutMs, startedByShell: false })
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

  deps.onPhase?.('waiting')
  const deadline = deps.now() + config.healthTimeoutMs
  for (;;) {
    const result = await deps.probe()
    if (result.kind === 'ready') {
      return { ok: true, origin: config.origin, attached: false, version: result.version, pid: child.pid }
    }
    if (result.kind === 'ui_missing') return failed({ code: 'ui_missing', port: config.port })
    if (result.kind === 'foreign') {
      // Lost a race for the port to a non-Guanxi listener; our child cannot have bound it.
      child.kill()
      return failed({ code: 'port_busy', port: config.port })
    }
    const ended = state.exit
    if (ended !== null) {
      // A concurrent starter may have won: the CLI exits cleanly when Guanxi already answers.
      const last = await deps.probe()
      if (last.kind === 'ready') return { ok: true, origin: config.origin, attached: true, version: last.version, pid: null }
      return failed({ code: 'service_exited', exitCode: ended.code, signal: ended.signal, logPath: deps.logPath })
    }
    if (deps.now() >= deadline) {
      // A child that never became healthy serves nobody: remove only what this handshake started.
      child.kill()
      return failed({ code: 'health_timeout', port: config.port, timeoutMs: config.healthTimeoutMs, startedByShell: true })
    }
    await deps.sleep(config.pollIntervalMs)
  }
}
