import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import {
  localModelSchema,
  type HardwareInfo,
  type LocalModel,
} from '@guanxi/contract'
import {
  ModelService,
  MODEL_SHOW_MAX_CONCURRENCY,
} from '../src/models/service.ts'
import { OllamaClient } from '../src/ollama/client.ts'
import { CalibrationStore } from '../src/store/calibration.ts'
import { openDb } from '../src/store/db.ts'

const OBSERVED_AT = '2026-08-03T00:00:00.000Z'
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

interface InstalledFixture {
  name: string
  digest: string
  tagsCapabilities?: unknown
  showCapabilities?: unknown
  showStatus?: number
}

interface ProviderFixture {
  installed: InstalledFixture[]
  versionStatus?: number
  showCalls: Array<{ name: string; signal: AbortSignal | null }>
  activeShows: number
  maxActiveShows: number
  holdShows?: Promise<void>
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function client(fixture: ProviderFixture): OllamaClient {
  return new OllamaClient({
    host: 'http://127.0.0.1:11434',
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/version') {
        return fixture.versionStatus === undefined
          ? json({ version: '0.12.6' })
          : json({ error: 'redacted' }, fixture.versionStatus)
      }
      if (path === '/api/tags') {
        return json({
          models: fixture.installed.map((model) => ({
            name: model.name,
            model: model.name,
            modified_at: OBSERVED_AT,
            size: 4_000,
            digest: model.digest,
            details: {
              family: 'fixture',
              parameter_size: '1B',
              quantization_level: 'Q4',
              context_length: 32_768,
            },
            ...(model.tagsCapabilities === undefined
              ? {}
              : { capabilities: model.tagsCapabilities }),
          })),
        })
      }
      if (path === '/api/ps') return json({ models: [] })
      if (path === '/api/show') {
        const body = JSON.parse(String(init?.body)) as { model: string }
        const model = fixture.installed.find((entry) => entry.name === body.model)!
        fixture.showCalls.push({ name: body.model, signal: init?.signal ?? null })
        fixture.activeShows += 1
        fixture.maxActiveShows = Math.max(fixture.maxActiveShows, fixture.activeShows)
        try {
          await fixture.holdShows
        } finally {
          fixture.activeShows -= 1
        }
        if (model.showStatus !== undefined) {
          return json({ error: 'secret /Users/private raw prompt' }, model.showStatus)
        }
        return json({
          model_info: { 'general.architecture': 'fixture' },
          ...(model.showCapabilities === undefined
            ? {}
            : { capabilities: model.showCapabilities }),
        })
      }
      throw new Error(`unexpected ${path}`)
    },
  })
}

function fixture(installed: InstalledFixture[]): ProviderFixture {
  return {
    installed,
    showCalls: [],
    activeShows: 0,
    maxActiveShows: 0,
  }
}

async function service(test: TestContext, input: ProviderFixture) {
  const root = await mkdtemp(join(tmpdir(), 'guanxi-model-descriptor-'))
  test.after(() => rm(root, { recursive: true, force: true }))
  const db = openDb(join(root, 'guanxi.db'))
  test.after(() => db.close())
  return new ModelService(client(input), new CalibrationStore(db), HARDWARE)
}

function legacyModel(): Omit<LocalModel, 'descriptor'> {
  return {
    name: 'legacy:latest',
    digest: 'sha256:legacy',
    sizeBytes: 4_000,
    modifiedAt: OBSERVED_AT,
    family: 'fixture',
    parameterSize: '1B',
    quantization: 'Q4',
    contextLength: 8_192,
    contextLimit: {
      state: 'unknown',
      value: null,
      source: 'not_reported',
      observedAt: OBSERVED_AT,
      confidence: 'unknown',
    },
    capabilities: ['completion'],
    isCloud: false,
    fit: {
      level: 'green',
      summary: 'fixture',
      contextLength: 8_192,
      modelBytes: 4_000,
      kvCacheBytes: 0,
      requiredBytes: 4_000,
      usableBytes: 12_000_000_000,
      utilization: 0.1,
      basis: 'estimate',
      measured: null,
    },
  }
}

