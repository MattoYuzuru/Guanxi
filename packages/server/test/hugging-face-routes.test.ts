import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  ROUTES,
  huggingFaceRepositoryResponse,
  huggingFaceSearchResponse,
  huggingFaceSelectionResponse,
  type HardwareInfo,
  type HuggingFaceRepositoryResult,
  type HuggingFaceSearchResult,
  huggingFaceDownloadStreamEventSchema,
  huggingFaceImportStreamEventSchema,
} from '@alamo/contract'
import type { AppContext } from '../src/context.ts'
import { modelsRoutes } from '../src/http/models-routes.ts'
import { HuggingFaceTransport } from '../src/models/hugging-face-transport.ts'

const OBSERVED_AT = '2026-08-07T12:00:00.000Z'
const HARDWARE: HardwareInfo = {
  platform: 'darwin', arch: 'arm64', cpuModel: 'fixture', cpuCores: 8,
  totalMemoryBytes: 32_000_000_000, usableMemoryBytes: 24_000_000_000,
  accelerator: 'metal', acceleratorName: 'fixture', unifiedMemory: true,
  freeDiskBytes: null,
}

type SearchInput = Parameters<HuggingFaceTransport['search']>[0]
type RepositoryInput = Parameters<HuggingFaceTransport['repository']>[0]

function listedPage(): HuggingFaceSearchResult {
  return {
    state: 'listed',
    version: 1,
    page: 1,
    pageSize: 10,
    source: {
      state: 'available',
      source: 'hugging_face_public_api',
      observedAt: OBSERVED_AT,
      reason: null,
    },
    droppedRows: 0,
    nextCursor: null,
    reason: null,
    repositories: [{
      version: 1,
      provider: 'hugging_face',
      identity: {
        provider: 'hugging_face',
        owner: 'TheBloke',
        name: 'Llama-2-7B-GGUF',
        repositoryId: 'TheBloke/Llama-2-7B-GGUF',
        comparisonKey: 'thebloke/llama-2-7b-gguf',
      },
      metadata: 'resolved',
      observedAt: OBSERVED_AT,
      revision: {
        state: 'exact_commit',
        commit: 'a'.repeat(40),
        source: 'hugging_face_api_model',
      },
      gated: { state: 'open', mode: null },
      license: {
        state: 'declared',
        value: 'apache-2.0',
        source: 'hugging_face_model_tags',
        confidence: 'declared',
      },
      files: {
        state: 'listed',
        source: 'hugging_face_api_model',
        totalFiles: 2,
        malformedEntries: 0,
        truncated: false,
        ggufFiles: [{
          path: 'llama-2-7b.Q4_K_M.gguf',
          sizeBytes: 4_000,
          sizeSource: 'hugging_face_api_model',
        }],
      },
      verdict: {
        state: 'supported',
        scope: 'exact_gguf_file_only',
        basis: 'exact_gguf_files_listed',
        reason: null,
        requiresExactFileSelection: true,
      },
    }],
  }
}

function resolvedRepository(): HuggingFaceRepositoryResult {
  const page = listedPage()
  assert.equal(page.state, 'listed')
  return {
    state: 'resolved',
    version: 1,
    preview: {
      inputKind: 'repository_id',
      displayValue: 'TheBloke/Llama-2-7B-GGUF',
      identity: page.repositories[0]!.identity,
    },
    repository: page.repositories[0]!,
    source: page.source,
    reason: null,
  }
}

interface Calls {
  search: SearchInput[]
  repository: RepositoryInput[]
  download: unknown[]
  import: unknown[]
  forbidden: string[]
}

