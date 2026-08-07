import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { ApprovalGate } from '../src/agent/approvals.ts'
import { createApp } from '../src/app.ts'
import type { AppContext } from '../src/context.ts'
import { PrefillTracker } from '../src/context/usage.ts'
import { UnsupportedHostTelemetry } from '../src/hardware/telemetry.ts'
import { JobService } from '../src/jobs/service.ts'
import { ChatJobExecutionOwner } from '../src/jobs/chat-execution.ts'
import { ModelService } from '../src/models/service.ts'
import { OllamaClient } from '../src/ollama/client.ts'
import { ResourceGovernor } from '../src/runtime/resource-governor.ts'
import { RuntimeReconciliationService } from '../src/runtime/reconciliation.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'
import { JobStore } from '../src/store/jobs.ts'
import { SettingsStore } from '../src/store/settings.ts'
import { ThreadStore } from '../src/store/threads.ts'
import { WorkspaceStore } from '../src/store/workspaces.ts'

const HARDWARE: HardwareInfo = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'fixture',
  cpuCores: 8,
  totalMemoryBytes: 16_000_000_000,
  usableMemoryBytes: 12_000_000_000,
  accelerator: 'metal',
  acceleratorName: 'fixture',
  unifiedMemory: true,
  freeDiskBytes: null,
}

function testContext(client: OllamaClient): AppContext {
  const db = openDb(':memory:')
  const settings = new SettingsStore(db, { ollamaHost: client.host })
  const calibration = new CalibrationStore(db)
  const models = new ModelService(client, calibration, HARDWARE)
  const jobs = new JobStore(db)

  const base = {
    db,
    jobs,
    jobService: new JobService(jobs),
    threads: new ThreadStore(db),
    workspaces: new WorkspaceStore(db),
    settings,
    calibration,
    approvals: new ApprovalGate(),
    tracker: new PrefillTracker(),
    hardware: HARDWARE,
    hostTelemetry: new UnsupportedHostTelemetry(HARDWARE),
    appVersion: 'runtime-fixture',
    activeTurns: new Map(),
    governor: new ResourceGovernor(),
    ollama: () => client,
    models: () => models,
  }
  const runtimeBase = {
    ...base,
    runtime: new RuntimeReconciliationService({
      governor: base.governor,
      hostTelemetry: base.hostTelemetry,
      models: base.models,
    }),
  }
  return {
    ...runtimeBase,
    completionProbe: { execute: async () => { throw new Error('not invoked') } } as never,
    capabilityOverrides: {
      apply: async () => { throw new Error('not invoked') },
      clear: async () => { throw new Error('not invoked') },
    } as never,
    chatExecution: new ChatJobExecutionOwner(runtimeBase),
  }
}

function clientWith(fetchImpl: typeof fetch): OllamaClient {
  return new OllamaClient({
    host: 'http://fixture.invalid',
    connectTimeoutMs: 15,
    loadTimeoutMs: 15,
    streamIdleTimeoutMs: 15,
    fetch: fetchImpl,
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function pendingUntilAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new DOMException('Aborted', 'AbortError')),
      { once: true },
    )
  })
}

describe('runtime health routes', () => {
  it('keeps application health reachable while Ollama is unavailable', async () => {
    const context = testContext(
      clientWith(async () => {
        throw new TypeError('fixture unavailable')
      }),
    )
    try {
      const response = await createApp(context, {
        ollamaStatus: {
          binaryInstalled: async () => false,
          now: () => new Date('2026-08-02T12:00:00.000Z'),
        },
      }).request('/api/health')
      const body = (await response.json()) as {
        ok: boolean
        application: { state: string; source: string; observedAt: string }
        ollama: {
          state: string
          source: string
          observedAt: string
          installSource: string
        }
        network: { ollamaComReachable: boolean | null; status: string }
      }

      assert.equal(response.status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.application.state, 'reachable')
      assert.equal(body.application.source, 'application_http')
      assert.equal(body.ollama.state, 'unavailable')
      assert.equal(body.ollama.source, 'ollama_api_version')
      assert.equal(body.ollama.installSource, 'local_binary_path')
      assert.equal(body.ollama.observedAt, '2026-08-02T12:00:00.000Z')
      assert.equal(body.network.ollamaComReachable, null)
      assert.equal(body.network.status, 'unknown')
    } finally {
      context.db.close()
    }
  })

  it('distinguishes malformed and slow Ollama health responses', async () => {
    const cases = [
      {
        name: 'malformed',
        client: clientWith(async () => json({ unexpected: true })),
        expected: 'incompatible',
      },
      {
        name: 'slow',
        client: clientWith((_input, init) => pendingUntilAbort(init?.signal)),
        expected: 'unavailable',
      },
    ]

    for (const fixture of cases) {
      const context = testContext(fixture.client)
      try {
        const response = await createApp(context, {
          ollamaStatus: { binaryInstalled: async () => true },
        }).request('/api/health')
        const body = (await response.json()) as { ollama: { state: string } }
        assert.equal(body.ollama.state, fixture.expected, fixture.name)
      } finally {
        context.db.close()
      }
    }
  })
})

