/**
 * Сборка зависимостей приложения.
 *
 * Один объект, который передаётся роутам. Клиент Ollama пересоздаётся при смене
 * хоста в настройках — адрес не константа, и это важно: именно благодаря этому
 * тот же сервер сможет работать с Ollama на другой машине.
 */
import type { HardwareInfo } from '@alamo/contract'
import { ApprovalGate } from './agent/approvals.ts'
import { PrefillTracker } from './context/usage.ts'
import { probeHardware } from './hardware/probe.ts'
import { createHostTelemetry, type HostTelemetry } from './hardware/telemetry.ts'
import { OllamaClient } from './ollama/client.ts'
import { ModelService } from './models/service.ts'
import { ModelCapabilityOverrideService } from './models/capability-override.ts'
import { JobService } from './jobs/service.ts'
import { ChatJobExecutionOwner } from './jobs/chat-execution.ts'
import { recoverChatJobs } from './jobs/chat-recovery.ts'
import { ResourceGovernor } from './runtime/resource-governor.ts'
import { CompletionProbeService } from './runtime/completion-probe.ts'
import { RuntimeReconciliationService } from './runtime/reconciliation.ts'
import { CalibrationStore } from './store/calibration.ts'
import { ModelCapabilityOverrideStore } from './store/capability-override.ts'
import { CompletionProbeStore } from './store/completion-probe.ts'
import { openDb, type Db } from './store/db.ts'
import { JobStore } from './store/jobs.ts'
import { SettingsStore } from './store/settings.ts'
import { ThreadStore } from './store/threads.ts'
import { WorkspaceStore } from './store/workspaces.ts'

export const DEFAULT_OLLAMA_HOST = process.env['OLLAMA_HOST']
  ? normalizeHost(process.env['OLLAMA_HOST'])
  : 'http://127.0.0.1:11434'

function normalizeHost(host: string): string {
  if (host.startsWith('http://') || host.startsWith('https://')) return host
  return `http://${host}`
}

export interface AppContext {
  db: Db
  jobs: JobStore
  jobService: JobService
  chatExecution: ChatJobExecutionOwner
  threads: ThreadStore
  workspaces: WorkspaceStore
  settings: SettingsStore
  calibration: CalibrationStore
  completionProbe: CompletionProbeService
  /** Owner of explicit positive user capability assertions; it runs no model work. */
  capabilityOverrides: ModelCapabilityOverrideService
  approvals: ApprovalGate
  tracker: PrefillTracker
  hardware: HardwareInfo
  /** One infrastructure boundary for sampled host facts; it has no admission side effects. */
  hostTelemetry: HostTelemetry
  appVersion: string
  /**
   * Compatibility mirror for active Chat controllers. ChatJobExecutionOwner
   * owns lifecycle/Stop; process-local admission belongs to `governor`.
   */
  activeTurns: Map<string, AbortController>
  /** Canonical process-local admission/lease owner for local model-affecting entry points. */
  governor: ResourceGovernor
  /** One sampled `/api/ps` + Governor reconciliation boundary for public queries. */
  runtime: RuntimeReconciliationService
  ollama(): OllamaClient
  models(): ModelService
}

export interface CreateContextOptions {
  dbPath: string
  appVersion: string
}

export async function createAppContext(options: CreateContextOptions): Promise<AppContext> {
  const db = openDb(options.dbPath)
  try {
    const hardware = await probeHardware()
    const hostTelemetry = createHostTelemetry(hardware)

    const settings = new SettingsStore(db, { ollamaHost: DEFAULT_OLLAMA_HOST })
    const calibration = new CalibrationStore(db)
    const completionProbeStore = new CompletionProbeStore(db)
    const capabilityOverrideStore = new ModelCapabilityOverrideStore(db)

    let client: OllamaClient | null = null
    let modelService: ModelService | null = null

    const ollama = (): OllamaClient => {
      const host = normalizeHost(settings.get().ollamaHost)
      if (!client || client.host !== host.replace(/\/+$/, '')) {
        client = new OllamaClient({ host })
        modelService = null
      }
      return client
    }

    const models = (): ModelService => {
      const current = ollama()
      if (!modelService) {
        modelService = new ModelService(
          current,
          calibration,
          hardware,
          undefined,
          undefined,
          capabilityOverrideStore,
        )
      }
      return modelService
    }

    const jobs = new JobStore(db)

    const activeTurns = new Map<string, AbortController>()
    const governor = new ResourceGovernor()
    const runtime = new RuntimeReconciliationService({ governor, hostTelemetry, models })
    const jobService = new JobService(jobs)
    const base = {
      db,
      jobs,
      jobService,
      threads: new ThreadStore(db),
      workspaces: new WorkspaceStore(db),
      settings,
      calibration,
      approvals: new ApprovalGate(),
      tracker: new PrefillTracker(),
      hardware,
      hostTelemetry,
      appVersion: options.appVersion,
      activeTurns,
      governor,
      runtime,
      ollama,
      models,
    }
    const context = {
      ...base,
      completionProbe: new CompletionProbeService({
        governor,
        models,
        ollama,
        store: completionProbeStore,
      }),
      capabilityOverrides: new ModelCapabilityOverrideService({
        models,
        store: capabilityOverrideStore,
      }),
      chatExecution: new ChatJobExecutionOwner(base),
    }
    await recoverChatJobs(context)
    return context
  } catch (error) {
    db.close()
    throw error
  }
}