function appWith(handlers: {
  search?: (input: SearchInput) => Promise<HuggingFaceSearchResult>
  repository?: (input: RepositoryInput) => Promise<HuggingFaceRepositoryResult>
} = {}): { app: Hono; calls: Calls } {
  const calls: Calls = { search: [], repository: [], download: [], import: [], forbidden: [] }
  const forbid = (label: string) => (...args: unknown[]) => {
    calls.forbidden.push(label)
    void args
    throw new Error(`${label} must not be reached by read-only discovery`)
  }

  const app = new Hono()
  app.route('/api/models', modelsRoutes({
    huggingFace: {
      search: async (input: SearchInput) => {
        calls.search.push(input)
        return (handlers.search ?? (async () => listedPage()))(input)
      },
      repository: async (input: RepositoryInput) => {
        calls.repository.push(input)
        return (handlers.repository ?? (async () => resolvedRepository()))(input)
      },
    },
    huggingFaceDownloads: {
      download: async function* (selection: unknown) {
        calls.download.push(selection)
        yield {
          type: 'state', seq: 0,
          data: { version: 1, state: 'preparing' },
        }
        yield {
          type: 'refused', seq: 1,
          data: { version: 1, state: 'refused', reason: 'redirect_not_allowed' },
        }
      },
    },
    huggingFaceImports: {
      import: async function* (request: unknown) {
        calls.import.push(request)
        yield {
          type: 'cancelled', seq: 0,
          data: { version: 1, state: 'cancelled', reason: 'request_cancelled' },
        }
      },
    },
    hardware: HARDWARE,
    hardwareObservedAt: OBSERVED_AT,
    // Every neighbouring capability is wired to fail loudly if discovery touches it.
    models: () => ({
      detail: forbid('models.detail'),
      listLocal: forbid('models.listLocal'),
    }),
    ollama: () => ({
      deleteModel: forbid('ollama.deleteModel'),
      tags: forbid('ollama.tags'),
      pull: forbid('ollama.pull'),
      show: forbid('ollama.show'),
    }),
    runtime: { runningModels: forbid('runtime.runningModels') },
    governor: { admit: forbid('governor.admit') },
    completionProbe: { execute: forbid('completionProbe.execute') },
    capabilityOverrides: {
      apply: forbid('capabilityOverrides.apply'),
      clear: forbid('capabilityOverrides.clear'),
    },
    jobService: { create: forbid('jobService.create') },
  } as unknown as AppContext))
  return { app, calls }
}