describe('/api/models/running', () => {
  it('keeps installed /api/tags rows distinct when the /api/ps sample fails', async () => {
    const client = clientWith(async (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/tags') {
        return json({
          models: [
            {
              name: 'installed:latest',
              model: 'installed:latest',
              modified_at: '2026-08-02T12:00:00.000Z',
              size: 1_000,
              digest: 'sha256:installed',
              details: {
                family: 'fixture',
                parameter_size: '1B',
                quantization_level: 'Q4',
                context_length: 8_192,
              },
              capabilities: ['completion'],
            },
          ],
        })
      }
      if (path === '/api/show') return json({ model_info: {} })
      throw new TypeError('ps unavailable')
    })
    const context = testContext(client)
    try {
      const app = createApp(context)
      const installedResponse = await app.request('/api/models')
      const installed = (await installedResponse.json()) as {
        models: Array<{ name: string }>
      }
      const runningResponse = await app.request('/api/models/running')

      assert.equal(installedResponse.status, 200)
      assert.deepEqual(installed.models.map((model) => model.name), ['installed:latest'])
      assert.equal(runningResponse.status, 503)
    } finally {
      context.db.close()
    }
  })

  it('projects empty and non-empty /api/ps samples with observation time', async () => {
    const fixtures = [
      { models: [], expectedCount: 0 },
      {
        models: [
          {
            name: 'fixture:latest',
            model: 'fixture:latest',
            size: 1_000,
            digest: 'sha256:fixture',
            details: { family: 'fixture' },
            size_vram: 750,
            context_length: 8_192,
            expires_at: '2026-08-02T12:10:00.000Z',
          },
        ],
        expectedCount: 1,
      },
    ]

    for (const fixture of fixtures) {
      const context = testContext(clientWith(async () => json({ models: fixture.models })))
      try {
        const response = await createApp(context).request('/api/models/running')
        const body = (await response.json()) as {
          observedAt: string
          models: Array<{
            digest: string
            sizeVramBytes: number | null
            contextLength: number | null
            gpuPercent: number | null
            processorLabel: string | null
            source: string
            observedAt: string
          }>
        }
        assert.equal(response.status, 200)
        assert.equal(body.models.length, fixture.expectedCount)
        assert.match(body.observedAt, /^\d{4}-\d{2}-\d{2}T/)
        if (body.models[0]) {
          assert.equal(body.models[0].digest, 'sha256:fixture')
          assert.equal(body.models[0].sizeVramBytes, 750)
          assert.equal(body.models[0].contextLength, 8_192)
          assert.equal(body.models[0].gpuPercent, null)
          assert.equal(body.models[0].processorLabel, null)
          assert.equal(body.models[0].source, 'ollama_api_ps')
          assert.equal(body.models[0].observedAt, body.observedAt)
        }
      } finally {
        context.db.close()
      }
    }
  })

  it('does not collapse unavailable or malformed /api/ps into an empty sample', async () => {
    const fixtures = [
      {
        client: clientWith(async () => {
          throw new TypeError('fixture unavailable')
        }),
        status: 503,
        code: 'ollama_unavailable',
      },
      {
        client: clientWith(async () => json({ models: 'not-an-array' })),
        status: 502,
        code: 'runtime_protocol',
      },
    ]

    for (const fixture of fixtures) {
      const context = testContext(fixture.client)
      try {
        const response = await createApp(context).request('/api/models/running')
        const body = (await response.json()) as { code: string }
        assert.equal(response.status, fixture.status)
        assert.equal(body.code, fixture.code)
      } finally {
        context.db.close()
      }
    }
  })
})
