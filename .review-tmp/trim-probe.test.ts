import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { HardwareInfo } from '@alamo/contract'
import { openDb } from '../packages/server/src/store/db.ts'
import { ModelCapabilityOverrideStore } from '../packages/server/src/store/capability-override.ts'
import { ModelCapabilityOverrideService } from '../packages/server/src/models/capability-override.ts'
import { ModelService } from '../packages/server/src/models/service.ts'
import { CalibrationStore } from '../packages/server/src/store/calibration.ts'

const DIGEST = 'sha256:fixture'
const RUNTIME = '0.12.6'
const HARDWARE: HardwareInfo = {
  platform: 'darwin', arch: 'arm64', cpuModel: 'f', cpuCores: 8,
  totalMemoryBytes: 16e9, usableMemoryBytes: 12e9, accelerator: 'metal',
  acceleratorName: 'F', unifiedMemory: true, freeDiskBytes: null,
}
const entry = (p: any = {}) => ({
  name: 'fixture:latest', digest: DIGEST, size: 4000, modified_at: '2026-08-07T00:00:00.000Z',
  details: { family: 'f', parameter_size: '1B', quantization_level: 'Q4' },
  capabilities: ['completion'], ...p,
})
async function db() {
  const root = await mkdtemp(join(tmpdir(), 'alamo-trim-'))
  return openDb(join(root, 'alamo.db'))
}

describe('trim asymmetry + N+1', () => {
  it('T1: /api/version returns padded value -> mutation writes trimmed, descriptor reads UNTRIMMED and shows nothing', async () => {
    const d = await db()
    const store = new ModelCapabilityOverrideStore(d)
    const padded = `  ${RUNTIME}\n`
    const client: any = {
      host: 'http://127.0.0.1:11434',
      tags: async () => ({ models: [entry()] }),
      version: async () => padded,
      show: async () => ({ capabilities: ['completion'] }),
      ps: async () => ({ models: [] }),
    }
    const models = new ModelService(client, new CalibrationStore(d), HARDWARE, undefined, undefined, store)
    const service = new ModelCapabilityOverrideService({ models: () => models as any, store })
    const out: any = await service.apply('fixture:latest',
      { capability: 'tools', expectedDigest: DIGEST, expectedRuntimeVersion: RUNTIME },
      new AbortController().signal)
    console.log('T1 mutation state =', out.state, 'stored runtimeVersion =', JSON.stringify(out.identity?.runtimeVersion))
    console.log('T1 rows =', (d.prepare('SELECT COUNT(*) AS c FROM model_capability_user_overrides').get() as any).c)
    const listed = await models.listLocal(8192)
    console.log('T1 descriptor.overrides =', listed[0]!.descriptor.overrides.length,
      ' descriptor.runtime.version =', JSON.stringify(listed[0]!.descriptor.runtime.version))
    console.log('T1 => user asserted successfully but the assertion is INVISIBLE in the descriptor')
    d.close()
  })

  it('T2: descriptor.runtime is a NEW required-after-default field: does it parse for the recorded legacy shape?', async () => {
    const { installedModelDescriptorSchema } = await import('@alamo/contract')
    const legacyShape = {
      reference: { state: 'canonical', provider: 'ollama', original: 'a:latest', normalized: 'a:latest' },
      artifact: { state: 'exact_digest', digest: 'sha256:x' },
      installation: { state: 'installed', source: 'ollama_api_tags', observedAt: '2026-01-01T00:00:00.000Z', confidence: 'observed' },
      capabilities: { state: 'declared', reason: null, observedAt: '2026-01-01T00:00:00.000Z', declarations: [] },
      freshness: { state: 'fresh', source: 'provider', observedAt: '2026-01-01T00:00:00.000Z', ageMs: 0, offline: false },
    }
    const parsed = installedModelDescriptorSchema.safeParse(legacyShape)
    console.log('T2 legacy parses =', parsed.success, parsed.success ? JSON.stringify(parsed.data.runtime) : parsed.error.message.slice(0, 200))
  })

  it('T3: N+1 SQLite reads in listLocal', async () => {
    const d = await db()
    const store = new ModelCapabilityOverrideStore(d)
    let listCalls = 0
    const spy = { list: (i: any) => { listCalls += 1; return store.list(i) } } as any
    const N = 120
    const entries = Array.from({ length: N }, (_, i) => entry({ name: `m${i}:latest`, digest: `sha256:d${i}` }))
    const client: any = {
      host: 'http://127.0.0.1:11434',
      tags: async () => ({ models: entries }),
      version: async () => RUNTIME,
      show: async () => ({ capabilities: ['completion'] }),
      ps: async () => ({ models: [] }),
    }
    const models = new ModelService(client, new CalibrationStore(d), HARDWARE, undefined, undefined, spy)
    const t0 = performance.now()
    const listed = await models.listLocal(8192)
    console.log('T3 models =', listed.length, 'store.list calls =', listCalls, 'ms =', Math.round(performance.now() - t0))
    d.close()
  })
})