function post(path: string, body: unknown, signal?: AbortSignal): Request {
  return new Request(`http://local.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  })
}

const SEARCH_PATH = ROUTES.huggingFaceSearch()
const REPOSITORY_PATH = ROUTES.huggingFaceRepository()
const SELECTION_PATH = ROUTES.huggingFaceSelection()
const DOWNLOAD_PATH = ROUTES.huggingFaceDownload()
const IMPORT_PATH = ROUTES.huggingFaceImport()

describe('Hugging Face discovery routes', () => {
  it('registers exactly the contract paths', () => {
    assert.equal(SELECTION_PATH, '/api/models/discovery/hugging-face/selection')
    assert.equal(SEARCH_PATH, '/api/models/discovery/hugging-face/search')
    assert.equal(REPOSITORY_PATH, '/api/models/discovery/hugging-face/repository')
    assert.equal(DOWNLOAD_PATH, '/api/models/discovery/hugging-face/download')
    assert.equal(IMPORT_PATH, '/api/models/imports/hugging-face-gguf/start')
  })

  it('accepts only artifact UUID/target/context and normalizes the target before import', async () => {
    const artifactId = '11111111-1111-4111-8111-111111111111'
    const { app, calls } = appWith()
    const response = await app.fetch(post(IMPORT_PATH, {
      artifactId, targetModelName: 'Owner/Model', contextLength: 8_192,
    }))
    assert.equal(response.status, 200)
    const text = await response.text()
    const payload = JSON.parse(text.match(/^data: (.+)$/mu)?.[1] ?? 'null')
    assert.deepEqual(huggingFaceImportStreamEventSchema.parse(payload), payload)
    assert.deepEqual(calls.import, [{
      artifactId, targetModelName: 'owner/model:latest', contextLength: 8_192,
    }])

    for (const body of [
      { artifactId, targetModelName: '/tmp/model.gguf', contextLength: 8_192 },
      { artifactId, targetModelName: 'model:latest', contextLength: 8_192, path: '/tmp/x' },
      { artifactId, targetModelName: 'model:latest', contextLength: 8_192, modelfile: 'FROM /tmp/x' },
      { artifactId: 'not-a-uuid', targetModelName: 'model:latest', contextLength: 8_192 },
      { artifactId, targetModelName: 'model:latest', contextLength: 0 },
    ]) {
      const candidate = appWith()
      const refused = await candidate.app.fetch(post(IMPORT_PATH, body))
      assert.equal(refused.status, 400, JSON.stringify(body))
      assert.equal(candidate.calls.import.length, 0, JSON.stringify(body))
    }
  })

  it('serves one bounded search and returns a contract-valid page', async () => {
    const { app, calls } = appWith()
    const response = await app.fetch(post(SEARCH_PATH, { query: 'llama gguf' }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(huggingFaceSearchResponse.parse(body), body)
    assert.equal(calls.search.length, 1)
    assert.equal(calls.search[0]?.query, 'llama gguf')
    // Contract defaults must be applied by the boundary, not guessed downstream.
    assert.equal(calls.search[0]?.page, 1)
    assert.equal(calls.search[0]?.pageSize, 10)
    assert.equal(calls.search[0]?.cursor, null)
    assert.deepEqual(calls.forbidden, [])
  })

  it('is not shadowed by, and does not shadow, the greedy model-name routes', async () => {
    const { app, calls } = appWith()
    const response = await app.fetch(post(SEARCH_PATH, { query: 'x' }))
    assert.equal(response.status, 200)
    assert.equal(calls.search.length, 1)
    assert.deepEqual(calls.forbidden, [], 'no model route may observe this request')

    // The converse direction is the one that could actually regress: a discovery
    // pattern must not swallow a model whose name begins with `discovery/`.
    const { app: second, calls: modelCalls } = appWith()
    const stop = await second.fetch(
      post('/api/models/discovery%2Ffake%3Alatest/stop', {}),
    )
    // The greedy stop route owns this path, so the forbidden stub records the attempt.
    assert.equal(modelCalls.search.length, 0)
    assert.equal(modelCalls.repository.length, 0)
    assert.equal(stop.status >= 400, true)
  })

  it('fails closed on a malformed, oversized or out-of-bounds search body', async () => {
    const rejected: unknown[] = [
      null,
      'not json at all',
      {},
      { query: '' },
      { query: '   ' },
      { query: 'x', page: 0 },
      { query: 'x', page: 6, cursor: 'c' },
      { query: 'x', page: 1.5, cursor: 'c' },
      { query: 'x', pageSize: 0 },
      { query: 'x', pageSize: 26 },
      // page/cursor must agree: a page-3 request without a cursor is ambiguous.
      { query: 'x', page: 3 },
      { query: 'x', cursor: 'c' },
      { query: 'x', extra: true },
      { query: 'x'.repeat(129) },
      { query: 'x\u0000y' },
      { query: ['x'] },
      { query: 1 },
    ]
    for (const body of rejected) {
      const { app, calls } = appWith()
      const response = await app.fetch(post(SEARCH_PATH, body))
      assert.equal(response.status, 400, JSON.stringify(body))
      const payload = await response.json() as Record<string, unknown>
      assert.equal(payload['code'], 'validation_failed', JSON.stringify(body))
      // A refused request never reaches the outbound Hub boundary.
      assert.equal(calls.search.length, 0, JSON.stringify(body))
      assert.deepEqual(calls.forbidden, [])
    }
  })

  it('publishes a transport failure as a typed state without leaking the provider', async () => {
    const { app } = appWith({
      search: async () => ({
        state: 'failed',
        version: 1,
        page: 1,
        pageSize: 10,
        source: {
          state: 'unavailable',
          source: 'hugging_face_public_api',
          observedAt: OBSERVED_AT,
          reason: 'rate_limited',
        },
        droppedRows: 0,
        repositories: [],
        nextCursor: null,
        reason: 'rate_limited',
      }),
    })
    const response = await app.fetch(post(SEARCH_PATH, { query: 'x' }))
    // A provider failure is a successful read of a failed state, not a 5xx.
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(huggingFaceSearchResponse.parse(body), body)
    const text = JSON.stringify(body)
    assert.equal(text.includes('huggingface.co'), false)
    assert.equal(text.includes('authorization'), false)
    assert.equal(text.includes('/api/models?'), false)
  })

  it('resolves one repository through the strict identity parser', async () => {
    const { app, calls } = appWith()
    const response = await app.fetch(
      post(REPOSITORY_PATH, { reference: 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF' }),
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(huggingFaceRepositoryResponse.parse(body), body)
    assert.equal(calls.repository.length, 1)
    const preview = calls.repository[0]?.preview
    assert.equal(preview?.inputKind, 'model_page_url')
    assert.equal(preview?.identity.repositoryId, 'TheBloke/Llama-2-7B-GGUF')
    assert.deepEqual(calls.forbidden, [])
  })

  it('refuses an invalid reference before any outbound read', async () => {
    const cases: Array<[unknown, string]> = [
      [{ reference: 'https://evil.test/a/b' }, 'invalid_model_page_url'],
      [{ reference: 'https://huggingface.co:443/a/b' }, 'invalid_model_page_url'],
      [{ reference: ' owner/model' }, 'ambiguous_input'],
      [{ reference: 'owner' }, 'invalid_repository_id'],
      [{ reference: 'owner/model/extra' }, 'invalid_repository_id'],
      [{ reference: 'datasets/squad' }, 'invalid_repository_id'],
      [{ reference: '' }, 'invalid_request'],
      [{}, 'invalid_request'],
      [{ reference: 'owner/model', extra: 1 }, 'invalid_request'],
    ]
    for (const [body, reason] of cases) {
      const { app, calls } = appWith()
      const response = await app.fetch(post(REPOSITORY_PATH, body))
      assert.equal(response.status, 400, JSON.stringify(body))
      const payload = await response.json() as { details?: { reason?: string } }
      assert.equal(payload.details?.reason, reason, JSON.stringify(body))
      assert.equal(calls.repository.length, 0, JSON.stringify(body))
      assert.deepEqual(calls.forbidden, [])
    }
  })

  it('reports a caller disconnect as a cancellation, not a provider verdict', async () => {
    const controller = new AbortController()
    const { app } = appWith({
      search: async () => {
        controller.abort('client-disconnected')
        throw new DOMException('Aborted', 'AbortError')
      },
    })
    const response = await app.fetch(
      post(SEARCH_PATH, { query: 'x' }, controller.signal),
    )
    assert.equal(response.status, 409)
    const payload = await response.json() as { details?: { reason?: string } }
    assert.equal(payload.details?.reason, 'request_cancelled')
  })

  it('reports an unexpected transport throw as a redacted internal error', async () => {
    const secret = 'SECRET https://internal.example/hub'
    for (const path of [SEARCH_PATH, REPOSITORY_PATH]) {
      const { app } = appWith({
        search: async () => { throw new Error(secret) },
        repository: async () => { throw new Error(secret) },
      })
      const body = path === SEARCH_PATH
        ? { query: 'x' }
        : { reference: 'owner/model' }
      const response = await app.fetch(post(path, body))
      assert.equal(response.status, 500, path)
      const payload = await response.json() as Record<string, unknown>
      assert.equal(payload['code'], 'internal_error', path)
      const text = JSON.stringify(payload)
      assert.equal(text.includes('SECRET'), false, path)
      assert.equal(text.includes('internal.example'), false, path)
    }
  })

  it('accepts a bounded later page only together with its opaque cursor', async () => {
    const { app, calls } = appWith({
      search: async (input) => ({ ...listedPage(), page: input.page, pageSize: input.pageSize }),
    })
    const response = await app.fetch(post(SEARCH_PATH, {
      query: 'x', page: 3, pageSize: 25, cursor: 'OPAQUE==value',
    }))
    assert.equal(response.status, 200)
    assert.equal(calls.search[0]?.page, 3)
    assert.equal(calls.search[0]?.pageSize, 25)
    assert.equal(calls.search[0]?.cursor, 'OPAQUE==value')
  })

  it('starts no pull, probe, prewarm, load, unload, catalog or Job work', async () => {
    const { app, calls } = appWith()
    await app.fetch(post(SEARCH_PATH, { query: 'x' }))
    await app.fetch(post(REPOSITORY_PATH, { reference: 'owner/model' }))
    // Every neighbouring capability was wired to record a call and throw.
    assert.deepEqual(calls.forbidden, [])
    assert.equal(calls.search.length, 1)
    assert.equal(calls.repository.length, 1)
  })

  describe('P2-K exact GGUF file/revision selection', () => {
    const validBody = () => ({
      identity: {
        provider: 'hugging_face',
        owner: 'TheBloke',
        name: 'Llama-2-7B-GGUF',
        repositoryId: 'TheBloke/Llama-2-7B-GGUF',
        comparisonKey: 'thebloke/llama-2-7b-gguf',
      },
      revision: {
        state: 'exact_commit',
        commit: 'a'.repeat(40),
        source: 'hugging_face_api_model',
      },
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })

    it('confirms an exact selection through the same bounded repository re-read as the repository route', async () => {
      const { app, calls } = appWith()
      const response = await app.fetch(post(SELECTION_PATH, validBody()))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(huggingFaceSelectionResponse.parse(body), body)
      assert.equal((body as { result: { state: string } }).result.state, 'confirmed')
      // Selection reuses the same repository() boundary as the repository route: no
      // second outbound Hub read path exists.
      assert.equal(calls.repository.length, 1)
      assert.deepEqual(calls.repository[0]?.revision, validBody().revision)
      assert.equal(calls.search.length, 0)
      assert.deepEqual(calls.forbidden, [])
    })

    it('fails closed on a malformed, oversized or out-of-bounds selection body', async () => {
      const rejected: unknown[] = [
        null,
        'not json',
        {},
        { ...validBody(), identity: { ...validBody().identity, repositoryId: '' } },
        { ...validBody(), revision: { ...validBody().revision, commit: 'short' } },
        {
          ...validBody(),
          revision: { ...validBody().revision, commit: 'A'.repeat(40) },
        }, // uppercase hex is not accepted
        { ...validBody(), revision: { state: 'branch', name: 'main' } },
        {
          ...validBody(),
          revision: { state: 'unknown', commit: null, source: 'not_reported' },
        },
        { ...validBody(), filePath: '' },
        { ...validBody(), filePath: '/etc/passwd.gguf' },
        { ...validBody(), filePath: '../secret.gguf' },
        { ...validBody(), filePath: '%2e%2e/secret.gguf' },
        { ...validBody(), filePath: 'dir%2fmodel.gguf' },
        { ...validBody(), filePath: 'model?download.gguf' },
        { ...validBody(), filePath: 'model.bin' }, // no .gguf suffix
        { ...validBody(), filePath: `${'a'.repeat(1020)}.gguf` },
        { ...validBody(), filePath: 'model\u0000.gguf' },
        { ...validBody(), contextLength: 0 },
        { ...validBody(), contextLength: -1 },
        { ...validBody(), extra: true },
      ]
      for (const body of rejected) {
        const { app, calls } = appWith()
        const response = await app.fetch(post(SELECTION_PATH, body))
        assert.equal(response.status, 400, JSON.stringify(body))
        const payload = await response.json() as Record<string, unknown>
        assert.equal(payload['code'], 'validation_failed', JSON.stringify(body))
        assert.equal(calls.repository.length, 0, JSON.stringify(body))
        assert.deepEqual(calls.forbidden, [])
      }
    })

    it('refuses a repository the fresh re-read shows as unsupported', async () => {
      const { app } = appWith({
        repository: async (input) => {
          const page = listedPage()
          assert.equal(page.state, 'listed')
          const repository = {
            ...page.repositories[0]!,
            files: {
              state: 'listed' as const, source: 'hugging_face_api_model' as const,
              totalFiles: 1, malformedEntries: 0, truncated: false, ggufFiles: [],
            },
            verdict: {
              state: 'unsupported' as const, scope: 'exact_gguf_file_only' as const,
              basis: 'complete_listing_without_gguf' as const, reason: null,
              requiresExactFileSelection: true as const,
            },
          }
          return {
            state: 'resolved' as const, version: 1, preview: input.preview,
            repository, source: page.source, reason: null,
          }
        },
      })
      const response = await app.fetch(post(SELECTION_PATH, validBody()))
      assert.equal(response.status, 200)
      const body = await response.json() as { result: { state: string; reason: string } }
      assert.equal(body.result.state, 'refused')
      assert.equal(body.result.reason, 'repository_not_supported')
    })

    it('refuses when the fresh revision no longer matches the requested commit', async () => {
      const { app } = appWith()
      const response = await app.fetch(post(SELECTION_PATH, {
        ...validBody(),
        revision: { ...validBody().revision, commit: 'b'.repeat(40) },
      }))
      const body = await response.json() as { result: { state: string; reason: string } }
      assert.equal(body.result.state, 'refused')
      assert.equal(body.result.reason, 'revision_mismatch')
    })

    it('refuses a file path absent from the fresh inventory', async () => {
      const { app } = appWith()
      const response = await app.fetch(post(SELECTION_PATH, {
        ...validBody(), filePath: 'never-listed.gguf',
      }))
      const body = await response.json() as { result: { state: string; reason: string } }
      assert.equal(body.result.state, 'refused')
      assert.equal(body.result.reason, 'file_not_in_current_inventory')
    })

    it('reports a caller disconnect as a cancellation, not a provider verdict', async () => {
      const controller = new AbortController()
      let receivedSignal: AbortSignal | undefined
      const { app } = appWith({
        repository: async (input) => {
          receivedSignal = input.signal
          if (!receivedSignal) throw new Error('selection did not forward the caller signal')
          if (receivedSignal.aborted) throw new DOMException('Aborted', 'AbortError')
          return new Promise((_resolve, reject) => {
            receivedSignal!.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
          })
        },
      })
      const pending = app.fetch(post(SELECTION_PATH, validBody(), controller.signal))
      await Promise.resolve()
      controller.abort('client-disconnected')
      const response = await pending
      assert.equal(receivedSignal?.aborted, true)
      assert.equal(response.status, 409)
      const payload = await response.json() as { details?: { reason?: string } }
      assert.equal(payload.details?.reason, 'request_cancelled')
    })

    it('reports an unexpected transport throw as a redacted internal error', async () => {
      const secret = 'SECRET https://internal.example/hub'
      const { app } = appWith({ repository: async () => { throw new Error(secret) } })
      const response = await app.fetch(post(SELECTION_PATH, validBody()))
      assert.equal(response.status, 500)
      const payload = await response.json() as Record<string, unknown>
      assert.equal(payload['code'], 'internal_error')
      const text = JSON.stringify(payload)
      assert.equal(text.includes('SECRET'), false)
      assert.equal(text.includes('internal.example'), false)
    })

    it('starts no pull, probe, prewarm, load, unload, create, catalog or Job work', async () => {
      const { app, calls } = appWith()
      await app.fetch(post(SELECTION_PATH, validBody()))
      assert.deepEqual(calls.forbidden, [])
    })
  })

  describe('P2-L exact GGUF download route', () => {
    const validBody = () => ({
      identity: {
        provider: 'hugging_face', owner: 'TheBloke', name: 'Llama-2-7B-GGUF',
        repositoryId: 'TheBloke/Llama-2-7B-GGUF',
        comparisonKey: 'thebloke/llama-2-7b-gguf',
      },
      revision: {
        state: 'exact_commit', commit: 'a'.repeat(40),
        source: 'hugging_face_api_model',
      },
      filePath: 'llama-2-7b.Q4_K_M.gguf',
      contextLength: 8_192,
    })

    const events = async (response: Response) => (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => huggingFaceDownloadStreamEventSchema.parse(JSON.parse(line.slice(6))))

    it('revalidates the exact target, starts one writer and exposes only typed SSE', async () => {
      const { app, calls } = appWith()
      const response = await app.fetch(post(DOWNLOAD_PATH, validBody()))
      assert.equal(response.status, 200)
      const streamed = await events(response)
      assert.deepEqual(streamed.map((event) => event.type), ['state', 'refused'])
      assert.equal(calls.repository.length, 1)
      assert.deepEqual(calls.repository[0]?.revision, validBody().revision)
      assert.equal(calls.download.length, 1)
      assert.equal(calls.search.length, 0)
      assert.deepEqual(calls.forbidden, [])
    })

    it('rejects malformed or traversal-shaped targets before metadata, file or network work', async () => {
      for (const body of [
        null,
        { ...validBody(), filePath: '../secret.gguf' },
        { ...validBody(), revision: { ...validBody().revision, commit: 'main' } },
        { ...validBody(), extra: true },
      ]) {
        const { app, calls } = appWith()
        const response = await app.fetch(post(DOWNLOAD_PATH, body))
        assert.equal(response.status, 400)
        assert.equal(calls.repository.length, 0)
        assert.equal(calls.download.length, 0)
        assert.deepEqual(calls.forbidden, [])
      }
    })

    it('refuses stale selection evidence without creating a staging writer', async () => {
      const { app, calls } = appWith({
        repository: async (input) => {
          const page = listedPage()
          assert.equal(page.state, 'listed')
          const repository = {
            ...page.repositories[0]!,
            files: {
              state: 'listed' as const, source: 'hugging_face_api_model' as const,
              totalFiles: 0, malformedEntries: 0, truncated: false, ggufFiles: [],
            },
            verdict: {
              state: 'unsupported' as const, scope: 'exact_gguf_file_only' as const,
              basis: 'complete_listing_without_gguf' as const, reason: null,
              requiresExactFileSelection: true as const,
            },
          }
          return {
            state: 'resolved' as const, version: 1, preview: input.preview,
            repository, source: page.source, reason: null,
          }
        },
      })
      const response = await app.fetch(post(DOWNLOAD_PATH, validBody()))
      const streamed = await events(response)
      assert.equal(streamed.length, 1)
      assert.equal(streamed[0]?.type, 'refused')
      if (streamed[0]?.type === 'refused') {
        assert.equal(streamed[0].data.reason, 'selection_stale')
      }
      assert.equal(calls.download.length, 0)
      assert.deepEqual(calls.forbidden, [])
    })

    it('cancels during the metadata re-read before creating a staging writer', async () => {
      const controller = new AbortController()
      let metadataSignal: AbortSignal | undefined
      const { app, calls } = appWith({
        repository: async (input) => {
          metadataSignal = input.signal
          return new Promise((_resolve, reject) => {
            metadataSignal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'))
            }, { once: true })
          })
        },
      })
      const response = await app.fetch(post(DOWNLOAD_PATH, validBody(), controller.signal))
      const reading = events(response)
      await Promise.resolve()
      controller.abort('client-disconnected')
      const streamed = await reading
      assert.equal(metadataSignal?.aborted, true)
      assert.equal(streamed.length, 1)
      assert.equal(streamed[0]?.type, 'cancelled')
      assert.equal(calls.download.length, 0)
      assert.deepEqual(calls.forbidden, [])
    })
  })
})
