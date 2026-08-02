import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { WorkspaceStore } from '../src/store/workspaces.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'test',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'test',
  unifiedMemory: true,
  freeDiskBytes: null,
}

function testContext(): AppContext {
  const db = openDb(':memory:')
  const settings = new SettingsStore(db, { ollamaHost: 'http://127.0.0.1:11434' })

  return {
    db,
    threads: new ThreadStore(db),
    workspaces: new WorkspaceStore(db),
    settings,
    calibration: new CalibrationStore(db),
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    hardware: HARDWARE,
    appVersion: 'test',
    activeTurns: new Map(),
    ollama: () => {
      throw new Error('Ollama не должна вызываться в этом тесте')
    },
    models: () => {
      throw new Error('ModelService не должен вызываться в этом тесте')
    },
  }
}

describe('thread routes', () => {
  it('отклоняет неизвестный workspace агентного треда', async () => {
    const context = testContext()
    const app = createApp(context)

    const response = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'agent',
        model: 'qwen',
        workspaceId: 'missing',
      }),
    })

    assert.equal(response.status, 404)
    assert.equal(((await response.json()) as { code: string }).code, 'workspace_not_found')
    context.db.close()
  })

  it('создаёт чат без файлового workspace и читает его обратно', async () => {
    const context = testContext()
    const app = createApp(context)

    const created = await app.request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'chat',
        model: 'qwen',
        workspaceId: 'ignored-for-chat',
      }),
    })

    assert.equal(created.status, 201)
    const thread = (await created.json()) as { id: string; workspaceId: string | null }
    assert.equal(thread.workspaceId, null)

    const loaded = await app.request(`/api/threads/${thread.id}`)
    assert.equal(loaded.status, 200)
    assert.equal(((await loaded.json()) as { thread: { id: string } }).thread.id, thread.id)
    context.db.close()
  })
})