describe('installed model descriptor and capability evidence', () => {
  it('parses legacy model responses with explicit additive unknown defaults', () => {
    const parsed = localModelSchema.parse(legacyModel())
    assert.equal(parsed.descriptor.reference.state, 'unknown')
    assert.equal(parsed.descriptor.artifact.state, 'unknown')
    assert.equal(parsed.descriptor.installation.state, 'unknown')
    assert.deepEqual(parsed.descriptor.capabilities, {
      state: 'unknown',
      reason: 'legacy_response',
      observedAt: '1970-01-01T00:00:00.000Z',
      declarations: [],
    })
    assert.deepEqual(parsed.descriptor.freshness, {
      state: 'unknown', source: 'none', observedAt: null,
      reason: 'legacy_response', offline: false,
    })
  })

  it('projects canonical provider/reference, exact digest, installation and matching declarations', async (test) => {
    const provider = fixture([{
      name: 'Registry.Example/Team/Model:Q4',
      digest: 'sha256:artifact-a',
      tagsCapabilities: ['completion', 'tools'],
      showCapabilities: ['tools', 'completion'],
    }])
    const models = await (await service(test, provider)).listLocal(8_192)
    const descriptor = models[0]!.descriptor
    assert.deepEqual(descriptor.reference, {
      state: 'canonical',
      provider: 'ollama',
      original: 'Registry.Example/Team/Model:Q4',
      normalized: 'registry.example/team/model:q4',
    })
    assert.deepEqual(descriptor.artifact, {
      state: 'exact_digest',
      digest: 'sha256:artifact-a',
    })
    assert.equal(descriptor.installation.state, 'installed')
    assert.equal(descriptor.capabilities.state, 'declared')
    assert.deepEqual(
      descriptor.capabilities.declarations.map(({ source, confidence }) => ({ source, confidence })),
      [
        { source: 'ollama_api_tags', confidence: 'declared' },
        { source: 'ollama_api_show', confidence: 'declared' },
      ],
    )
    const tagsDeclaration = descriptor.capabilities.declarations.find(
      (declaration) => declaration.source === 'ollama_api_tags',
    )!
    const showDeclaration = descriptor.capabilities.declarations.find(
      (declaration) => declaration.source === 'ollama_api_show',
    )!
    assert.deepEqual(tagsDeclaration.basis.artifact, {
      state: 'exact_digest',
      digest: 'sha256:artifact-a',
    })
    assert.deepEqual(showDeclaration.basis.artifact, {
      state: 'unknown',
      digest: null,
      reason: 'detail_not_bound_to_digest',
    })
    for (const declaration of descriptor.capabilities.declarations) {
      assert.equal(declaration.basis.runtime.state, 'sourced')
    }

    const detail = await (await service(test, provider)).detail(
      'Registry.Example/Team/Model:Q4',
      8_192,
    )
    assert.ok(detail)
    assert.equal(detail.descriptor.reference.state, 'canonical')
    assert.deepEqual(detail.descriptor.artifact, descriptor.artifact)
    assert.deepEqual(
      detail.descriptor.capabilities.declarations.map((declaration) => ({
        source: declaration.source,
        artifact: declaration.basis.artifact,
      })),
      [
        {
          source: 'ollama_api_tags',
          artifact: { state: 'exact_digest', digest: 'sha256:artifact-a' },
        },
        {
          source: 'ollama_api_show',
          artifact: {
            state: 'unknown',
            digest: null,
            reason: 'detail_not_bound_to_digest',
          },
        },
      ],
    )
  })

  it('never reuses cached declaration evidence after same-name digest replacement', async (test) => {
    const provider = fixture([{
      name: 'fixture:latest',
      digest: 'sha256:a',
      tagsCapabilities: ['completion'],
      showCapabilities: ['completion'],
    }])
    const models = await service(test, provider)
    const first = await models.listLocal(8_192)
    provider.installed[0] = {
      name: 'fixture:latest',
      digest: 'sha256:b',
      tagsCapabilities: ['tools'],
      showCapabilities: ['tools'],
    }
    const second = await models.listLocal(8_192)
    assert.equal(provider.showCalls.length, 2)
    assert.equal(first[0]!.descriptor.artifact.state, 'exact_digest')
    assert.equal(second[0]!.descriptor.artifact.state, 'exact_digest')
    assert.deepEqual(
      second[0]!.descriptor.capabilities.declarations.map((entry) => entry.capabilities),
      [['tools'], ['tools']],
    )
    assert.deepEqual(
      second[0]!.descriptor.capabilities.declarations.map((entry) => entry.basis.artifact),
      [
        { state: 'exact_digest', digest: 'sha256:b' },
        { state: 'unknown', digest: null, reason: 'detail_not_bound_to_digest' },
      ],
    )
  })

  it('never assigns name-based show evidence across ambiguous exact digests', async (test) => {
    const provider = fixture([
      {
        name: 'Fixture',
        digest: 'sha256:a',
        tagsCapabilities: ['completion'],
        showCapabilities: ['tools'],
      },
      {
        name: 'fixture:latest',
        digest: 'sha256:b',
        tagsCapabilities: ['tools'],
        showCapabilities: ['completion'],
      },
    ])
    const rows = await (await service(test, provider)).listLocal(8_192)
    assert.equal(provider.showCalls.length, 0)
    assert.deepEqual(
      rows.map((row) => ({
        digest: row.digest,
        state: row.descriptor.capabilities.state,
        reason: row.descriptor.capabilities.reason,
        declarations: row.descriptor.capabilities.declarations.map(
          (declaration) => [declaration.source, declaration.capabilities],
        ),
      })),
      [
        {
          digest: 'sha256:a',
          state: 'degraded',
          reason: 'artifact_identity_ambiguous',
          declarations: [['ollama_api_tags', ['completion']]],
        },
        {
          digest: 'sha256:b',
          state: 'degraded',
          reason: 'artifact_identity_ambiguous',
          declarations: [['ollama_api_tags', ['tools']]],
        },
      ],
    )
  })

  it('preserves the original /api/show observation time on a digest-aware cache hit', async (test) => {
    const provider = fixture([{
      name: 'fixture:latest',
      digest: 'sha256:a',
      tagsCapabilities: ['completion'],
      showCapabilities: ['completion'],
    }])
    const models = await service(test, provider)
    const first = await models.listLocal(8_192)
    await new Promise((resolve) => setTimeout(resolve, 2))
    const second = await models.listLocal(8_192)
    const showTime = (model: LocalModel) => model.descriptor.capabilities.declarations
      .find((entry) => entry.source === 'ollama_api_show')!.observedAt
    assert.equal(provider.showCalls.length, 1)
    assert.equal(showTime(first[0]!), showTime(second[0]!))
    assert.notEqual(first[0]!.descriptor.installation.observedAt, second[0]!.descriptor.installation.observedAt)
  })

  it('keeps missing, malformed, conflicting and unavailable declarations visible', async (test) => {
    const provider = fixture([
      { name: 'vision-tools-thinking-embed:latest', digest: 'sha256:m' },
      {
        name: 'malformed:latest',
        digest: 'sha256:x',
        tagsCapabilities: 'completion',
        showCapabilities: { tools: true },
      },
      {
        name: 'future-value:latest',
        digest: 'sha256:f',
        tagsCapabilities: ['completion', 'future-capability'],
        showCapabilities: ['completion', 'future-capability'],
      },
      {
        name: 'conflict:latest',
        digest: 'sha256:c',
        tagsCapabilities: ['completion'],
        showCapabilities: ['tools'],
      },
      {
        name: 'unavailable:latest',
        digest: 'sha256:u',
        tagsCapabilities: ['completion'],
        showStatus: 500,
      },
    ])
    const rows = await (await service(test, provider)).listLocal(8_192)
    assert.equal(rows.length, 5)
    assert.deepEqual(rows.map((row) => [row.descriptor.capabilities.state, row.descriptor.capabilities.reason]), [
      ['unknown', 'field_not_reported'],
      ['unknown', 'provider_malformed'],
      ['unknown', 'provider_malformed'],
      ['degraded', 'conflicting_provider_declarations'],
      ['degraded', 'provider_unavailable'],
    ])
    assert.deepEqual(rows[0]!.capabilities, [])
    assert.deepEqual(rows[1]!.capabilities, [])
    assert.deepEqual(rows[2]!.capabilities, ['completion'])
    assert.deepEqual(rows[3]!.capabilities, ['completion'])
    assert.deepEqual(rows[4]!.capabilities, ['completion'])
    assert.equal(rows[2]!.descriptor.capabilities.declarations.length, 0)
    assert.doesNotMatch(JSON.stringify(rows), /secret|Users\/private|raw prompt/u)
  })

  it('keeps installed rows with unknown digest or runtime fingerprint', async (test) => {
    const provider = fixture([{
      name: 'fixture:latest',
      digest: '',
      tagsCapabilities: ['completion'],
      showCapabilities: ['completion'],
    }])
    provider.versionStatus = 500
    const rows = await (await service(test, provider)).listLocal(8_192)
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0]!.descriptor.artifact, {
      state: 'unknown',
      digest: null,
      reason: 'digest_not_reported',
    })
    assert.ok(rows[0]!.descriptor.capabilities.declarations.every(
      (entry) => entry.basis.runtime.state === 'unknown',
    ))
  })

  it('bounds installed /api/show workers while returning every descriptor', async (test) => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const provider = fixture(Array.from({ length: 9 }, (_, index) => ({
      name: `fixture-${index}:latest`,
      digest: `sha256:${index}`,
      tagsCapabilities: ['completion'],
      showCapabilities: ['completion'],
    })))
    provider.holdShows = hold
    const pending = (await service(test, provider)).listLocal(8_192)
    while (provider.showCalls.length < MODEL_SHOW_MAX_CONCURRENCY) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(provider.maxActiveShows, MODEL_SHOW_MAX_CONCURRENCY)
    release()
    const rows = await pending
    assert.equal(rows.length, 9)
    assert.ok(rows.every((row) => row.descriptor.capabilities.state === 'declared'))
  })

  it('propagates caller abort through an installed-list /api/show wait', async (test) => {
    let showStarted!: () => void
    const started = new Promise<void>((resolve) => { showStarted = resolve })
    const provider = fixture([{
      name: 'fixture:latest',
      digest: 'sha256:a',
      tagsCapabilities: ['completion'],
      showCapabilities: ['completion'],
    }])
    provider.holdShows = started.then(() => new Promise<void>(() => {}))
    const models = await service(test, provider)
    const controller = new AbortController()
    const pending = models.listLocal(8_192, controller.signal)
    while (provider.showCalls.length === 0) await new Promise((resolve) => setImmediate(resolve))
    showStarted()
    controller.abort('caller-left')
    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(provider.showCalls[0]!.signal?.aborted, true)
  })
})
