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
import { OllamaClient } from './ollama/client.ts'
import { ModelService } from './models/service.ts'
import { CalibrationStore } from './store/calibration.ts'
import { openDb, type Db } from './store/db.ts'
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
  threads: ThreadStore
  workspaces: WorkspaceStore
  settings: SettingsStore
  calibration: CalibrationStore
  approvals: ApprovalGate
  tracker: PrefillTracker
  hardware: HardwareInfo
  appVersion: string
  /** Идущие прямо сейчас ходы — по ним работает кнопка «Стоп». */
  activeTurns: Map<string, AbortController>
  ollama(): OllamaClient
  models(): ModelService
}

export interface CreateContextOptions {
  dbPath: string
  appVersion: string
}

export async function createAppContext(options: CreateContextOptions): Promise<AppContext> {
  const db = openDb(options.dbPath)
  const hardware = await probeHardware()

  const settings = new SettingsStore(db, { ollamaHost: DEFAULT_OLLAMA_HOST })
  const calibration = new CalibrationStore(db)

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
    if (!modelService) modelService = new ModelService(current, calibration, hardware)
    return modelService
  }

  return {
    db,
    threads: new ThreadStore(db),
    workspaces: new WorkspaceStore(db),
    settings,
    calibration,
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    hardware,
    appVersion: options.appVersion,
    activeTurns: new Map(),
    ollama,
    models,
  }
}
