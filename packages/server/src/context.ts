/**
 * Сборка зависимостей приложения.
 *
 * Один объект, который передаётся роутам. Клиент Ollama пересоздаётся при смене
 * хоста в настройках — адрес не константа, и это важно: именно благодаря этому
 * тот же сервер сможет работать с Ollama на другой машине.
 */
import type { HardwareInfo } from '@alamo/contract'
import { dirname, join } from 'node:path'
import { ApprovalGate } from './agent/approvals.ts'
import { PrefillTracker } from './context/usage.ts'
import { probeHardware } from './hardware/probe.ts'
import { createHostTelemetry, type HostTelemetry } from './hardware/telemetry.ts'
import {
  FeatureFlagRegistry,
  type FeatureFlagEnvironment,
} from './config/feature-flags.ts'
import { OllamaClient } from './ollama/client.ts'
import { ModelService } from './models/service.ts'
import { ModelCapabilityOverrideService } from './models/capability-override.ts'
import { ProjectService } from './projects/service.ts'
import { ChatRetentionService } from './retention/service.ts'
import { HuggingFaceTransport } from './models/hugging-face-transport.ts'
import { HuggingFaceDownloadService } from './models/hugging-face-download.ts'
import { HuggingFaceImportService } from './models/hugging-face-import.ts'
import { JobService } from './jobs/service.ts'
import { ChatJobExecutionOwner } from './jobs/chat-execution.ts'
import { recoverChatJobs } from './jobs/chat-recovery.ts'
import { ResourceGovernor } from './runtime/resource-governor.ts'
import { CompletionProbeService } from './runtime/completion-probe.ts'
import { RuntimeReconciliationService } from './runtime/reconciliation.ts'
import { EstimatedParallelAdmissionService } from './runtime/estimated-parallel-admission.ts'
import { CalibrationStore } from './store/calibration.ts'
import { ModelCapabilityOverrideStore } from './store/capability-override.ts'
import { CompletionProbeStore } from './store/completion-probe.ts'
import { openDb, type Db } from './store/db.ts'
import { JobStore } from './store/jobs.ts'
import { ProjectStore } from './store/projects.ts'
import { SettingsStore } from './store/settings.ts'
import { ThreadStore } from './store/threads.ts'
import { ChatRetentionStore } from './store/chat-retention.ts'
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
  retention: ChatRetentionService
  workspaces: WorkspaceStore
  projects: ProjectService
  settings: SettingsStore
  /** Immutable server-owned effective policy sampled once during process startup. */
  featureFlags: FeatureFlagRegistry
  calibration: CalibrationStore
  completionProbe: CompletionProbeService
  /** Owner of explicit positive user capability assertions; it runs no model work. */
  capabilityOverrides: ModelCapabilityOverrideService
  /**
   * The only outbound Hugging Face boundary. Read-only discovery: it never touches
   * Ollama, the Governor, the catalog or any Job, and it holds no credentials.
   */
  huggingFace: HuggingFaceTransport
  /** Connection-owned P2-L writer into a server-managed staging boundary. */
  huggingFaceDownloads: HuggingFaceDownloadService
  /** Connection-owned P2-M staging → Ollama create/reconcile/probe owner. */
  huggingFaceImports: HuggingFaceImportService
  approvals: ApprovalGate
  tracker: PrefillTracker
  hardware: HardwareInfo
  /** Timestamp of the startup probe that produced the static compatibility profile. */
  hardwareObservedAt: string
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
  /** Flag-gated read-only estimate for one explicit active + queued pair. */
  estimatedParallelAdmission: EstimatedParallelAdmissionService
  ollama(): OllamaClient
  models(): ModelService
}

export interface CreateContextOptions {
  dbPath: string
  appVersion: string
  featureFlagEnvironment?: FeatureFlagEnvironment
}

export async function createAppContext(options: CreateContextOptions): Promise<AppContext> {
  const db = openDb(options.dbPath)
  try {
    const hardware = await probeHardware()
    const hardwareObservedAt = new Date().toISOString()
    const hostTelemetry = createHostTelemetry(hardware)

    const settings = new SettingsStore(db, { ollamaHost: DEFAULT_OLLAMA_HOST })
    const featureFlags = new FeatureFlagRegistry({
      environment: options.featureFlagEnvironment ?? {
        state: 'available',
        values: process.env,
      },
    })
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
    const threads = new ThreadStore(db)
    const projects = new ProjectService(new ProjectStore(db))
    projects.reconcileLegacyWorkspaces()

    const activeTurns = new Map<string, AbortController>()
    const governor = new ResourceGovernor()
    const runtime = new RuntimeReconciliationService({ governor, hostTelemetry, models })
    const estimatedParallelAdmission = new EstimatedParallelAdmissionService({
      featureFlags,
      runtime,
      calibration,
      ollama,
      hardware,
    })
    const jobService = new JobService(jobs)
    const base = {
      db,
      jobs,
      jobService,
      threads,
      retention: new ChatRetentionService(new ChatRetentionStore(db)),
      workspaces: new WorkspaceStore(db),
      projects,
      settings,
      featureFlags,
      calibration,
      approvals: new ApprovalGate(),
      tracker: new PrefillTracker(),
      hardware,
      hardwareObservedAt,
      hostTelemetry,
      appVersion: options.appVersion,
      activeTurns,
      governor,
      runtime,
      estimatedParallelAdmission,
      ollama,
      models,
    }
    const completionProbe = new CompletionProbeService({
        governor,
        models,
        ollama,
        store: completionProbeStore,
      })
    const huggingFaceDownloads = new HuggingFaceDownloadService({
      rootDir: join(dirname(options.dbPath), 'staging', 'hugging-face'),
    })
    const context = {
      ...base,
      completionProbe,
      capabilityOverrides: new ModelCapabilityOverrideService({
        models,
        store: capabilityOverrideStore,
      }),
      huggingFace: new HuggingFaceTransport(),
      huggingFaceDownloads,
      huggingFaceImports: new HuggingFaceImportService({
        downloads: huggingFaceDownloads,
        ollama,
        completionProbe,
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
